import { downloadRelease, DownloadError, type DownloadOptions } from "./download.ts";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { diagnosticIO, environment, httpURL, localAddress, serviceCommand, type DiagnosticOptions } from "./diagnostics.ts";
import { releaseShim } from "./release-shims.ts";

export class UpgradeError extends Error { readonly code = "UPGRADE_FAILED"; }
export interface UpgradeOptions extends DiagnosticOptions {
  tty?: boolean; progress?: DownloadOptions["progress"];
  arch?: string; version?: string; runtimeOnly?: boolean; releaseBase?: string;
  log?: (line: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void>;
}
const binaries = ["lumio", "lumio-hub", "lumio-runtime"] as const;
const releaseVersion = /^(?:v)?(\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?)$/;
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export function unifiedService(content: string, binary: string, role: "hub" | "runtime", platform: string): string {
  if (platform === "darwin") {
    const pattern = /<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/;
    if (!pattern.test(content)) throw new UpgradeError("已有服务文件无法识别，请先修复 setup 配置");
    return content.replace(pattern, () => `<key>ProgramArguments</key><array><string>${xml(binary)}</string><string>${role}</string><string>serve</string></array>`);
  }
  if (!/^ExecStart=.+$/m.test(content)) throw new UpgradeError("已有服务文件无法识别，请先修复 setup 配置");
  const quoted = `"${binary.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  return content.replace(/^ExecStart=.+$/m, () => `ExecStart=${quoted} ${role} serve`);
}

/** Single-program upgrade with compatibility links and a reversible replacement transaction. */
export async function upgrade(options: UpgradeOptions = {}): Promise<void> {
  const io = diagnosticIO(options), log = options.log ?? (() => {}), arch = options.arch ?? process.arch;
  const platform = io.platform === "darwin" && arch === "arm64" ? "darwin-arm64" : io.platform === "linux" && ["x64", "arm64"].includes(arch) ? `linux-${arch}` : undefined;
  if (!platform) throw new UpgradeError("不支持的平台（支持 macOS arm64、Linux x64/arm64）");
  if (options.version && !/^v\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?$/.test(options.version)) throw new UpgradeError("版本应为 vX.Y.Z");
  const base = options.releaseBase ?? io.env.LUMIO_RELEASE_BASE_URL ?? "https://github.com/wicsp/Lumio/releases"; httpURL(base);
  const download = `${base.replace(/\/+$/, "")}/${options.version ? `download/${options.version}` : "latest/download"}`;
  const archive = `lumio-${platform}.tar.gz`, bin = join(io.home, ".local/bin"), binary = join(bin, "lumio");
  const temp = await mkdtemp(join(tmpdir(), "lumio-upgrade-")), stages: string[] = [];
  const command = async (argv: string[]) => { const r = await io.run(argv); if (r.code) throw new UpgradeError("升级命令失败；请检查程序权限和后台服务日志；程序若已更新，可修复服务后重试 upgrade"); return r.stdout; };
  try {
    log(`下载 Lumio ${options.version ?? "最新版本"}（${platform}）…`);
    const bytes = await downloadRelease(`${download}/${archive}`, { fetch: options.fetch ?? globalThis.fetch, tty: options.tty, progress: options.progress });
    const sums = (await downloadRelease(`${download}/SHA256SUMS`, { fetch: options.fetch ?? globalThis.fetch, tty: false })).toString("utf8");
    const matches = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === archive);
    if (matches.length !== 1 || matches[0]!.length !== 2 || !/^[0-9a-fA-F]{64}$/.test(matches[0]![0]!)) throw new UpgradeError("SHA256SUMS 缺少或重复校验记录，未替换程序");
    if (createHash("sha256").update(bytes).digest("hex") !== matches[0]![0]!.toLowerCase()) throw new UpgradeError("SHA256 校验失败，未替换任何程序");
    const tar = join(temp, archive), extracted = join(temp, "extracted");
    await writeFile(tar, bytes, { mode: 0o600 }); await mkdir(extracted, { mode: 0o700 });
    const entries = (await command(["tar", "-tzf", tar])).trim().split("\n"), types = (await command(["tar", "-tvzf", tar])).trim().split("\n");
    if (entries.length !== 3 || binaries.some(name => entries.filter(entry => entry === name).length !== 1)
      || types.length !== 3 || types.some(line => !line.startsWith("-"))) throw new UpgradeError("压缩包必须包含 lumio 与两个普通转发垫片，未替换程序");
    await command(["tar", "-xzf", tar, "-C", extracted]);
    for (const name of binaries) {
      const info = await lstat(join(extracted, name));
      if (!info.isFile() || info.nlink !== 1) throw new UpgradeError("压缩包必须包含三个普通文件");
    }
    for (const role of ["hub", "runtime"] as const) {
      const bytes = await readFile(join(extracted, `lumio-${role}`));
      if (!bytes.equals(Buffer.from(releaseShim(role)))) throw new UpgradeError("发布包转发垫片内容不匹配，未替换程序");
    }
    const source = join(extracted, "lumio");
    await chmod(source, 0o755);
    const target = releaseVersion.exec((await command([source, "--version"])).trim())?.[1];
    if (!target || (options.version && target !== options.version.slice(1))) throw new UpgradeError("下载程序的版本不一致，未替换程序");
    let current = true;
    for (const name of binaries) {
      try {
        const r = await io.run([join(bin, name), "--version"]);
        if (r.code || r.stdout.trim().replace(/^v/, "") !== target) current = false;
        if (name !== "lumio" && resolve(bin, await readlink(join(bin, name))) !== binary) current = false;
      } catch { current = false; }
    }
    let hubUrl: string | undefined;
    if (!options.runtimeOnly) {
      try { hubUrl = io.env.LUMIO_HUB_URL ?? (JSON.parse(await io.read(join(io.home, ".config/lumio/config.json"))) as { hub_url?: string }).hub_url; } catch { /* CLI may not be configured */ }
    }
    const localHub = hubUrl && localAddress(httpURL(hubUrl));
    const services: { role: "hub" | "runtime"; path: string; old: string; content: string; mode: number }[] = [];
    for (const role of [...(localHub ? ["hub" as const] : []), "runtime" as const]) {
      const path = io.platform === "darwin" ? join(io.home, `Library/LaunchAgents/io.lumio.${role}.plist`) : join(io.home, `.config/systemd/user/lumio-${role}.service`);
      try {
        if (!(await io.stat(path)).isFile()) continue;
        const old = await io.read(path), content = unifiedService(old, binary, role, io.platform);
        services.push({ role, path, old, content, mode: io.platform === "darwin" ? 0o600 : 0o644 });
      } catch (cause) { if (cause instanceof UpgradeError) throw cause; if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    }
    if (current && services.every(service => service.old === service.content)) { log(`已是${options.version ? "指定" : "最新"}版本 ${target}`); return; }
    await mkdir(bin, { recursive: true });
    const changes: { path: string; stage: string; restore?: string; link?: string; mode?: number }[] = [];
    for (const name of binaries) {
      const path = join(bin, name), stage = join(bin, `.${name}.${crypto.randomUUID()}.new`); stages.push(stage);
      const change: typeof changes[number] = { path, stage };
      try {
        const previous = await lstat(path);
        if (previous.isSymbolicLink()) change.link = await readlink(path);
        else if (previous.isFile()) { change.restore = join(temp, `${name}.backup`); change.mode = previous.mode & 0o777; await copyFile(path, change.restore); }
        else throw new UpgradeError("程序目标不是普通文件或兼容链接，未替换程序");
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      if (name === "lumio") { await copyFile(source, stage); await chmod(stage, 0o755); } else await symlink("lumio", stage);
      changes.push(change);
    }
    for (const service of services) if (service.old !== service.content) {
      const stage = `${service.path}.${crypto.randomUUID()}.new`, restore = join(temp, `${service.role}.service.backup`); stages.push(stage);
      await writeFile(stage, service.content, { mode: service.mode, flag: "wx" }); await chmod(stage, service.mode); await writeFile(restore, service.old, { mode: service.mode });
      if (io.platform === "darwin") await command(["plutil", "-lint", stage]);
      changes.push({ path: service.path, stage, restore, mode: service.mode });
    }
    const replaced: typeof changes = [];
    try { for (const change of changes) { await rename(change.stage, change.path); replaced.push(change); } }
    catch {
      for (const change of replaced.reverse()) {
        if (change.link !== undefined || change.restore) {
          const stage = `${change.path}.${crypto.randomUUID()}.restore`; stages.push(stage);
          if (change.link !== undefined) await symlink(change.link, stage);
          else { await copyFile(change.restore!, stage); await chmod(stage, change.mode!); }
          await rename(stage, change.path);
        } else await rm(change.path, { force: true });
      }
      throw new UpgradeError("替换失败，已恢复原程序、链接与服务文件");
    }
    if (io.platform === "linux" && services.length) await command(["systemctl", "--user", "daemon-reload"]);
    for (const service of services) {
      if (io.platform === "darwin") {
        await io.run(["launchctl", "bootout", `gui/${io.uid}`, service.path]);
        await command(["launchctl", "bootstrap", `gui/${io.uid}`, service.path]);
      } else await command(serviceCommand(io.platform, io.uid, service.role, "restart"));
    }
    if ((localHub && !services.some(service => service.role === "hub")) || (options.runtimeOnly && !services.some(service => service.role === "runtime"))) throw new UpgradeError("程序已升级，但未找到后台服务；请运行 lumio hub setup 或 lumio runtime install-service");
    if (localHub) {
      const now = options.now ?? Date.now, sleep = options.sleep ?? Bun.sleep, deadline = now() + 30_000;
      let healthy = false;
      while (now() < deadline) {
        try { const r = await io.fetch(`${hubUrl!.replace(/\/+$/, "")}/health`); if (r.ok && (await r.json() as { version?: string }).version === target) { healthy = true; break; } } catch { /* service is starting */ }
        await sleep(500);
      }
      if (!healthy) throw new UpgradeError("程序已升级，但 Hub 未在 30 秒内报告新版本；请运行 lumio doctor");
    }
    log(`已升级至 ${target}`);
    if (localHub) {
      log(`网页：${hubUrl}`);
      try { const publicUrl = io.env.LUMIO_PUBLIC_URL ?? environment(await io.read(join(io.home, ".config/lumio/hub.env"))).LUMIO_PUBLIC_URL; if (publicUrl) log(`对外网页：${httpURL(publicUrl).href}`); } catch { /* no public address */ }
      log("运行 lumio login-code --name web 获取配对码");
    }
    let sudoConfigured = Boolean(io.env.LUMIO_RUNTIME_SUDO_COMMAND);
    try { sudoConfigured ||= Boolean(environment(await io.read(join(io.home, ".config/lumio-runtime/runtime.env"))).LUMIO_RUNTIME_SUDO_COMMAND); } catch { /* no helper */ }
    if (sudoConfigured) log("还需运行 `sudo lumio-runtime install-sudo-helper` 更新助手程序");
  } catch (cause) {
    if (cause instanceof UpgradeError) throw cause;
    if (cause instanceof DownloadError) throw new UpgradeError(cause.message);
    throw new UpgradeError("升级失败，请检查网络、下载源、程序权限与后台服务日志");
  } finally { await Promise.all(stages.map(path => rm(path, { force: true }))); await rm(temp, { recursive: true, force: true }); }
}

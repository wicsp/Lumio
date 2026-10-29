import { downloadRelease, DownloadError, type DownloadOptions } from "./download.ts";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { diagnosticIO, environment, httpURL, localAddress, serviceCommand, type DiagnosticOptions } from "./diagnostics.ts";

// Kept identical in CLI and runtime: apps cannot import one another (DESIGN §2).
export class UpgradeError extends Error { readonly code = "UPGRADE_FAILED"; }
export interface UpgradeOptions extends DiagnosticOptions {
  tty?: boolean; progress?: DownloadOptions["progress"];
  arch?: string; version?: string; runtimeOnly?: boolean; releaseBase?: string;
  log?: (line: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void>;
}
const binaries = ["lumio", "lumio-hub", "lumio-runtime"] as const;
const releaseVersion = /^(?:v)?(\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?)$/;
export async function upgrade(options: UpgradeOptions = {}): Promise<void> {
  const io = diagnosticIO(options), log = options.log ?? console.log;
  const arch = options.arch ?? process.arch;
  const platform = io.platform === "darwin" && arch === "arm64" ? "darwin-arm64"
    : io.platform === "linux" && ["x64", "arm64"].includes(arch) ? `linux-${arch}` : undefined;
  if (!platform) throw new UpgradeError("不支持的平台（支持 macOS arm64、Linux x64/arm64）");
  if (options.version && !/^v\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?$/.test(options.version)) throw new UpgradeError("版本应为 vX.Y.Z");
  const base = options.releaseBase ?? io.env.LUMIO_RELEASE_BASE_URL ?? "https://github.com/wicsp/Lumio/releases";
  httpURL(base);
  const releaseFetch = options.fetch ?? globalThis.fetch;
  const download = `${base.replace(/\/+$/, "")}/${options.version ? `download/${options.version}` : "latest/download"}`;
  const archive = `lumio-${platform}.tar.gz`, bin = join(io.home, ".local/bin");
  const temp = await mkdtemp(join(tmpdir(), "lumio-upgrade-"));
  const run = io.run;
  async function command(argv: string[]) {
    const r = await run(argv); if (r.code) throw new UpgradeError("升级命令失败；请检查 tar、程序权限和后台服务日志"); return r.stdout;
  }
  const stages: string[] = [], replaced: string[] = [], backups = new Set<string>();
  try {
    log(`下载 Lumio ${options.version ?? "最新版本"}（${platform}）…`);
    const bytes = await downloadRelease(`${download}/${archive}`, { fetch: releaseFetch, tty: options.tty, progress: options.progress });
    const sumsText = (await downloadRelease(`${download}/SHA256SUMS`, { fetch: releaseFetch, tty: false })).toString("utf8");
    const matches = sumsText.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts[1] === archive);
    if (matches.length !== 1 || matches[0]!.length !== 2 || !/^[0-9a-fA-F]{64}$/.test(matches[0]![0]!)) throw new UpgradeError("SHA256SUMS 缺少或重复校验记录，未替换程序");
    if (createHash("sha256").update(bytes).digest("hex") !== matches[0]![0]!.toLowerCase()) throw new UpgradeError("SHA256 校验失败，未替换任何程序");
    const tar = join(temp, archive), extracted = join(temp, "extracted");
    await writeFile(tar, bytes, { mode: 0o600 }); await mkdir(extracted, { mode: 0o700 });
    const entries = (await command(["tar", "-tzf", tar])).trim().split("\n");
    const types = (await command(["tar", "-tvzf", tar])).trim().split("\n");
    if (entries.length !== 3 || binaries.some((name) => entries.filter((e) => e === name).length !== 1) || types.length !== 3 || types.some((line) => !line.startsWith("-"))) throw new UpgradeError("压缩包包含非预期路径或文件类型，未替换程序");
    await command(["tar", "-xzf", tar, "-C", extracted]);
    let target: string | undefined;
    for (const name of binaries) {
      const path = join(extracted, name), stat = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1) throw new UpgradeError("压缩包必须包含三个普通程序文件");
      await chmod(path, 0o755);
      const v = releaseVersion.exec((await command([path, "--version"])).trim())?.[1];
      if (!v || (target && v !== target) || (options.version && v !== options.version.slice(1))) throw new UpgradeError("下载程序的版本不一致，未替换程序");
      target = v;
    }
    let current = true;
    for (const name of binaries) {
      try { const r = await run([join(bin, name), "--version"]); if (r.code || r.stdout.trim().replace(/^v/, "") !== target) current = false; }
      catch { current = false; }
    }
    if (current) { log(`已是${options.version ? "指定" : "最新"}版本 ${target}`); return; }
    await mkdir(bin, { recursive: true });
    // Stage all three before touching installed programs. Rename works while an older executable is running.
    for (const name of binaries) {
      const dest = join(bin, `.${name}.${crypto.randomUUID()}.new`); stages.push(dest);
      await copyFile(join(extracted, name), dest); await chmod(dest, 0o755);
      try { await copyFile(join(bin, name), join(temp, `${name}.backup`)); backups.add(name); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    }
    try {
      for (let i = 0; i < binaries.length; i++) { await rename(stages[i]!, join(bin, binaries[i]!)); replaced.push(binaries[i]!); }
    } catch {
      for (const name of replaced.reverse()) {
        if (backups.has(name)) { const restore = join(bin, `.${name}.${crypto.randomUUID()}.restore`); await copyFile(join(temp, `${name}.backup`), restore); await rename(restore, join(bin, name)); }
        else await rm(join(bin, name), { force: true });
      }
      throw new UpgradeError("替换程序失败，已恢复原程序");
    }
    let hubUrl: string | undefined;
    if (!options.runtimeOnly) {
      try { hubUrl = io.env.LUMIO_HUB_URL ?? (JSON.parse(await io.read(join(io.home, ".config/lumio/config.json"))) as { hub_url?: string }).hub_url; }
      catch { /* installation may have no CLI configuration */ }
    }
    const localHub = hubUrl && localAddress(httpURL(hubUrl));
    for (const service of [...(localHub ? ["hub" as const] : []), "runtime" as const]) {
      const servicePath = io.platform === "darwin" ? join(io.home, `Library/LaunchAgents/io.lumio.${service}.plist`) : join(io.home, `.config/systemd/user/lumio-${service}.service`);
      let installed = false;
      try { installed = (await io.stat(servicePath)).isFile(); } catch { /* service is not installed on this client */ }
      if (installed) await command(serviceCommand(io.platform, io.uid, service, "restart"));
      else if (service === "hub" || options.runtimeOnly) throw new UpgradeError(`程序已升级，但未找到 ${service} 服务；请运行 ${service === "hub" ? "lumio-hub setup" : "lumio-runtime install-service"}`);
    }
    if (localHub) {
      const now = options.now ?? Date.now, sleep = options.sleep ?? Bun.sleep, deadline = now() + 30_000;
      let healthy = false;
      while (now() < deadline) {
        try { const r = await io.fetch(`${hubUrl!.replace(/\/+$/, "")}/health`); if (r.ok && (await r.json() as { ok?: boolean; version?: string }).version === target) { healthy = true; break; } } catch { /* restart still in progress */ }
        await sleep(500);
      }
      if (!healthy) throw new UpgradeError("程序已升级，但 Hub 未在 30 秒内报告新版本；请运行 lumio doctor");
    }
    log(`已升级至 ${target}`);
    let sudoConfigured = Boolean(io.env.LUMIO_RUNTIME_SUDO_COMMAND);
    try { sudoConfigured ||= Boolean(environment(await io.read(join(io.home, ".config/lumio-runtime/runtime.env"))).LUMIO_RUNTIME_SUDO_COMMAND); } catch { /* no helper */ }
    if (sudoConfigured) log("还需运行 `sudo lumio-runtime install-sudo-helper` 更新助手程序");
  } catch (cause) {
    if (cause instanceof UpgradeError) throw cause;
    if (cause instanceof DownloadError) throw new UpgradeError(cause.message);
    throw new UpgradeError("升级失败，请检查网络、下载源、程序权限与后台服务日志");
  } finally {
    await Promise.all(stages.map((p) => rm(p, { force: true })));
    await rm(temp, { recursive: true, force: true });
  }
}
export async function runUpgrade(args: string[], runtimeOnly: boolean, log = console.log): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { version: { type: "string" } } });
  if (positionals.length) throw new UpgradeError(`用法：${runtimeOnly ? "lumio-runtime" : "lumio"} upgrade [--version vX.Y.Z]`);
  await upgrade({ version: values.version, runtimeOnly, log }); return 0;
}

import { type Text, untranslated } from "./language.ts";
import { downloadRelease, DownloadError } from "./download.ts";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticIO, environment, httpURL, localAddress, serviceCommand, type DiagnosticOptions } from "./diagnostics.ts";
import { createProgressLine } from "./terminal.ts";
import { manifestArtifact, verifyArtifact, verifyManifest, ReleaseVerificationError, type releasePublicKeys } from "./release-manifest.ts";
import { RuntimeRegistered, type RuntimePlatform } from "@lumio/schema";

export class UpgradeError extends Error {
  readonly code = "UPGRADE_FAILED";
  constructor(public readonly params: { key: string; args: readonly unknown[] }) { super("UPGRADE_FAILED"); this.name = "UpgradeError"; }
}
export interface UpgradeOptions extends DiagnosticOptions {
  tty?: boolean; progress?: (chunk: string) => void; columns?: () => number;
  arch?: string; version?: string; runtimeOnly?: boolean; releaseBase?: string;
  releaseKeys?: typeof releasePublicKeys;
  log?: (line: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void>;
}
const releaseVersion = /^(?:v)?(\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?)$/;
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export function unifiedService(content: string, binary: string, role: "hub" | "runtime", platform: string): string {
  if (platform === "darwin") {
    const pattern = /<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/;
    if (!pattern.test(content)) throw new UpgradeError({ key: "upgrade.unrecognized_existing_service_file_repair_setup_configuration_first", args: [] });
    return content.replace(pattern, () => `<key>ProgramArguments</key><array><string>${xml(binary)}</string><string>${role}</string><string>serve</string></array>`);
  }
  if (!/^ExecStart=.+$/m.test(content)) throw new UpgradeError({ key: "upgrade.unrecognized_existing_service_file_repair_setup_configuration_first", args: [] });
  const quoted = `"${binary.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  return content.replace(/^ExecStart=.+$/m, () => `ExecStart=${quoted} ${role} serve`);
}

async function removeCompatibilityLinks(bin: string): Promise<void> {
  for (const role of ["hub", "runtime"]) {
    const path = join(bin, `lumio-${role}`);
    try {
      if ((await lstat(path)).isSymbolicLink() && await readlink(path) === "lumio") await rm(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
}

/** Install one verified program and update its service commands. */
export async function upgrade(options: UpgradeOptions = {}): Promise<void> {
  const msg = options.text ?? untranslated;
  const io = diagnosticIO(options), log = options.log ?? (() => {}), arch = options.arch ?? process.arch;
  const platform = io.platform === "darwin" && arch === "arm64" ? "darwin-arm64" : io.platform === "linux" && ["x64", "arm64"].includes(arch) ? `linux-${arch}` : undefined;
  if (!platform) throw new UpgradeError({ key: "upgrade.unsupported_platform_supported_macos_arm64_linux_x64_arm64", args: [] });
  if (options.version && !/^v\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?$/.test(options.version)) throw new UpgradeError({ key: "upgrade.version_must_be_vx_y_z", args: [] });
  const base = options.releaseBase ?? io.env.LUMIO_RELEASE_BASE_URL ?? "https://github.com/wicsp/Lumio/releases"; httpURL(base);
  const archive = `lumio-${platform}.tar.gz`, bin = join(io.home, ".local/bin"), binary = join(bin, "lumio");
  const temp = await mkdtemp(join(tmpdir(), "lumio-upgrade-")), stages: string[] = [];
  const command = async (argv: string[]) => { const r = await io.run(argv); if (r.code) throw new UpgradeError({ key: "upgrade.upgrade_command_failed_check_program_permissions_and_service_logs_if", args: [] }); return r.stdout; };
  const installation = async (target: string | undefined) => {
    let current = Boolean(target);
    try {
      const r = await io.run([binary, "--version"]);
      current &&= !r.code && r.stdout.trim().replace(/^v/, "") === target;
    } catch { current = false; }
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
    let runtimeSelfUpdates = false;
    if (localHub) {
      try {
        const env = environment(await io.read(join(io.home, ".config/lumio-runtime/runtime.env")));
        const state = io.env.LUMIO_RUNTIME_STATE_DIR ?? env.LUMIO_RUNTIME_STATE_DIR ?? join(io.home, ".local/share/lumio-runtime");
        const runtime = RuntimeRegistered.parse(JSON.parse(await io.read(join(state, "registered.json"))));
        runtimeSelfUpdates = runtime.registration.install === "hub-shared" && !!runtime.registration.features?.includes("self_update");
      } catch { /* Older Runtime registrations retain the previous restart behavior. */ }
    }
    return { current, services, localHub, hubUrl, runtimeSelfUpdates };
  };
  try {
    let requested = options.version;
    if (!requested) {
      try {
        const response = await io.fetch(`${base.replace(/\/+$/, "")}/latest`, { redirect: "manual" });
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          const match = /\/tag\/(v\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?)$/.exec(new URL(location, base).pathname);
          if (match) requested = match[1];
        }
        await response.body?.cancel();
      } catch { /* Mirrors without a latest redirect retain the verified-download fallback. */ }
    }
    const initial = requested ? await installation(requested.slice(1)) : undefined;
    if (initial?.current && initial.services.every(service => service.old === service.content)) {
      await removeCompatibilityLinks(bin);
      log(msg("Already at ${0} version ${1}", options.version ? msg("specified") : msg("latest"), requested!.slice(1))); return;
    }
    const download = `${base.replace(/\/+$/, "")}/${requested ? `download/${requested}` : "latest/download"}`;
    const onProgress = createProgressLine({ text: msg, label: msg("Downloading Lumio ${0} (${1})", requested?.slice(1) ?? msg("latest version"), platform),
      tty: options.tty ?? false, columns: options.columns, write: options.progress ?? (() => {}) });
    const manifestBytes = await downloadRelease(`${download}/manifest.json`, { fetch: io.fetch, maxBytes: 64 * 1024 });
    const signature = (await downloadRelease(`${download}/manifest.sig`, { fetch: io.fetch, maxBytes: 256 })).toString("utf8");
    const manifest = verifyManifest(manifestBytes, signature, options.releaseKeys, requested?.slice(1));
    const artifact = manifestArtifact(manifest, platform as RuntimePlatform);
    const bytes = await downloadRelease(`${download}/${artifact.file}`, { fetch: io.fetch, onProgress, maxBytes: artifact.size });
    verifyArtifact(bytes, artifact);
    const tar = join(temp, archive), extracted = join(temp, "extracted");
    await writeFile(tar, bytes, { mode: 0o600 }); await mkdir(extracted, { mode: 0o700 });
    const entry = (await command(["tar", "-tzf", tar])).trim(), type = (await command(["tar", "-tvzf", tar])).trim();
    if (entry !== "lumio" || type.includes("\n") || !type.startsWith("-")) throw new UpgradeError({ key: "upgrade.invalid_release_archive", args: [] });
    await command(["tar", "-xzf", tar, "-C", extracted]);
    const source = join(extracted, "lumio");
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.nlink !== 1) throw new UpgradeError({ key: "upgrade.invalid_release_archive", args: [] });
    await chmod(source, 0o755);
    const target = releaseVersion.exec((await command([source, "--version"])).trim())?.[1];
    if (!target || (requested && target !== requested.slice(1)) || target !== manifest.version) throw new UpgradeError({ key: "upgrade.downloaded_program_version_mismatch_program_was_not_replaced", args: [] });
    const { current, services, localHub, hubUrl, runtimeSelfUpdates } = initial ?? await installation(target);
    if (current && services.every(service => service.old === service.content)) { await removeCompatibilityLinks(bin); log(msg("Already at ${0} version ${1}", options.version ? msg("specified") : msg("latest"), target)); return; }
    await mkdir(bin, { recursive: true });
    const changes: { path: string; stage: string; restore?: string; link?: string; mode?: number }[] = [];
    const stage = join(bin, `.lumio.${crypto.randomUUID()}.new`);
    stages.push(stage);
    const change: typeof changes[number] = { path: binary, stage };
    try {
      const previous = await lstat(binary);
      if (previous.isSymbolicLink()) change.link = await readlink(binary);
      else if (previous.isFile()) {
        change.restore = join(temp, "lumio.backup");
        change.mode = previous.mode & 0o777;
        await copyFile(binary, change.restore);
      } else throw new UpgradeError({ key: "upgrade.program_destination_is_not_a_regular_file_or_compatibility_link_prog", args: [] });
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    await copyFile(source, stage);
    await chmod(stage, 0o755);
    changes.push(change);
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
      throw new UpgradeError({ key: "upgrade.replacement_failed_original_program_links_and_service_files_restored", args: [] });
    }
    if (io.platform === "linux" && services.length) await command(["systemctl", "--user", "daemon-reload"]);
    for (const service of services) {
      if (service.role === "runtime" && runtimeSelfUpdates) continue;
      if (io.platform === "darwin") {
        await io.run(["launchctl", "bootout", `gui/${io.uid}`, service.path]);
        await command(["launchctl", "bootstrap", `gui/${io.uid}`, service.path]);
      } else await command(serviceCommand(io.platform, io.uid, service.role, "restart"));
    }
    if ((localHub && !services.some(service => service.role === "hub")) || (options.runtimeOnly && !services.some(service => service.role === "runtime"))) throw new UpgradeError({ key: "upgrade.program_upgraded_but_no_background_service_found_run_lumio_hub_setup", args: [] });
    if (localHub) {
      const now = options.now ?? Date.now, sleep = options.sleep ?? Bun.sleep, deadline = now() + 30_000;
      let healthy = false;
      while (now() < deadline) {
        try { const r = await io.fetch(`${hubUrl!.replace(/\/+$/, "")}/health`); if (r.ok && (await r.json() as { version?: string }).version === target) { healthy = true; break; } } catch { /* service is starting */ }
        await sleep(500);
      }
      if (!healthy) throw new UpgradeError({ key: "upgrade.program_upgraded_but_hub_did_not_report_new_version_within_30_second", args: [] });
    }
    await removeCompatibilityLinks(bin);
    log(msg("Upgraded to ${0}", target));
    if (localHub) {
      log(msg("Web: ${0}", hubUrl));
      try { const publicUrl = io.env.LUMIO_PUBLIC_URL ?? environment(await io.read(join(io.home, ".config/lumio/hub.env"))).LUMIO_PUBLIC_URL; if (publicUrl) log(msg("Public web: ${0}", httpURL(publicUrl).href)); } catch { /* no public address */ }
      log(msg("Run lumio login-code --name web to get a pairing code"));
    }
    let sudoConfigured = Boolean(io.env.LUMIO_RUNTIME_SUDO_COMMAND);
    try { sudoConfigured ||= Boolean(environment(await io.read(join(io.home, ".config/lumio-runtime/runtime.env"))).LUMIO_RUNTIME_SUDO_COMMAND); } catch { /* no helper */ }
    if (sudoConfigured) log(msg("Run `sudo lumio runtime install-sudo-helper` to update the helper program"));
  } catch (cause) {
    if (cause instanceof UpgradeError) throw cause;
    if (cause instanceof DownloadError) throw new UpgradeError(cause.params);
    if (cause instanceof ReleaseVerificationError) throw new UpgradeError({ key: `update.${cause.reason}`, args: [] });
    throw new UpgradeError({ key: "upgrade.upgrade_failed_check_network_download_source_program_permissions_and", args: [] });
  } finally { await Promise.all(stages.map(path => rm(path, { force: true }))); await rm(temp, { recursive: true, force: true }); }
}

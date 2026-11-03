import { text as msg } from "./messages.ts";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { RuntimeInfo } from "@lumio/schema";
import { RuntimeError } from "./config.ts";

export interface CommandResult { code: number; stdout: string; stderr: string }
export type RunCommand = (argv: string[]) => Promise<CommandResult>;
export const runCommand: RunCommand = async (argv) => {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
};
async function atomicFile(path: string, content: string, mode: number, privateDirectory = false) {
  await mkdir(dirname(path), { recursive: true, mode: privateDirectory ? 0o700 : 0o755 });
  if (privateDirectory) await chmod(dirname(path), 0o700);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temp, content, { mode, flag: "wx" }); await chmod(temp, mode); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export const privateFile = (path: string, content: string) => atomicFile(path, content, 0o600, true);
/** Our generated format is also accepted by systemd EnvironmentFile (no shell expansion). */
export function parseEnvironment(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new RuntimeError(msg("service.invalid_runtime_env_format"));
    let value = match[2]!;
    if (value.startsWith('"')) {
      if (!value.endsWith('"')) throw new RuntimeError(msg("service.invalid_runtime_env_format"));
      value = value.slice(1, -1).replace(/\\([\\"$`])/g, "$1");
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    env[match[1]!] = value;
  }
  return env;
}
export function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
/** systemd 的 EnvironmentFile= 不认引号（加了引号会被当成相对路径而忽略），只能原样写；因此不允许空白字符。 */
function unitPath(value: string): string {
  if (/\s/.test(value)) throw new RuntimeError(msg("setup.service_configuration_paths_must_not_contain_whitespace"));
  return value.replaceAll("%", "%%");
}
function unitString(value: string): string { return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`; }
export function runtimePlist(binary: string, env: Record<string, string>, state: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.lumio.runtime</string>
<key>ProgramArguments</key><array><string>${xml(binary)}</string><string>runtime</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(state, "runtime.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(state, "runtime.err.log"))}</string>
</dict></plist>\n`;
}
export function runtimeUnit(binary: string, envFile: string): string {
  return `[Unit]\nDescription=Lumio runtime\nAfter=network.target\n\n[Service]\nExecStart=${unitString(binary)} runtime serve\nEnvironmentFile=${unitPath(envFile)}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}
export interface ServiceOptions {
  home?: string; platform?: string; binary?: string; uid?: number; user?: string;
  run?: RunCommand; log?: (line: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void>;
}
export async function installService(options: ServiceOptions = {}): Promise<void> {
  const home = resolve(options.home ?? process.env.HOME ?? homedir());
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand, log = options.log ?? console.log;
  const binary = options.binary ?? process.execPath;
  if (binary === process.execPath && !Bun.main.startsWith("/$bunfs/")) throw new RuntimeError(msg("service.run_install_service_using_the_program_installed_by_install_sh_runnin"));
  if (!isAbsolute(binary) || /[\r\n]/.test(binary)) throw new RuntimeError(msg("service.runtime_program_path_must_be_absolute"));
  const envFile = join(home, ".config/lumio-runtime/runtime.env");
  const env = parseEnvironment(await readFile(envFile, "utf8"));
  const state = env.LUMIO_RUNTIME_STATE_DIR ?? join(home, ".local/share/lumio-runtime");
  if (!isAbsolute(state)) throw new RuntimeError(msg("service.runtime_state_directory_must_be_absolute"));
  await mkdir(state, { recursive: true, mode: 0o700 }); await chmod(state, 0o700);
  const receipt = join(state, "registered.json");
  await rm(receipt, { force: true });
  if (platform === "darwin") {
    const path = join(home, "Library/LaunchAgents/io.lumio.runtime.plist");
    await atomicFile(path, runtimePlist(binary, env, state), 0o600);
    if ((await run(["plutil", "-lint", path])).code) throw new RuntimeError(msg("service.runtime_service_configuration_validation_failed"));
    const domain = `gui/${options.uid ?? process.getuid!()}`;
    await run(["launchctl", "bootout", domain, path]);
    if ((await run(["launchctl", "bootstrap", domain, path])).code) throw new RuntimeError(msg("service.runtime_service_could_not_start_see_runtime_err_log", state));
  } else if (platform === "linux") {
    const path = join(home, ".config/systemd/user/lumio-runtime.service");
    await atomicFile(path, runtimeUnit(binary, envFile), 0o644);
    let available = false;
    try { available = (await run(["systemctl", "--user", "show-environment"])).code === 0; } catch { /* manual fallback */ }
    if (!available) {
      log(msg("service.no_systemd_user_service_run_manually_nohup_runtime_serve_runtime_log", binary.replaceAll("'", "'\\''"), state.replaceAll("'", "'\\''"), envFile));
      return;
    }
    const active = (await run(["systemctl", "--user", "is-active", "--quiet", "lumio-runtime.service"])).code === 0;
    for (const argv of [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "lumio-runtime.service"], ...(active ? [["systemctl", "--user", "restart", "lumio-runtime.service"]] : [])]) {
      if ((await run(argv)).code) throw new RuntimeError(msg("service.runtime_service_could_not_start_run_journalctl_user_u_lumio_runtime"));
    }
    let linger = "";
    try { linger = (await run(["loginctl", "show-user", options.user ?? process.env.USER ?? "", "-p", "Linger"])).stdout; } catch { /* report below */ }
    if (!linger.includes("Linger=yes")) log(msg("service.runtime_will_stop_on_logout_ask_an_administrator_to_run_loginctl_ena", options.user ?? process.env.USER ?? msg("setup.username")));
  } else throw new RuntimeError(msg("setup.only_macos_and_linux_are_supported"));
  const now = options.now ?? Date.now, sleep = options.sleep ?? Bun.sleep;
  const until = now() + 30_000;
  while (now() < until) {
    try {
      const info = RuntimeInfo.parse(JSON.parse(await readFile(receipt, "utf8")));
      if (info.registration.name === env.LUMIO_RUNTIME_NAME) {
        log(msg("service.connected_to_hub_detected", info.registration.engines.map((engine) => `${engine.name} ${engine.version}`).join(", ") || msg("service.no_agent_found_check_path")));
        return;
      }
    } catch { /* wait for a fresh successful registration */ }
    await sleep(500);
  }
  throw new RuntimeError(platform === "linux" ? msg("service.runtime_registration_timed_out_run_journalctl_user_u_lumio_runtime_n") : msg("service.runtime_registration_timed_out_see_runtime_err_log", state));
}

export async function runtimeEnvironment(home = process.env.HOME ?? homedir(), env = process.env): Promise<NodeJS.ProcessEnv> {
  try {
    const file = parseEnvironment(await readFile(join(home, ".config/lumio-runtime/runtime.env"), "utf8"));
    // 环境变量优先，但 PATH 例外：后台服务（systemd、launchd）给的 PATH 是系统默认值，找不到 agent；
    // runtime.env 里的 PATH 是配对时从人的终端记下来的（P2-8）。
    const merged = { ...file, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) };
    if (file.PATH) merged.PATH = file.PATH;
    return merged;
  }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return env; throw cause; }
}

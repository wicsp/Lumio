import { text as msg } from "./messages.ts";
import { extraServices, healthVersion, publicHubChecks } from "./hub-checks.ts";
import { version } from "./version.ts";
import * as files from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { askTerminal, openTerminal } from "@lumio/platform";
import { CliConfig, RuntimeName } from "@lumio/schema";
import { readConfig, isLoopback, runtimeName, rememberLocalRuntime } from "./config.ts";
import { HubError } from "./errors.ts";
import { HubStore } from "./store.ts";

interface CommandResult { code: number; stdout: string; stderr: string }
type Run = (argv: string[]) => Promise<CommandResult>;
export async function runCommand(argv: string[]): Promise<CommandResult> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 40_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}
export function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
/** systemd 的 EnvironmentFile= 不认引号（加了引号会被当成相对路径而忽略），只能原样写；因此不允许空白字符。 */
function unitPath(value: string): string {
  if (/\s/.test(value)) throw new HubError("INVALID", { key: "setup.service_configuration_paths_must_not_contain_whitespace", args: [] });
  return value.replaceAll("%", "%%");
}
function unitString(value: string): string { return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`; }
export function environmentText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => {
    if (/[\r\n\0]/.test(value)) throw new HubError("INVALID", { key: "setup.service_environment_variables_must_not_contain_newlines_or_nul", args: [] });
    return `${key}="${value.replace(/[\\"$`]/g, "\\$&")}"`;
  }).join("\n") + "\n";
}
export function parseEnvironment(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/).map((line) => line.trim())) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new HubError("INVALID", { key: "setup.invalid_existing_service_environment_file", args: [] });
    let value = match[2]!;
    if (value.startsWith('"')) {
      if (!value.endsWith('"')) throw new HubError("INVALID", { key: "setup.invalid_existing_service_environment_file", args: [] });
      value = value.slice(1, -1).replace(/\\([\\"$`])/g, "$1");
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    env[match[1]!] = value;
  }
  return env;
}
export function hubPlist(binary: string, env: Record<string, string>, state: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.lumio.hub</string>
<key>ProgramArguments</key><array><string>${xml(binary)}</string><string>hub</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(state, "hub.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(state, "hub.err.log"))}</string>
</dict></plist>\n`;
}
export function hubUnit(binary: string, envFile: string): string {
  return `[Unit]\nDescription=Lumio Hub\nAfter=network.target\n\n[Service]\nExecStart=${unitString(binary)} hub serve\nEnvironmentFile=${unitPath(envFile)}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}
export { runtimeName } from "./config.ts";
export interface SetupOptions {
  vault?: string; server?: boolean; yes?: boolean; interactive?: boolean; publicUrl?: string; terminalPath?: string; home?: string; host?: string; platform?: string;
  binary?: string; runtimeBinary?: string; env?: NodeJS.ProcessEnv; uid?: number;
  run?: Run; find?: (program: string) => string | null; fetch?: (input: string, init?: RequestInit) => Promise<Response>; files?: typeof files;
  now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void;
  ask?: (question: string, fallback: string) => Promise<string>;
}
export async function optional(path: string, fs = files) {
  try { return await fs.readFile(path, "utf8"); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; }
}
export async function atomicFile(path: string, content: string, mode: number, privateDirectory = false, fs = files) {
  await fs.mkdir(dirname(path), { recursive: true, mode: privateDirectory ? 0o700 : 0o755 });
  if (privateDirectory) await fs.chmod(dirname(path), 0o700);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, content, { flag: "wx", mode }); await fs.chmod(temp, mode); await fs.rename(temp, path); }
  finally { await fs.rm(temp, { force: true }); }
}

export async function setup(options: SetupOptions = {}): Promise<void> {
  const fs = options.files ?? files, env = options.env ?? process.env;
  const home = resolve(options.home ?? env.HOME ?? homedir());
  const host = options.host ?? hostname(), platform = options.platform ?? process.platform;
  const binary = options.binary ?? process.execPath, runtimeBinary = options.runtimeBinary ?? binary;
  if (binary === process.execPath && !Bun.main.startsWith("/$bunfs/")) throw new HubError("INVALID", { key: "setup.run_setup_using_the_program_installed_by_install_sh_running_from_sou", args: [] });
  if (!["darwin", "linux"].includes(platform)) throw new HubError("INVALID", { key: "setup.only_macos_and_linux_are_supported", args: [] });
  if (![binary, runtimeBinary].every((path) => isAbsolute(path) && !/[\r\n]/.test(path))) throw new HubError("INVALID", { key: "setup.program_path_must_be_absolute", args: [] });
  const run = options.run ?? runCommand, find = options.find ?? ((program) => Bun.which(program));
  const log = options.log ?? console.log, fetcher = options.fetch ?? fetch;
  const terminal = options.ask ? undefined : openTerminal(options.terminalPath);
  const interactive = options.interactive ?? Boolean(options.ask || terminal);
  if (!interactive) log(msg("setup.no_interactive_terminal_using_existing_configuration_or_defaults_cha"));
  const ask = async (question: string, fallback: string) => {
    if (options.yes || !interactive) return fallback;
    if (options.ask) return (await options.ask(question, fallback)).trim() || fallback;
    return terminal ? (askTerminal(terminal, `${question} [${fallback}]${msg(": ")}`) ?? "").trim() || fallback : fallback;
  };
  const privateFile = (path: string, content: string) => atomicFile(path, content, 0o600, true, fs);
  const configPath = join(home, ".config/lumio/config.json");
  const old = await optional(configPath, fs);
  let previous: CliConfig | undefined;
  if (old) {
    try { previous = CliConfig.parse(JSON.parse(old)); }
    catch { throw new HubError("INVALID", { key: "setup.could_not_parse_existing_cli_configuration_repair_config_json_first", args: [] }); }
  }
  const defaultVault = join(home, ".config/lumio/vault");
  const chosenVault = options.vault ?? await ask(msg("setup.vault_path"), previous?.vault ?? defaultVault);
  const vault = chosenVault === "~" ? home : resolve(chosenVault.startsWith("~/") ? join(home, chosenVault.slice(2)) : chosenVault);
  try {
    if (!(await fs.stat(vault)).isDirectory()) throw new HubError("INVALID", { key: "setup.vault_must_be_a_directory", args: [] });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || vault !== defaultVault) throw new HubError("INVALID", { key: "setup.the_specified_vault_directory_does_not_exist_or_cannot_be_read", args: [] });
    await fs.mkdir(vault, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(vault, "README.md"), msg("setup.lumio_vault_markdown_notes_live_here_see_https_github_com_wicsp_lumi"), { flag: "wx" });
  }
  const state = resolve(env.LUMIO_STATE_DIR ?? join(home, ".local/share/lumio"));
  await fs.mkdir(state, { recursive: true, mode: 0o700 }); await fs.chmod(state, 0o700);
  const envFile = join(home, ".config/lumio/hub.env");
  const previousEnv = parseEnvironment(await optional(envFile, fs) ?? "");
  let listen = env.LUMIO_HUB_LISTEN ?? previousEnv.LUMIO_HUB_LISTEN ?? "127.0.0.1:7420";
  let publicUrl = options.publicUrl ?? env.LUMIO_PUBLIC_URL ?? previousEnv.LUMIO_PUBLIC_URL ?? "";
  if (options.server) {
    listen = await ask(msg("setup.listen_address"), env.LUMIO_HUB_LISTEN ?? (previousEnv.LUMIO_PUBLIC_URL ? listen : "0.0.0.0:7420"));
    publicUrl = await ask(msg("setup.public_url_e_g_https_lumio_example_org"), publicUrl);
  }
  const tailscale = find("tailscale");
  // Tailscale 只是补充（ADR 0022）：只在服务器模式下询问；单机模式用 --public-url 直接设置对外地址。
  if (options.server && options.publicUrl === undefined && tailscale && (await ask(msg("setup.use_tailscale_for_the_public_url_yes_no"), "no")) === "yes") {
    const mode = await ask(msg("setup.tailscale_mode_serve_ip"), "serve");
    const result = await run([tailscale, "status", "--json"]);
    let status: { Self?: { DNSName?: string; TailscaleIPs?: string[] } };
    try { if (result.code) throw new Error(); status = JSON.parse(result.stdout); }
    catch { throw new HubError("INVALID", { key: "setup.could_not_read_tailscale_status_check_that_you_are_signed_in", args: [] }); }
    const port = listen.slice(listen.lastIndexOf(":") + 1);
    if (mode === "serve") {
      const dns = status.Self?.DNSName?.replace(/\.$/, "");
      if (!dns || (await run([tailscale, "serve", "--bg", port])).code) throw new HubError("INVALID", { key: "setup.could_not_start_tailscale_serve", args: [] });
      publicUrl = `https://${dns}`;
      listen = `127.0.0.1:${port}`;
    } else if (mode === "ip") {
      const ip = status.Self?.TailscaleIPs?.find((ip) => !ip.includes(":"));
      if (!ip) throw new HubError("INVALID", { key: "setup.tailscale_has_no_available_ipv4_address", args: [] });
      listen = `${ip}:${port}`; publicUrl = `http://${listen}`;
    } else throw new HubError("INVALID", { key: "setup.tailscale_mode_must_be_serve_or_ip", args: [] });
  }
  const config = readConfig({ ...env, LUMIO_VAULT: vault, LUMIO_STATE_DIR: state, LUMIO_HUB_LISTEN: listen, LUMIO_PUBLIC_URL: publicUrl });
  if (!interactive) log(msg("setup.configuration_vault_listen_public_url_tailscale_will_not_be_enabled", vault, listen, config.publicUrl ?? msg("setup.not_set")));
  if (!config.port) throw new HubError("INVALID", { key: "setup.setup_requires_a_fixed_non_zero_port", args: [] });
  // For a binding to one interface, the local client must use that interface as well.
  const localHost = ["0.0.0.0", "::"].includes(config.hostname) ? "127.0.0.1" : config.hostname;
  const url = `http://${localHost.includes(":") ? `[${localHost}]` : localHost}:${config.port}`;
  if (publicUrl.startsWith("http://") && !isLoopback(new URL(publicUrl).hostname)) log(msg("setup.warning_the_public_url_uses_http_tokens_will_travel_in_plain_text_co"));
  const store = await HubStore.open(state);
  let token: string, runtimeToken: string;
  const name = await rememberLocalRuntime(state, runtimeName(host));
  try {
    let human = store.actors().find((actor) => actor.role === "human");
    human ??= store.createActor("owner", "human");
    const runtime = store.actors().find((actor) => actor.name === name);
    if (runtime && runtime.role !== "runtime") throw new HubError("CONFLICT", { key: "setup.local_runtime_name_conflicts_with_an_existing_non_runtime_actor", args: [] });
    const localRuntime = runtime ?? store.createActor(name, "runtime");
    for (const old of store.tokens()) if (old.actor_id === localRuntime.id && !old.revoked) store.revokeToken(old.label);
    token = store.replaceToken(`cli@${host}`, human.name);
    runtimeToken = store.replaceToken(`runtime@${name}`, name);
  } finally { store.close(); }
  await privateFile(configPath, JSON.stringify(CliConfig.parse({ hub_url: url, token, vault }), null, 2) + "\n");
  const serviceEnv = { ...previousEnv, LUMIO_VAULT: vault, LUMIO_STATE_DIR: state, LUMIO_HUB_LISTEN: listen,
    PATH: [...new Set([dirname(find("git") ?? "/usr/bin/git"), env.PATH ?? "/usr/bin:/bin"])].join(":"),
    ...(config.publicUrl ? { LUMIO_PUBLIC_URL: config.publicUrl } : {}),
  };
  if (!config.publicUrl) delete serviceEnv.LUMIO_PUBLIC_URL;
  if (env.LUMIO_TRUSTED_PROXY) Object.assign(serviceEnv, { LUMIO_TRUSTED_PROXY: env.LUMIO_TRUSTED_PROXY });
  await privateFile(envFile, environmentText(serviceEnv));
  const diagnostics = { platform, uid: options.uid ?? process.getuid?.() ?? -1, run, find, fetch: fetcher };
  const report = (items: Awaited<ReturnType<typeof extraServices>>) => { for (const item of items) if (!item.ok || item.problem) log(`${item.name}${msg(": ")}${item.problem ?? ""}${item.fix ? `${msg("; ")}${item.fix}` : ""}`); };
  report(await extraServices(diagnostics));
  let managed = true;
  if (platform === "darwin") {
    const path = join(home, "Library/LaunchAgents/io.lumio.hub.plist");
    await atomicFile(path, hubPlist(binary, serviceEnv, state), 0o600, false, fs);
    if ((await run(["plutil", "-lint", path])).code) throw new HubError("INVALID", { key: "setup.hub_service_configuration_validation_failed", args: [] });
    const domain = `gui/${options.uid ?? process.getuid!()}`;
    await run(["launchctl", "bootout", domain, path]);
    if ((await run(["launchctl", "bootstrap", domain, path])).code) throw new HubError("INVALID", { key: "setup.hub_service_could_not_start_see_hub_err_log", args: [state] });
  } else {
    const path = join(home, ".config/systemd/user/lumio-hub.service");
    await atomicFile(path, hubUnit(binary, envFile), 0o644, false, fs);
    try { managed = (await run(["systemctl", "--user", "show-environment"])).code === 0; } catch { managed = false; }
    if (managed) {
      const active = (await run(["systemctl", "--user", "is-active", "--quiet", "lumio-hub.service"])).code === 0;
      for (const argv of [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "lumio-hub.service"], ...(active ? [["systemctl", "--user", "restart", "lumio-hub.service"]] : [])]) {
        if ((await run(argv)).code) throw new HubError("INVALID", { key: "setup.hub_service_could_not_start_run_journalctl_user_u_lumio_hub_n_30", args: [] });
      }
      let linger = "";
      try { linger = (await run(["loginctl", "show-user", env.USER ?? "", "-p", "Linger"])).stdout; } catch { /* hint below */ }
      if (!linger.includes("Linger=yes")) log(msg("setup.hub_will_stop_on_logout_ask_an_administrator_to_run_loginctl_enable", env.USER ?? msg("setup.username")));
    } else log(msg("setup.no_systemd_user_service_run_manually_set_a_set_a_nohup_hub_serve_hub", envFile.replaceAll("'", "'\\''"), binary.replaceAll("'", "'\\''"), state.replaceAll("'", "'\\''")));
  }
  if (managed) {
    const now = options.now ?? Date.now, sleep = options.sleep ?? Bun.sleep, until = now() + 20_000;
    let ready = false, otherHub: string | undefined;
    while (now() < until) {
      try {
        const health = await fetcher(`${url}/health`, { redirect: "error", signal: AbortSignal.timeout(1000) });
        const body = await health.json() as { ok?: boolean; version?: unknown };
        if (health.ok && body.ok) {
          const actual = healthVersion(body);
          if (actual !== version) { otherHub = actual; break; }
          const actors = await fetcher(`${url}/v1/actors`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(1000) });
          if (actors.ok) { ready = true; break; }
        }
      } catch { /* diagnose after the deadline */ }
      await sleep(500);
    }
    if (otherHub) throw new HubError("INVALID", { key: "setup.another_hub_is_on_port_hub_this_program_disable_the_old_service_and", args: [config.port, otherHub, version] });
    if (!ready) {
      const logPath = join(state, "hub.err.log");
      let errors = (await optional(logPath, fs) ?? "").slice(-8192);
      if (platform === "linux") { try { errors += (await run(["journalctl", "--user", "-u", "lumio-hub", "-n", "30", "--no-pager"])).stdout; } catch { /* use log path */ } }
      if (/EPERM|EACCES|Operation not permitted/i.test(errors)) throw new HubError("INVALID", platform === "darwin" ? { key: "setup.in_system_settings_privacy_security_full_disk_access_add_then_run_lu", args: [binary] } : { key: "setup.hub_cannot_read_the_vault_check_directory_permissions_log", args: [logPath] });
      if (/EADDRINUSE|address already in use/i.test(errors)) throw new HubError("INVALID", { key: "setup.port_is_in_use_stop_the_other_program_or_change_lumio_hub_listen_and", args: [config.port] });
      throw new HubError("INVALID", { key: "setup.hub_startup_timed_out_log", args: [platform === "linux" ? "journalctl --user -u lumio-hub -n 30" : logPath] });
    }
  }
  if (config.publicUrl) report(await publicHubChecks(diagnostics, config.publicUrl, version, config.port));
  const runtimeEnvFile = join(home, ".config/lumio-runtime/runtime.env");
  const runtimeEnv = { ...parseEnvironment(await optional(runtimeEnvFile, fs) ?? ""), LUMIO_HUB_URL: url, LUMIO_TOKEN: runtimeToken,
    LUMIO_RUNTIME_NAME: name, LUMIO_RUNTIME_STATE_DIR: join(home, ".local/share/lumio-runtime"), PATH: env.PATH ?? "/usr/bin:/bin" };
  await privateFile(runtimeEnvFile, environmentText(runtimeEnv));
  const installed = await run([runtimeBinary, "runtime", "install-service"]);
  if (installed.code) throw new HubError("INVALID", { key: "setup.local_runtime_installation_or_registration_failed_run_lumio_runtime", args: [runtimeEnv.LUMIO_RUNTIME_STATE_DIR] });
  // The installer only prints service status; keep credentials out even on child failure.
  for (const line of installed.stdout.split("\n").filter(Boolean)) if (!line.includes(token) && !line.includes(runtimeToken)) log(line);
  if (options.server) log(msg("setup.caddy_example_adjust_domain_and_listen_address_lumio_example_org_rev") + config.port + "\n}");
  log(msg("setup.vault_web_hub_logs_local_runtime_add_a_runtime_lumio_runtime_add_nam", vault, url, config.publicUrl ? msg("setup.public_url", config.publicUrl) : "", platform === "linux" ? "journalctl --user -u lumio-hub -u lumio-runtime" : state, name));
}

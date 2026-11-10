import { text as msg } from "./messages.ts";
import { createHash } from "node:crypto";
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { askTerminal, openTerminal } from "@lumio/platform";
import { HubSigningKey, RuntimeInfo, signingKeyFingerprint } from "@lumio/schema";
import { readConfig, RuntimeError } from "./config.ts";
import { environmentText, optionalFile } from "./pairing.ts";
import { parseEnvironment, privateFile, runCommand, type RunCommand } from "./service.ts";

import { sudoPaths, type SudoPaths } from "./sudo-paths.ts";
export type { SudoPaths } from "./sudo-paths.ts";

interface Account { name: string; uid: number; gid: number; home: string }
async function confirmFingerprint(): Promise<boolean> {
  const terminal = openTerminal();
  return terminal ? (askTerminal(terminal, msg("sudo-install.does_this_match_the_fingerprint_from_lumio_hub_signing_key_on_hub_ty")) ?? "").trim() === "yes" : false;
}
/** Runs as the runtime user, including when requested by the root installer. */
export async function configureSudoEnvironment(home: string, command?: string) {
  const file = join(home, ".config/lumio-runtime/runtime.env");
  const env = parseEnvironment(await readFile(file, "utf8"));
  if (command) env.LUMIO_RUNTIME_SUDO_COMMAND = command;
  else delete env.LUMIO_RUNTIME_SUDO_COMMAND;
  await privateFile(file, environmentText(env));
}
export async function installSudoHelper(args: string[], options: {
  platform?: string; uid?: number; env?: NodeJS.ProcessEnv; binary?: string; paths?: SudoPaths;
  run?: RunCommand; fetch?: typeof globalThis.fetch; log?: (line: string) => void;
  interactive?: boolean; confirm?: () => Promise<boolean>;
  /** Synthetic filesystem ownership only; never exposed as a command-line option. */
  owner?: number; group?: number;
} = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") throw new RuntimeError(msg("sudo-install.privileged_helper_supports_macos_and_linux"));
  if ((options.uid ?? process.getuid?.()) !== 0) throw new RuntimeError(msg("sudo-install.run_as_root_using_sudo_lumio_runtime_install_sudo_helper"));
  const env = options.env ?? process.env, user = env.SUDO_USER;
  if (!user || user === "root" || !/^[a-z_][a-z0-9_-]*\$?$/.test(user)) throw new RuntimeError(msg("sudo-install.a_valid_sudo_user_is_required_run_sudo_from_the_runtime_account"));
  if (args.length && !(args.length === 1 && args[0] === "--uninstall")) throw new RuntimeError(msg("sudo-install.usage_lumio_runtime_install_sudo_helper_uninstall"));
  const uninstall = args[0] === "--uninstall", run = options.run ?? runCommand, log = options.log ?? console.log;
  const entry = await run(platform === "darwin" ? ["/usr/bin/dscacheutil", "-q", "user", "-a", "name", user] : ["/usr/bin/getent", "passwd", user]);
  const fields = entry.stdout.trim().split(":");
  const value = (key: string) => entry.stdout.split("\n").find(line => line.startsWith(`${key}: `))?.slice(key.length + 2).trim();
  const account: Account = platform === "darwin"
    ? { name: value("name") ?? "", uid: Number(value("uid")), gid: Number(value("gid")), home: value("dir") ?? "" }
    : { name: fields.length === 7 ? fields[0]! : "", uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] ?? "" };
  if (entry.code || account.name !== user || !Number.isSafeInteger(account.uid) || account.uid <= 0 || !Number.isSafeInteger(account.gid) || account.gid < 0 || !isAbsolute(account.home)) throw new RuntimeError(msg("sudo-install.could_not_find_runtime_account_home_directory_and_uid"));
  const target = options.paths ?? sudoPaths(platform), owner = options.owner ?? 0, group = options.group ?? 0;
  const envFile = join(account.home, ".config/lumio-runtime/runtime.env");
  const runtimeEnv = parseEnvironment(await readFile(envFile, "utf8"));
  const source = options.binary ?? process.execPath;
  if (!uninstall && source === process.execPath && !Bun.main.startsWith("/$bunfs/")) throw new RuntimeError(msg("sudo-install.run_install_sudo_helper_using_the_program_installed_by_install_sh"));
  // Root never writes into a user-controlled directory. Update service files after dropping privileges.
  const asRuntime = platform === "darwin"
    ? ["/usr/bin/sudo", "-u", user, "--", "/usr/bin/env", "-i", `HOME=${account.home}`, `USER=${user}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin"]
    : ["/usr/sbin/runuser", "-u", user, "--", "/usr/bin/env", "-i", `HOME=${account.home}`, `USER=${user}`, "PATH=/usr/bin:/bin", `XDG_RUNTIME_DIR=/run/user/${account.uid}`];
  async function configure(command?: string) {
    const argv = [...asRuntime, uninstall ? source : target.binary, "--configure-sudo-helper", ...(command ? [command] : [])];
    if ((await run(argv)).code) throw new RuntimeError(msg("sudo-install.could_not_update_runtime_env_check_runtime_account_configuration_per"));
  }
  async function restart() {
    if (platform === "darwin") {
      // launchd embeds environment variables in the plist, so regenerate it before restarting.
      try { if ((await run([...asRuntime, source, "runtime", "install-service"])).code === 0) return; }
      catch { /* tell the human how to recover */ }
      log(msg("sudo-install.rerun_runtime_install_service_on_macos"));
      return;
    }
    try {
      if ((await run(["/usr/sbin/runuser", "-u", account.name, "--", "/usr/bin/env", `XDG_RUNTIME_DIR=/run/user/${account.uid}`, "systemctl", "--user", "restart", "lumio-runtime.service"])).code === 0) return;
    } catch { /* tell the human how to recover */ }
    log(msg("sudo-install.run_systemctl_user_restart_lumio_runtime_service_as_the_runtime_acco"));
  }
  async function safeDirectory(path: string, mode = 0o755) {
    try {
      const st = await lstat(path);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== owner || (st.mode & 0o022)) throw new RuntimeError(msg("sudo-install.unsafe_privileged_helper_installation_directory_permissions"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      await mkdir(path, { mode }); await chown(path, owner, group); await chmod(path, mode);
    }
  }
  async function safeParents(path: string) {
    const dirs: string[] = [];
    for (let dir = dirname(path); dir !== parse(dir).root; dir = dirname(dir)) { dirs.unshift(dir); if (options.owner !== undefined) break; }
    for (const dir of dirs) await safeDirectory(dir);
  }
  if (uninstall) {
    // Validate root-managed parent directories before removing anything; retain replay prevention data.
    for (const file of [target.binary, target.config, target.sudoers]) await safeParents(file);
    await configure();
    for (const file of [target.sudoers, target.config, target.binary]) await rm(file, { force: true });
    await restart(); log(msg("sudo-install.privileged_helper_uninstalled_used_credential_records_retained")); return;
  }
  if (!(options.interactive ?? Boolean(openTerminal()))) throw new RuntimeError(msg("sudo-install.an_interactive_terminal_is_required_to_verify_hub_public_key_fingerp"));
  const config = readConfig({ ...runtimeEnv, LUMIO_RUNTIME_STATE_DIR: runtimeEnv.LUMIO_RUNTIME_STATE_DIR ?? join(account.home, ".local/share/lumio-runtime") }), fetcher = options.fetch ?? globalThis.fetch;
  async function request<T>(path: string, schema: { parse(value: unknown): T }, body?: unknown): Promise<T> {
    try {
      const response = await fetcher(`${config.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: {
        Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      return schema.parse(await response.json());
    } catch { throw new RuntimeError(msg("sudo-install.could_not_verify_runtime_identity_and_signing_key_with_hub_helper_wa")); }
  }
  const key = await request("/v1/runtime/signing-key", HubSigningKey);
  const fingerprint = signingKeyFingerprint(createHash("sha256").update(Buffer.from(key.public_key, "base64url")).digest("hex"));
  if (fingerprint !== key.fingerprint) throw new RuntimeError(msg("sudo-install.hub_public_key_fingerprint_mismatch_helper_was_not_installed"));
  log(msg("sudo-install.hub_public_key_fingerprint", fingerprint));
  if (!await (options.confirm ?? confirmFingerprint)()) throw new RuntimeError(msg("sudo-install.fingerprint_not_confirmed_helper_was_not_installed"));
  const receipt = await optionalFile(join(config.stateDir, "registered.json"));
  const registration = receipt ? RuntimeInfo.parse(JSON.parse(receipt)).registration : config.registration;
  if (registration.name !== config.registration.name) throw new RuntimeError(msg("sudo-install.runtime_registration_name_does_not_match"));
  const info = await request("/v1/runtime/register", RuntimeInfo, registration);
  if (info.registration.name !== config.registration.name) throw new RuntimeError(msg("sudo-install.runtime_registration_name_does_not_match"));
  // Validate sudoers before installing any files. All paths are fixed in production.
  const stage = await mkdtemp(join(tmpdir(), "lumio-sudo-install-"));
  const sudoers = `${user} ALL=(root) NOPASSWD: ${target.binary} --sudo-helper\n`;
  try {
    const staged = join(stage, "sudoers"); await writeFile(staged, sudoers, { mode: 0o440 });
    if ((await run(["/usr/sbin/visudo", "-cf", staged])).code) throw new RuntimeError(msg("sudo-install.visudo_validation_failed_helper_was_not_installed"));
    for (const file of [target.binary, target.config, target.sudoers, join(target.state, "used")]) await safeParents(file);
    await chmod(target.state, 0o700);
    async function installFile(path: string, mode: number, content?: string) {
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        if (content === undefined) await copyFile(source, temp);
        else await writeFile(temp, content, { flag: "wx", mode });
        await chown(temp, owner, group); await chmod(temp, mode); await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
    }
    await installFile(target.binary, 0o755);
    await installFile(target.config, 0o644, JSON.stringify({ public_key: key.public_key, runtime: info.actor }) + "\n");
    // Install the validated sudoers content atomically on its destination filesystem.
    const temp = `${target.sudoers}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temp, sudoers, { flag: "wx", mode: 0o440 }); await chown(temp, owner, group); await chmod(temp, 0o440);
      await rename(temp, target.sudoers);
    } finally { await rm(temp, { force: true }); }
    await configure(`/usr/bin/sudo -n ${target.binary} --sudo-helper`);
    await restart(); log(msg("sudo-install.privileged_helper_installed"));
  } finally { await rm(stage, { recursive: true, force: true }); }
}

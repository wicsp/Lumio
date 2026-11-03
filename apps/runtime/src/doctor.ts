import { text as msg } from "./messages.ts";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { HubSigningKey } from "@lumio/schema";
import { ADAPTERS, versionSupported } from "./agents.ts";
import { readConfig } from "./config.ts";
import { diagnosticIO, environment, serviceCommand, type Check, type DiagnosticOptions } from "./diagnostics.ts";
import { parseVersion } from "./engines.ts";

export async function doctor(options: DiagnosticOptions & {
  which?: (command: string, path: string) => string | null;
  outbox?: (path: string) => Promise<number>;
} = {}): Promise<Check[]> {
  const io = diagnosticIO(options), checks: Check[] = [];
  const check = async (name: string, fix: string, action: () => Promise<void>) => {
    try { await action(); checks.push({ name, ok: true }); }
    catch { checks.push({ name, ok: false, problem: msg("doctor.check_failed"), fix }); }
  };
  const path = join(io.home, ".config/lumio-runtime/runtime.env");
  let saved: NodeJS.ProcessEnv = {}, config: ReturnType<typeof readConfig> | undefined;
  await check("runtime.env", msg("doctor.run_lumio_runtime_join_again_to_finish_pairing"), async () => { if (!(await io.stat(path)).isFile()) throw new Error(); });
  await check(msg("doctor.runtime_env_permissions_0600"), msg("doctor.set_config_lumio_runtime_runtime_env_permissions_to_0600"), async () => {
    if (((await io.stat(path)).mode & 0o777) !== 0o600) throw new Error();
  });
  await check(msg("doctor.runtime_configuration"), msg("doctor.check_hub_url_token_name_and_state_directory_in_runtime_env"), async () => {
    saved = environment(await io.read(path));
    const env = { ...saved, ...Object.fromEntries(Object.entries(io.env).filter(([, v]) => v !== undefined)) };
    config = readConfig({ ...env, LUMIO_RUNTIME_STATE_DIR: env.LUMIO_RUNTIME_STATE_DIR ?? join(io.home, ".local/share/lumio-runtime") });
  });
  await check(msg("doctor.hub_connection_and_authentication"), msg("doctor.check_network_and_token_pair_again_with_lumio_runtime_join_if_invali"), async () => {
    if (!config) throw new Error();
    const r = await io.fetch(`${config.url}/v1/runtime/signing-key`, { headers: { Authorization: `Bearer ${config.token}` } });
    if (!r.ok) throw new Error(); HubSigningKey.parse(await r.json());
  });
  await check(msg("doctor.runtime_background_service"), msg("doctor.run_lumio_runtime_install_service_see_service_logs"), async () => {
    if ((await io.run(serviceCommand(io.platform, io.uid, "runtime", "status"))).code !== 0) throw new Error();
  });
  if (io.platform === "linux") await check("linger", msg("doctor.ask_an_administrator_to_run_loginctl_enable_linger", io.env.USER ?? msg("setup.username")), async () => {
    const result = await io.run(["loginctl", "show-user", io.env.USER ?? String(io.uid), "-p", "Linger"]);
    if (result.code || result.stdout.trim() !== "Linger=yes") throw new Error();
  });
  for (const adapter of Object.values(ADAPTERS)) await check(`agent ${adapter.engine}（runtime.env PATH）`, msg("doctor.install_and_add_its_path_to_path_in_runtime_env_supported", adapter.command, adapter.versions.min, adapter.versions.below), async () => {
    const executable = (options.which ?? ((command, path) => Bun.which(command, { PATH: path })))(adapter.command, saved.PATH ?? "");
    if (!executable) throw new Error();
    const result = await io.run([executable, "--version"], { ...io.env, ...saved });
    const version = parseVersion(result.stdout.trim() || result.stderr.trim());
    if (result.code || !version) throw new Error();
    checks.push({ name: `${adapter.engine} ${version}`, ok: versionSupported(adapter, version),
      ...(!versionSupported(adapter, version) ? { problem: msg("doctor.outside_adapter_verified_version_range"), fix: msg("doctor.install_a_supported_version_or_verify_the_adapter_first", adapter.versions.min, adapter.versions.below) } : {}) });
  });
  await check(msg("doctor.state_directory_permissions_0700"), msg("doctor.set_runtime_state_directory_ownership_to_this_account_and_permission"), async () => {
    if (!config) throw new Error(); const s = await io.stat(config.stateDir);
    if (!s.isDirectory() || (s.mode & 0o777) !== 0o700 || s.uid !== io.uid) throw new Error();
  });
  await check(msg("doctor.pending_results"), msg("doctor.check_state_database_permissions_and_hub_connection_keep_database_fo"), async () => {
    if (!config) throw new Error();
    const outbox = options.outbox ?? (async (path: string) => {
      const db = new Database(path, { readonly: true });
      try { return db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM outbox").get()!.count; }
      finally { db.close(); }
    });
    const count = await outbox(join(config.stateDir, "runtime.sqlite"));
    checks.push({ name: msg("doctor.result_queue"), ok: true, problem: msg("doctor.results_pending", count), ...(count ? { fix: msg("doctor.keep_runtime_running_check_hub_connection_results_will_be_delivered") } : {}) });
  });
  if (config?.sudoCommand.length) {
    // sudo command includes launcher/options; validate the installed helper itself, not /usr/bin/sudo.
    const helper = config.sudoCommand.at(-1)!;
    await check(msg("doctor.privileged_helper_files"), msg("doctor.reinstall_with_sudo_lumio_runtime_install_sudo_helper"), async () => {
      const s = await io.stat(helper); if (!s.isFile() || s.uid !== 0 || (s.mode & 0o022)) throw new Error();
    });
    await check(msg("doctor.sudo_authorization"), msg("doctor.run_sudo_lumio_runtime_install_sudo_helper_to_repair_sudoers"), async () => {
      const r = await io.run(["sudo", "-n", "-l"]);
      if (r.code || !r.stdout.split("\n").some((line) => line.includes("NOPASSWD:") && line.trim().endsWith(helper))) throw new Error();
    });
  }
  return checks;
}

import { language } from "@lumio/platform";
import { text as msg } from "./messages.ts";
import { realpath } from "node:fs/promises";
import { extraServices, healthVersion, publicHubChecks } from "./hub-checks.ts";
import { join } from "node:path";
import { createClient } from "@lumio/api-client";
import { CliConfig } from "@lumio/schema";
import { diagnosticIO, environment, httpURL, localAddress, serviceCommand, type Check, type DiagnosticOptions } from "./diagnostics.ts";
import { version } from "./version.ts";

// Mirrors the runtime adapters without an app-to-app import. A parity test guards changes.
export const verifiedVersions = { codex: ["0.160.0", "0.200.0"], "claude-code": ["2.0.0", "3.0.0"], pi: ["1.4.0", "2.0.0"] } as const;
export function supported(engine: keyof typeof verifiedVersions, value: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!parts) return false;
  const compare = (other: string) => {
    const b = other.split(".").map(Number);
    for (let i = 0; i < 3; i++) { const d = Number(parts[i + 1]) - b[i]!; if (d) return Math.sign(d); }
    return 0;
  };
  return compare(verifiedVersions[engine][0]) >= 0 && compare(verifiedVersions[engine][1]) < 0;
}
export interface DoctorOptions extends DiagnosticOptions { realpath?: (path: string) => Promise<string> }
export async function doctor(options: DoctorOptions = {}): Promise<Check[]> {
  const io = diagnosticIO(options), checks: Check[] = [];
  const check = async (name: string, fix: string, action: () => Promise<void>) => {
    try { await action(); checks.push({ name, ok: true }); }
    catch { checks.push({ name, ok: false, problem: msg("doctor.check_failed"), fix }); }
  };
  const configPath = join(io.home, ".config/lumio/config.json");
  let file: Partial<CliConfig> = {};
  await check(msg("doctor.configuration_file"), msg("doctor.run_lumio_hub_setup_remote_cli_lumio_login"), async () => {
    if (!(await io.stat(configPath)).isFile()) throw new Error();
  });
  await check(msg("doctor.configuration_permissions_0600"), msg("doctor.set_config_lumio_config_json_permissions_to_0600"), async () => {
    if (((await io.stat(configPath)).mode & 0o777) !== 0o600) throw new Error();
  });
  await check(msg("doctor.configuration_format"), msg("doctor.run_lumio_hub_setup_or_lumio_login_again"), async () => {
    file = CliConfig.partial({ token: true }).parse(JSON.parse(await io.read(configPath)));
  });
  const url = io.env.LUMIO_HUB_URL ?? file.hub_url, token = io.env.LUMIO_TOKEN ?? file.token;
  let base: string | undefined;
  await check(msg("doctor.hub_url_and_token_configuration"), msg("doctor.run_lumio_hub_setup_or_lumio_login"), async () => {
    if (!url || !token) throw new Error(); base = httpURL(url).href.replace(/\/+$/, "");
  });
  let hubVersion = version;
  const client = createClient({ language: language(), url: base ?? "http://invalid", token, fetch: io.fetch });
  await check("Hub /health", msg("doctor.check_hub_service_url_and_network_run_lumio_hub_setup_to_repair_loca"), async () => {
    if (!base) throw new Error();
    const r = await io.fetch(`${base}/health`); const body = await r.json() as { ok?: boolean; version?: string };
    if (!r.ok || body.ok !== true || typeof body.version !== "string") throw new Error();
    hubVersion = healthVersion(body);
    checks.push({ name: msg("doctor.hub_version_cli", hubVersion, version), ok: hubVersion === version,
      ...(hubVersion !== version ? { problem: localAddress(new URL(base)) ? msg("doctor.another_hub_is_on_this_port_version_mismatch") : msg("doctor.version_mismatch"), fix: msg("doctor.run_lumio_upgrade") } : {}) });
  });
  await check(msg("doctor.hub_web_page"), msg("doctor.run_lumio_upgrade_to_update_hub_and_embedded_web_page"), async () => {
    if (!base) throw new Error();
    const response = await io.fetch(`${base}/`);
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html") || !(await response.text()).includes("/assets/app.js")) throw new Error();
  });
  await check(msg("doctor.hub_web_assets"), msg("doctor.run_lumio_upgrade_to_repair_web_assets"), async () => {
    if (!base) throw new Error();
    const response = await io.fetch(`${base}/assets/app.js`);
    if (!response.ok || !response.headers.get("content-type")?.includes("javascript") || !(await response.text()).trim()) throw new Error();
  });
  await check(msg("doctor.local_program_and_compatibility_links"), msg("doctor.run_lumio_upgrade_again_to_repair_compatibility_links_and_versions"), async () => {
    const bin = join(io.home, ".local/bin"), resolve = options.realpath ?? realpath;
    const program = await resolve(join(bin, "lumio"));
    for (const name of ["lumio", "lumio-hub", "lumio-runtime"]) {
      if (await resolve(join(bin, name)) !== program) throw new Error();
      const result = await io.run([join(bin, name), "--version"]);
      if (result.code || result.stdout.trim().replace(/^v/, "") !== version) throw new Error();
    }
  });
  await check(msg("doctor.hub_token"), msg("doctor.run_lumio_login_again_or_lumio_hub_setup"), async () => { if (!base) throw new Error(); await client.actors(); });
  await check(msg("doctor.vault_status"), msg("doctor.check_hub_read_write_permissions_on_vault_and_see_hub_logs"), async () => {
    if (!base) throw new Error();
    const r = await io.fetch(`${base}/v1/status`, { headers: { "Accept-Language": language(), Authorization: `Bearer ${token}` } });
    const status = await r.json() as { watching?: boolean; issues?: unknown };
    if (!r.ok || status.watching !== true || !Array.isArray(status.issues) || !status.issues.every((s) => typeof s === "string")) throw new Error();
    for (const issue of status.issues as string[]) checks.push({ name: msg("doctor.hub_issue"), ok: false, problem: issue, fix: msg("doctor.repair_the_note_or_vault_permissions_as_instructed_see_hub_logs") });
  });
  if (base && localAddress(new URL(base))) {
    let assistant: Record<string, string> = {};
    try { assistant = environment(await io.read(join(io.home, ".config/lumio/hub.env"))); } catch { /* unmanaged Hub */ }
    const configured = Boolean(assistant.LUMIO_ASSISTANT_BASE_URL && assistant.LUMIO_ASSISTANT_MODEL);
    checks.push({ name: msg("doctor.assistant_model"), ok: true, warning: !configured, problem: configured ? msg("doctor.configured") : msg("doctor.not_configured"), ...(!configured ? { fix: msg("doctor.run_lumio_hub_assistant_setup") } : {}) });
    checks.push(...await extraServices(io));
    for (const service of ["hub", "runtime"] as const) await check(msg("doctor.local_background_service", service), msg("doctor.run_lumio_hub_setup_service_is_not_running", service), async () => {
      if ((await io.run(serviceCommand(io.platform, io.uid, service, "status"))).code !== 0) throw new Error();
    });
  }
  let publicUrl = io.env.LUMIO_PUBLIC_URL;
  if (!publicUrl && base && localAddress(new URL(base))) {
    try { publicUrl = environment(await io.read(join(io.home, ".config/lumio/hub.env"))).LUMIO_PUBLIC_URL; } catch { /* no local Hub configuration */ }
  }
  if (publicUrl) {
    try {
      const u = httpURL(publicUrl);
      if (u.protocol === "http:" && !localAddress(u)) checks.push({ name: msg("doctor.public_url_warning"), ok: true, warning: true, problem: msg("doctor.non_local_address_uses_http"), fix: msg("doctor.configure_an_https_reverse_proxy_or_use_a_trusted_private_network") });
      checks.push(...await publicHubChecks(io, publicUrl, hubVersion, base ? Number(new URL(base).port || (new URL(base).protocol === "https:" ? 443 : 80)) : 7420));
    } catch { checks.push({ name: msg("doctor.public_url_health"), ok: false, problem: msg("doctor.invalid_url"), fix: msg("doctor.check_lumio_public_url") }); }
  }
  await check(msg("doctor.runtime_list"), msg("doctor.check_hub_authentication_register_a_runtime_with_lumio_runtime_add"), async () => {
    if (!base) throw new Error(); const runtimes = await client.runtimes();
    if (!runtimes.length) checks.push({ name: msg("doctor.runtime"), ok: false, problem: msg("doctor.no_registered_runtimes"), fix: msg("doctor.run_lumio_hub_setup_or_lumio_runtime_add_name") });
    for (const r of runtimes) {
      checks.push({ name: msg("doctor.runtime_2", r.registration.name), ok: r.online, problem: msg("doctor.last_seen", r.last_seen, r.online ? "" : msg("doctor.offline")),
        ...(!r.online ? { fix: msg("doctor.run_lumio_runtime_doctor_on_the_server") } : {}) });
      if (!r.registration.engines.length) checks.push({ name: `${r.registration.name} agent`, ok: false, problem: msg("doctor.no_agent_detected"), fix: msg("doctor.install_an_agent_update_path_in_runtime_env_and_restart_runtime") });
      for (const e of r.registration.engines) checks.push({ name: `${r.registration.name} ${e.name} ${e.version}`, ok: supported(e.name, e.version),
        ...(!supported(e.name, e.version) ? { problem: msg("doctor.outside_adapter_verified_version_range"), fix: msg("doctor.install_version_or_verify_the_adapter_first", e.name, verifiedVersions[e.name].join(", ")) } : {}) });
    }
  });
  await check(msg("doctor.routines"), msg("doctor.run_lumio_routine_list_to_inspect_and_repair_schedules"), async () => {
    if (!base) throw new Error();
    for (const r of await client.routines()) if (r.problem) checks.push({ name: msg("doctor.routine", r.routine.title), ok: false, problem: r.problem, fix: msg("doctor.repair_routine_configuration_and_check_again") });
  });
  await check(msg("doctor.pending_proposals"), msg("doctor.run_lumio_proposals"), async () => {
    if (!base) throw new Error(); const pending = await client.proposals();
    if (pending.length) checks.push({ name: msg("doctor.proposal_reminder"), ok: true, warning: true, problem: msg("doctor.pending_approvals", pending.length), fix: msg("doctor.run_lumio_proposals") });
  });
  return checks;
}

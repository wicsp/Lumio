import { type Text, untranslated } from "./language.ts";
// Pairing transport takes the caller version and display callback explicitly.
export class PairingError extends Error {
  readonly code = "PAIRING_FAILED";
  constructor(public readonly params: { key: string; args: readonly unknown[] }) { super("PAIRING_FAILED"); this.name = "PairingError"; }
}
function networkReason(cause: unknown): { key: string; args: readonly unknown[] } {
  const e = cause as { name?: string; code?: string; cause?: { code?: string } };
  const code = `${e?.code ?? ""} ${e?.cause?.code ?? ""}`;
  if (/ENOTFOUND|EAI_AGAIN|DNS/.test(code)) return { key: "pairing-feedback.dns_resolution_failed", args: [] };
  if (e?.name === "TimeoutError" || /TIMEDOUT|TIMEOUT/.test(code)) return { key: "pairing-feedback.connection_timed_out", args: [] };
  if (/TLS|SSL|CERT|UNABLE_TO_VERIFY|SELF_SIGNED/.test(code)) return { key: "pairing-feedback.tls_certificate_or_handshake_failed", args: [] };
  return { key: "pairing-feedback.could_not_connect_to_hub", args: [] };
}
export function createPairer(version: string, msg: Text = untranslated) {
return async function pair<T>(base: string, code: string, kind: "client" | "runtime", schema: { parse(value: unknown): T }, fetcher = globalThis.fetch, warn: (line: string) => void = () => {}): Promise<T> {
  const label = { key: kind === "runtime" ? "pairing-feedback.runtime_pairing_failed" : "pairing-feedback.cli_login_failed", args: [] };
  const upgradeRequired = (hub: string) => new PairingError({ key: "pairing-feedback.hub_is_is_upgrade_hub_first", args: [label, hub, kind === "runtime" ? { key: "doctor.runtime", args: [] } : "CLI", version] });
  let hubVersion: string;
  async function request(path: string, init?: RequestInit) {
    try { return await fetcher(new URL(`${base}${path}`), { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
    catch (cause) { throw new PairingError({ key: "pairing-feedback.check_url_tailscale_and_proxy_no_proxy", args: [label, networkReason(cause)] }); }
  }
  const health = await request("/health");
  if (!health.ok) throw new PairingError({ key: "pairing-feedback.health_http", args: [label, health.status] });
  try {
    const body = await health.json() as { ok?: boolean; version?: unknown };
    if (body.ok !== true || typeof body.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(body.version)) throw new Error();
    hubVersion = body.version;
  } catch { throw new PairingError({ key: "pairing-feedback.hub_returned_an_invalid_response_health", args: [label] }); }
  if (hubVersion !== version) warn(msg("Warning: Hub is ${0}, this program is ${1}; keep versions consistent", hubVersion, version));
  const response = await request(`/v1/${kind}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  if (response.status === 404) throw upgradeRequired(hubVersion);
  if (response.status === 401) throw new PairingError({ key: "pairing-feedback.pairing_code_invalid_expired_or_used_run_again", args: [label, kind === "runtime" ? { key: "pairing-feedback.lumio_runtime_add_name", args: [] } : "lumio login-code"] });
  if (!response.ok) throw new PairingError({ key: "pairing-feedback.http", args: [label, response.status] });
  try { return schema.parse(await response.json()); }
  catch { throw new PairingError({ key: "pairing-feedback.hub_returned_an_invalid_response", args: [label] }); }
};
}

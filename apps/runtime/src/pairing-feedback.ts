import { version } from "./version.ts";

// Identical in CLI/runtime: apps must not import one another.
export class PairingError extends Error { readonly code = "PAIRING_FAILED"; }
function networkReason(cause: unknown): string {
  const e = cause as { name?: string; code?: string; cause?: { code?: string } };
  const code = `${e?.code ?? ""} ${e?.cause?.code ?? ""}`;
  if (/ENOTFOUND|EAI_AGAIN|DNS/.test(code)) return "DNS 解析失败";
  if (e?.name === "TimeoutError" || /TIMEDOUT|TIMEOUT/.test(code)) return "连接超时";
  if (/TLS|SSL|CERT|UNABLE_TO_VERIFY|SELF_SIGNED/.test(code)) return "TLS 证书或握手失败";
  return "无法连接 Hub";
}
export async function pair<T>(base: string, code: string, kind: "client" | "runtime", schema: { parse(value: unknown): T }, fetcher = globalThis.fetch, warn: (line: string) => void = console.error): Promise<T> {
  const label = kind === "runtime" ? "执行器配对失败" : "CLI 登录失败";
  const upgradeRequired = (hub: string) => new PairingError(`${label}：Hub 是 ${hub}，${kind === "runtime" ? "执行器" : "CLI"}是 ${version}，请先升级 Hub`);
  let hubVersion: string;
  async function request(path: string, init?: RequestInit) {
    try { return await fetcher(new URL(`${base}${path}`), { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
    catch (cause) { throw new PairingError(`${label}：${networkReason(cause)}；请检查地址、Tailscale、代理（no_proxy）`); }
  }
  const health = await request("/health");
  if (!health.ok) throw new PairingError(`${label}：/health HTTP ${health.status}`);
  try {
    const body = await health.json() as { ok?: boolean; version?: unknown };
    if (body.ok !== true || typeof body.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(body.version)) throw new Error();
    hubVersion = body.version;
  } catch { throw new PairingError(`${label}：Hub 返回了不合法的响应（/health）`); }
  if (hubVersion !== version) warn(`警告：Hub 是 ${hubVersion}，本程序是 ${version}，建议保持一致`);
  const response = await request(`/v1/${kind}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  if (response.status === 404) throw upgradeRequired(hubVersion);
  if (response.status === 401) throw new PairingError(`${label}：配对码无效、过期或已用，请重新运行 ${kind === "runtime" ? "lumio runtime add <名称>" : "lumio login-code"}`);
  if (!response.ok) throw new PairingError(`${label}：HTTP ${response.status}`);
  try { return schema.parse(await response.json()); }
  catch { throw new PairingError(`${label}：Hub 返回了不合法的响应`); }
}

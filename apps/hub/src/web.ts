import { ApiError } from "@lumio/schema";
import { HubError } from "./errors.ts";

export interface HubWeb {
  files: ReadonlyMap<string, { body: string | Uint8Array; type: string }>;
  csp: string;
}
export function browserOrigins(input: string | undefined): string[] {
  return (input ?? "").split(",").map(value => value.trim()).filter(Boolean).map(value => {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
      return url.origin;
    } catch { throw new HubError("INVALID", "LUMIO_WEB_ORIGINS 必须是逗号分隔的 HTTP(S) 来源，不含路径、凭据、查询或片段"); }
  });
}
/** Browser-only defense in depth. CLI and Runtime continue to authenticate via their existing tokens. */
export function browserAllowed(request: Request, config: { hostname: string; publicUrl?: string | undefined; webOrigins?: string[] | undefined }, port: number): boolean {
  if (!request.headers.has("origin") && !request.headers.has("sec-fetch-site")) return true;
  const hosts = ["0.0.0.0", "::"].includes(config.hostname) ? ["127.0.0.1", "localhost", "[::1]"] : [config.hostname.includes(":") ? `[${config.hostname}]` : config.hostname];
  if (config.hostname === "127.0.0.1" || config.hostname === "localhost") hosts.push("127.0.0.1", "localhost");
  const origins = new Set([...hosts.map(host => new URL(`http://${host}:${port}`).origin), ...(config.publicUrl ? [new URL(config.publicUrl).origin] : []), ...(config.webOrigins ?? [])]);
  const allowedHosts = new Set([...origins].map(origin => new URL(origin).host));
  const host = request.headers.get("host"), origin = request.headers.get("origin");
  return Boolean(host && allowedHosts.has(host.toLowerCase()) && (origin === null || origins.has(origin)));
}
export function browserDenied(): Response {
  return Response.json(ApiError.parse({ error: { code: "FORBIDDEN", message: "浏览器来源或 Host 未获允许" } }), { status: 403 });
}
export function webResponse(response: Response, csp?: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY"); headers.set("X-Content-Type-Options", "nosniff"); headers.set("Referrer-Policy", "no-referrer");
  if (csp) headers.set("Content-Security-Policy", csp);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

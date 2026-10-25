import { stat } from "node:fs/promises";
import { isIP } from "node:net";
import { CoreError, noteLinks, searchNotes, showNote, type SearchOptions } from "@lumio/core";
import { ApiError, NOTE_TYPES, type ApiErrorCode } from "@lumio/schema";
import { version } from "../package.json";
import { authorize } from "./authorize.ts";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { HubStore, type Identity } from "./store.ts";

// Routes share authentication, authorization and logging before dispatch.
export const ROUTES = [
  { operation: "health", pattern: /^\/health$/ },
  { operation: "search", pattern: /^\/v1\/search$/ },
  { operation: "links", pattern: /^\/v1\/notes\/([^/]+)\/links$/ },
  { operation: "show", pattern: /^\/v1\/notes\/([^/]+)$/ },
] as const;
const STATUS: Record<ApiErrorCode, number> = { INVALID: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INTERNAL: 500 };

export async function startHub(config: HubConfig, options: {
  log?: (line: string) => void;
  authorize?: typeof authorize;
} = {}) {
  if (!(await stat(config.vault)).isDirectory()) throw new HubError("INVALID", "LUMIO_VAULT 必须是目录");
  const store = await HubStore.open(config.stateDir);
  const log = options.log ?? console.log;
  const decide = options.authorize ?? authorize;
  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      hostname: config.hostname, port: config.port,
      async fetch(request, server) {
        const start = performance.now();
        const time = new Date().toISOString();
        const url = new URL(request.url);
        let identity: Identity | null = null;
        let status = 500;
        // Logging uses route templates, so references (or secrets in a URL) cannot leak.
        const route = ROUTES.find((route) => request.method === "GET" && route.pattern.test(url.pathname));
        const path = route?.operation === "health" ? "/health" : route?.operation === "search" ? "/v1/search"
          : route?.operation === "show" ? "/v1/notes/<reference>" : route?.operation === "links" ? "/v1/notes/<reference>/links" : "<unmatched>";
        let clientIp = server.requestIP(request)?.address ?? null;
        if (config.trustedProxy && clientIp === config.trustedProxy) {
          const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
          if (forwarded && isIP(forwarded)) clientIp = forwarded;
        }
        try {
          if (route?.operation !== "health") {
            identity = store.authenticate(request.headers.get("authorization"));
            if (!identity) throw new HubError("UNAUTHENTICATED", "需要有效的 Bearer 令牌");
          }
          if (!route) throw new HubError("NOT_FOUND", "找不到端点");
          const privateValue = url.searchParams.get("include_private");
          const includePrivate = privateValue === "true";
          const decision = decide(identity?.actor ?? null, { operation: route.operation, includePrivate: route.operation === "health" ? false : includePrivate });
          if (decision.result !== "allow") {
            if (identity && route.operation !== "health") store.auditDenied(identity, route.operation);
            status = 403;
            return Response.json(ApiError.parse({ error: { code: "FORBIDDEN", message: "请求未获授权", reason: decision.result === "deny" ? decision.reason : "Approval required" } }), { status });
          }
          if (route.operation === "health") { status = 200; return Response.json({ ok: true, version }); }
          if (privateValue !== null && privateValue !== "true" && privateValue !== "false") throw new HubError("INVALID", "include_private 必须是 true 或 false");
          const queryOptions: SearchOptions = { stateDir: config.stateDir, includePrivate };
          let result: unknown;
          if (route.operation === "search") {
            const type = url.searchParams.get("type");
            const limit = url.searchParams.get("limit");
            if (type !== null && !NOTE_TYPES.includes(type as SearchOptions["type"] & string)) throw new HubError("INVALID", "未知笔记类型");
            if (limit !== null && (!/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit)))) throw new HubError("INVALID", "limit 必须是正整数");
            result = await searchNotes(config.vault, url.searchParams.get("q") ?? "", {
              ...queryOptions, ...(type !== null ? { type: type as SearchOptions["type"] } : {}), ...(limit !== null ? { limit: Number(limit) } : {}),
            });
          } else {
            let reference: string;
            try { reference = decodeURIComponent(route.pattern.exec(url.pathname)![1]!); }
            catch { throw new HubError("INVALID", "引用 URL 编码不合法"); }
            result = await (route.operation === "show" ? showNote : noteLinks)(config.vault, reference, queryOptions);
          }
          status = 200;
          return Response.json(result);
        } catch (cause) {
          let code: ApiErrorCode = "INTERNAL", message = "Hub 无法处理请求";
          if (cause instanceof HubError) { code = cause.code; message = cause.message; }
          else if (cause instanceof CoreError) {
            if (cause.code === "NOTE_NOT_FOUND") { code = "NOT_FOUND"; message = cause.message; }
            else if (["INVALID_QUERY", "INVALID_LIMIT", "AMBIGUOUS_REFERENCE"].includes(cause.code)) { code = "INVALID"; message = cause.message; }
          }
          status = STATUS[code];
          return Response.json(ApiError.parse({ error: { code, message } }), { status });
        } finally {
          log(JSON.stringify({ time, actor_id: identity?.actor.id ?? null, token_label: identity?.label ?? null,
            method: request.method, path, status, duration_ms: performance.now() - start, client_ip: clientIp }));
        }
      },
    });
  } catch (cause) { store.close(); throw cause; }
  return { server, store, async stop() { await server.stop(true); store.close(); } };
}

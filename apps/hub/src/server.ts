import { stat } from "node:fs/promises";
import { isIP } from "node:net";
import { CoreError, checkLinks, noteLinks, searchNotes, showNote, type SearchOptions } from "@lumio/core";
import { ApiError, NOTE_TYPES, type ApiErrorCode } from "@lumio/schema";
import { version } from "../package.json";
import { startVaultWatch, type WatchOptions } from "./watch.ts";
import { handleOperation, type OperationOptions } from "./operations.ts";
import { handleJobs } from "./jobs.ts";
import { handleRuntime } from "./runtime.ts";
import { authorize } from "./authorize.ts";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { HubStore, type Identity } from "./store.ts";
import { Jobs } from "./jobs.ts";
import { TaskRounds, type TaskOptions } from "./tasks.ts";

// Routes share authentication, authorization and logging before dispatch.
export const ROUTES = [
  { operation: "job.submit", method: "POST", pattern: /^\/v1\/jobs$/ },
  { operation: "jobs", method: "GET", pattern: /^\/v1\/jobs$/ },
  { operation: "job.show", method: "GET", pattern: /^\/v1\/jobs\/([^/]+)$/ },
  { operation: "job.cancel", method: "POST", pattern: /^\/v1\/jobs\/([^/]+)\/cancel$/ },
  { operation: "runtime.ack", method: "POST", pattern: /^\/v1\/runtime\/ack$/ },
  { operation: "runtime.results", method: "POST", pattern: /^\/v1\/runtime\/results$/ },
  { operation: "runtime.register", method: "POST", pattern: /^\/v1\/runtime\/register$/ },
  { operation: "runtime.sync", method: "POST", pattern: /^\/v1\/runtime\/sync$/ },
  { operation: "runtimes", method: "GET", pattern: /^\/v1\/runtimes$/ },
  { operation: "operations", method: "POST", pattern: /^\/v1\/operations$/ },
  { operation: "actors", method: "GET", pattern: /^\/v1\/actors$/ },
  { operation: "proposals", method: "GET", pattern: /^\/v1\/proposals$/ },
  { operation: "proposal.accept", method: "POST", pattern: /^\/v1\/proposals\/([^/]+)\/accept$/ },
  { operation: "proposal.reject", method: "POST", pattern: /^\/v1\/proposals\/([^/]+)\/reject$/ },
  { operation: "status", pattern: /^\/v1\/status$/ },
  { operation: "health", pattern: /^\/health$/ },
  { operation: "search", pattern: /^\/v1\/search$/ },
  { operation: "check", pattern: /^\/v1\/check$/ },
  { operation: "links", pattern: /^\/v1\/notes\/([^/]+)\/links$/ },
  { operation: "show", pattern: /^\/v1\/notes\/([^/]+)$/ },
] as const;
const STATUS: Record<ApiErrorCode, number> = { INVALID: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INTERNAL: 500 };

export async function startHub(config: HubConfig, options: {
  log?: (line: string) => void;
  now?: () => Date;
  authorize?: typeof authorize;
  watch?: WatchOptions;
  operations?: OperationOptions;
  tasks?: TaskOptions;
} = {}) {
  if (!(await stat(config.vault)).isDirectory()) throw new HubError("INVALID", "LUMIO_VAULT 必须是目录");
  const store = await HubStore.open(config.stateDir);
  const log = options.log ?? console.log;
  const decide = options.authorize ?? authorize;
  let server: Bun.Server<undefined>;
  let vaultWatch: Awaited<ReturnType<typeof startVaultWatch>> | undefined;
  let tasks: TaskRounds | undefined;
  try {
    vaultWatch = await startVaultWatch(config, { ...options.watch, log,
      onNote: async (path) => { await options.watch?.onNote?.(path); await tasks?.noteChanged(path); } });
    const watch = vaultWatch;
    tasks = new TaskRounds(config, store, new Jobs(store), (action) => watch.exclusive(action), (path, line) => watch.issue(path, line), options.tasks);
    await watch.exclusive(() => tasks!.start());
    server = Bun.serve({
      hostname: config.hostname, port: config.port,
      async fetch(request, server) {
        const start = performance.now();
        const time = new Date().toISOString();
        const url = new URL(request.url);
        let identity: Identity | null = null;
        let status = 500;
        // Logging uses route templates, so references (or secrets in a URL) cannot leak.
        const route = ROUTES.find((route) => request.method === ("method" in route ? route.method : "GET") && route.pattern.test(url.pathname));
        const path = route?.operation === "job.submit" || route?.operation === "jobs" ? "/v1/jobs" : route?.operation === "job.show" ? "/v1/jobs/<id>" : route?.operation === "job.cancel" ? "/v1/jobs/<id>/cancel" : route?.operation === "runtime.ack" ? "/v1/runtime/ack" : route?.operation === "runtime.results" ? "/v1/runtime/results" : route?.operation === "runtime.register" ? "/v1/runtime/register" : route?.operation === "runtime.sync" ? "/v1/runtime/sync" : route?.operation === "runtimes" ? "/v1/runtimes" : route?.operation === "status" ? "/v1/status" : route?.operation === "health" ? "/health" : route?.operation === "search" ? "/v1/search"
          : route?.operation === "check" ? "/v1/check" : route?.operation === "show" ? "/v1/notes/<reference>" : route?.operation === "links" ? "/v1/notes/<reference>/links" : route?.operation === "operations" ? "/v1/operations"
            : route?.operation === "actors" ? "/v1/actors" : route?.operation === "proposals" ? "/v1/proposals"
              : route?.operation === "proposal.accept" ? "/v1/proposals/<id>/accept" : route?.operation === "proposal.reject" ? "/v1/proposals/<id>/reject" : "<unmatched>";
        let clientIp = server.requestIP(request)?.address ?? null;
        if (config.trustedProxy && clientIp === config.trustedProxy) {
          const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
          if (forwarded && isIP(forwarded)) clientIp = forwarded;
        }
        try {
          if (route?.operation === "health") identity = store.authenticate(request.headers.get("authorization"));
          if (route?.operation !== "health") {
            identity = store.authenticate(request.headers.get("authorization"));
            if (!identity) throw new HubError("UNAUTHENTICATED", "需要有效的 Bearer 令牌");
          }
          if (!route) throw new HubError("NOT_FOUND", "找不到端点");
          if (route.operation === "job.submit" || route.operation === "jobs" || route.operation === "job.show" || route.operation === "job.cancel") {
            const response = await handleJobs(request, route.operation, route.pattern.exec(url.pathname)?.[1], identity!, store, decide, (options.now ?? (() => new Date()))());
            status = response.status; return response;
          }
          if (route.operation === "runtime.register" || route.operation === "runtime.sync" || route.operation === "runtime.ack" || route.operation === "runtime.results" || route.operation === "runtimes") {
            const response = await handleRuntime(request, route.operation, identity!, store, decide, (options.now ?? (() => new Date()))());
            status = response.status;
            // 结果到了就尽快写回任务笔记（失败的留给定时任务重试）。
            if (route.operation === "runtime.results" && response.status === 200) void vaultWatch!.exclusive(() => tasks!.writeResults()).catch(() => {});
            return response;
          }
          // Reject runtime access before reading operation bodies or querying the vault.
          if (identity?.actor.role === "runtime" && ["operations", "actors", "proposals", "proposal.accept", "proposal.reject"].includes(route.operation)) {
            const decision = decide(identity.actor, { operation: route.operation });
            if (decision.result !== "allow") {
              store.auditDenied(identity, route.operation);
              throw new HubError("FORBIDDEN", "请求未获授权", { reason: decision.result === "deny" ? decision.reason : "Approval required" });
            }
          }
          if (route.operation === "operations" || route.operation === "actors" || route.operation === "proposals" || route.operation === "proposal.accept" || route.operation === "proposal.reject") {
            const response = await vaultWatch!.exclusive(() => handleOperation(request,
              route.operation,
              route.pattern.exec(url.pathname)?.[1], identity!, store, config, decide, { ...options.operations, tasks }));
            status = response.status;
            return response;
          }
          const privateValue = url.searchParams.get("include_private");
          const includePrivate = privateValue === "true";
          const decision = decide(identity?.actor ?? null, { operation: route.operation, includePrivate: route.operation === "health" ? false : includePrivate });
          if (decision.result !== "allow") {
            if (identity) store.auditDenied(identity, route.operation);
            status = 403;
            return Response.json(ApiError.parse({ error: { code: "FORBIDDEN", message: "请求未获授权", reason: decision.result === "deny" ? decision.reason : "Approval required" } }), { status });
          }
          if (route.operation === "health") { status = 200; return Response.json({ ok: true, version }); }
          if (privateValue !== null && privateValue !== "true" && privateValue !== "false") throw new HubError("INVALID", "include_private 必须是 true 或 false");
          const queryOptions: SearchOptions = { stateDir: config.stateDir, includePrivate };
          let result: unknown;
          if (route.operation === "status") {
            result = await vaultWatch!.status(includePrivate);
          } else if (route.operation === "check") {
            result = await checkLinks(config.vault, queryOptions);
          } else if (route.operation === "search") {
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
          let details: Omit<ApiError["error"], "code" | "message"> = {};
          if (cause instanceof HubError) { code = cause.code; message = cause.message; details = cause.details; }
          else if (cause instanceof CoreError) {
            if (cause.code === "NOTE_NOT_FOUND") { code = "NOT_FOUND"; message = cause.message; }
            else if (["INVALID_QUERY", "INVALID_LIMIT", "AMBIGUOUS_REFERENCE"].includes(cause.code)) { code = "INVALID"; message = cause.message; }
          }
          status = STATUS[code];
          return Response.json(ApiError.parse({ error: { code, message, ...details } }), { status });
        } finally {
          log(JSON.stringify({ time, actor_id: identity?.actor.id ?? null, token_label: identity?.label ?? null,
            method: request.method, path, status, duration_ms: performance.now() - start, client_ip: clientIp }));
        }
      },
    });
  } catch (cause) { tasks?.stop(); await vaultWatch?.stop(); store.close(); throw cause; }
  return { server, store, tasks: tasks!, async stop() { await server.stop(true); tasks?.stop(); await vaultWatch?.stop(); store.close(); } };
}

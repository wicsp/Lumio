import { AssistantChatRequest, WorkTask, WorkProject, WorkTaskDetail, ExecutionRoutine, ExecutionRoutineInfo, TaskStatus, idOf, type AssistantEvent } from "@lumio/schema";
import { AssistantError } from "@lumio/assistant";
import { WorkError } from "@lumio/work";
import type { BusinessModules } from "./modules.ts";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";
import type { authorize } from "./authorize.ts";

export const V2_ROUTES = [
  { operation: "work.read", method: "GET", pattern: /^\/v2\/work\/tasks$/, path: "/v2/work/tasks" },
  { operation: "work.read", method: "GET", pattern: /^\/v2\/work\/tasks\/(task_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/work/tasks/<id>" },
  { operation: "work.read", method: "GET", pattern: /^\/v2\/work\/projects$/, path: "/v2/work/projects" },
  { operation: "work.read", method: "GET", pattern: /^\/v2\/work\/projects\/(prj_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/work/projects/<id>" },
  { operation: "work.command", method: "POST", pattern: /^\/v2\/work\/commands$/, path: "/v2/work/commands" },
  { operation: "execution.read", method: "GET", pattern: /^\/v2\/execution\/routines$/, path: "/v2/execution/routines" },
  { operation: "execution.read", method: "GET", pattern: /^\/v2\/execution\/routines\/(rtn_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/execution/routines/<id>" },
  { operation: "execution.command", method: "POST", pattern: /^\/v2\/execution\/commands$/, path: "/v2/execution/commands" },
  { operation: "assistant.read", method: "GET", pattern: /^\/v2\/assistant\/conversations$/, path: "/v2/assistant/conversations" },
  { operation: "assistant.read", method: "GET", pattern: /^\/v2\/assistant\/conversations\/(conv_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/assistant/conversations/<id>" },
  { operation: "assistant.chat", method: "POST", pattern: /^\/v2\/assistant\/chat$/, path: "/v2/assistant/chat" },
] as const;
export type V2Route = (typeof V2_ROUTES)[number];

async function json(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { throw new HubError("INVALID", "请求体必须是 JSON"); }
}
export function moduleError(cause: unknown): HubError | undefined {
  if (cause instanceof WorkError || cause instanceof AssistantError) return new HubError(cause.code, cause.message);
}
export async function handleV2(request: Request, route: V2Route, identity: Identity, store: HubStore,
  modules: BusinessModules, decide: typeof authorize): Promise<Response> {
  const decision = decide(identity.actor, { operation: route.operation });
  let execution = "applied";
  let audited = false;
  try {
    if (decision.result !== "allow") throw new HubError("FORBIDDEN", "请求未获授权", { reason: decision.result === "deny" ? decision.reason : "需要批准" });
    const url = new URL(request.url), id = route.pattern.exec(url.pathname)?.[1];
    if (route.operation === "work.command" || route.operation === "execution.command") {
      const body = await json(request);
      const result = store.db.transaction(() => {
        const value = route.operation === "work.command" ? modules.work.command(body, identity.actor.id) : modules.routines.command(body, identity.actor.id);
        store.audit(identity, route.operation, decision.result, undefined, "applied");
        return value;
      })();
      audited = true; return Response.json(result);
    }
    if (route.operation === "execution.read") return Response.json(id ? ExecutionRoutine.parse(modules.routines.get(id)) : ExecutionRoutineInfo.array().parse(modules.routines.list()));
    if (route.operation === "work.read") {
      if (url.pathname.startsWith("/v2/work/projects")) return Response.json(id ? WorkProject.parse(modules.work.project(id)) : WorkProject.array().parse(modules.work.projects()));
      if (id) return Response.json(WorkTaskDetail.parse(modules.work.detail(id)));
      const status = url.searchParams.get("status"), project = url.searchParams.get("project"), query = url.searchParams.get("q");
      if (status !== null && !TaskStatus.safeParse(status).success) throw new HubError("INVALID", "任务状态不合法");
      if (project !== null && !idOf("prj").safeParse(project).success) throw new HubError("INVALID", "项目 ID 不合法");
      return Response.json(WorkTask.array().parse(modules.work.tasks({ status: status ?? undefined, project: project ?? undefined, query: query ?? undefined })));
    }
    if (route.operation === "assistant.read") return Response.json(id ? modules.assistant.detail(id, identity.actor.id) : modules.assistant.conversations(identity.actor.id));
    const parsed = AssistantChatRequest.safeParse(await json(request));
    if (!parsed.success) throw new HubError("INVALID", "助手请求参数不合法");
    const signal = AbortSignal.any([request.signal, modules.signal, AbortSignal.timeout(120_000)]);
    if (request.headers.get("accept")?.includes("application/x-ndjson")) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        let terminal = false;
        const event = (value: AssistantEvent) => {
          terminal ||= value.type === "result" || value.type === "error";
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        };
        void modules.assistant.chat(parsed.data, identity.actor.id, { signal, event })
          .then((result) => {
            if (!terminal) event(result.turn.status === "done" ? { type: "result", turn: result.turn.id, messages: result.messages }
              : { type: "error", turn: result.turn.id, error: result.turn.error ?? "这一轮仍在执行或结果不明，请查询对话" });
          })
          .catch(() => { /* The client can inspect the persisted turn after reconnecting. */ })
          .finally(() => { try { controller.close(); } catch { /* client disconnected */ } });
      } });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
    }
    return Response.json(await modules.assistant.chat(parsed.data, identity.actor.id, { signal }));
  } catch (cause) {
    const error = moduleError(cause);
    execution = error?.code ?? (cause instanceof HubError ? cause.code : "INTERNAL");
    throw error ?? cause;
  } finally {
    if (!audited && (!["work.read", "execution.read", "assistant.read"].includes(route.operation) || execution !== "applied" || decision.result !== "allow")) {
      store.audit(identity, route.operation, decision.result, undefined, execution);
    }
  }
}

import { text as msg } from "./messages.ts";
import { Id, KnowledgeAiNoteCommand, KnowledgeAiNoteResult, ResourceSummary, KnowledgeGraph, KnowledgeGraphArgs, AgentInfo, AgentTokenRequest, AgentRevokeRequest, AssistantChatRequest, WorkCommandRequest, ExecutionRoutineCommandRequest, RequestId, AssistantToolCall, capability, ExecutionRoutine, PlanTemplate, WorkCommandResult, type AssistantEvent, KnowledgeDeleteRequest, AssistantConversationDeleteRequest, TrashListArgs, TrashPurgeRequest, TrashRestoreRequest } from "@lumio/schema";
import { AssistantError } from "@lumio/assistant";
import { WorkError } from "@lumio/work";
import type { BusinessModules } from "./modules.ts";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";
import type { authorize } from "./authorize.ts";
import { handleArtifacts } from "./artifacts.ts";

export const V2_ROUTES = [
  { operation: "resource.read", method: "GET", pattern: /^\/v2\/resources\/([^/]+)$/, path: "/v2/resources/<id>" },
  { operation: "knowledge.ai-note", method: "POST", pattern: /^\/v2\/knowledge\/ai-note-commands$/, path: "/v2/knowledge/ai-note-commands" },
  { operation: "knowledge.graph", method: "GET", pattern: /^\/v2\/knowledge\/graph$/, path: "/v2/knowledge/graph" },
  { operation: "knowledge.delete", method: "DELETE", pattern: /^\/v2\/knowledge\/notes\/([a-z]+_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/knowledge/notes/<id>" },
  { operation: "assistant.delete", method: "DELETE", pattern: /^\/v2\/assistant\/conversations\/(conv_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/assistant/conversations/<id>" },
  { operation: "trash.list", method: "GET", pattern: /^\/v2\/trash$/, path: "/v2/trash" },
  { operation: "trash.restore", method: "POST", pattern: /^\/v2\/trash\/([a-z]+_[0-9A-HJKMNP-TV-Z]{26})\/restore$/, path: "/v2/trash/<id>/restore" },
  { operation: "trash.purge", method: "DELETE", pattern: /^\/v2\/trash\/([a-z]+_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/trash/<id>" },
  { operation: "execution.read", method: "GET", pattern: /^\/v2\/execution\/targets$/, path: "/v2/execution/targets" },
  { operation: "work.command", method: "POST", pattern: /^\/v2\/approval\/proposals\/(prop_[0-9A-HJKMNP-TV-Z]{26})\/withdraw$/, path: "/v2/approval/proposals/<id>/withdraw" },
  { operation: "notifications.push", method: "GET", pattern: /^\/v2\/notifications\/push\/key$/, path: "/v2/notifications/push/key" },
  { operation: "notifications.push", method: "GET", pattern: /^\/v2\/notifications\/push\/devices$/, path: "/v2/notifications/push/devices" },
  { operation: "notifications.push", method: "POST", pattern: /^\/v2\/notifications\/push\/devices$/, path: "/v2/notifications/push/devices" },
  { operation: "notifications.push", method: "PATCH", pattern: /^\/v2\/notifications\/push\/devices\/(pdev_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/notifications/push/devices/<id>" },
  { operation: "notifications.push", method: "DELETE", pattern: /^\/v2\/notifications\/push\/devices\/(pdev_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/notifications/push/devices/<id>" },
  { operation: "notifications.push", method: "POST", pattern: /^\/v2\/notifications\/push\/test$/, path: "/v2/notifications/push/test" },
  { operation: "agents.manage", method: "GET", pattern: /^\/v2\/agents$/, path: "/v2/agents" },
  { operation: "agents.manage", method: "POST", pattern: /^\/v2\/agents\/tokens$/, path: "/v2/agents/tokens" },
  { operation: "agents.manage", method: "POST", pattern: /^\/v2\/agents\/revoke$/, path: "/v2/agents/revoke" },
  { operation: "assistant.config", method: "GET", pattern: /^\/v2\/assistant\/config$/, path: "/v2/assistant/config" },
  { operation: "assistant.config", method: "PUT", pattern: /^\/v2\/assistant\/config$/, path: "/v2/assistant/config" },
  { operation: "assistant.config", method: "DELETE", pattern: /^\/v2\/assistant\/config$/, path: "/v2/assistant/config" },
  { operation: "assistant.read", method: "GET", pattern: /^\/v2\/assistant\/conversations\/(conv_[0-9A-HJKMNP-TV-Z]{26})\/tools$/, path: "/v2/assistant/conversations/<id>/tools" },
  { operation: "assistant.undo", method: "POST", pattern: /^\/v2\/assistant\/tools\/(tool_[0-9A-HJKMNP-TV-Z]{26})\/undo$/, path: "/v2/assistant/tools/<id>/undo" },
  { operation: "work.read", method: "GET", pattern: /^\/v2\/work\/attention$/, path: "/v2/work/attention" },
  { operation: "work.plan_templates.read", method: "GET", pattern: /^\/v2\/work\/plan-templates$/, path: "/v2/work/plan-templates" },
  { operation: "assistant.memory.read", method: "GET", pattern: /^\/v2\/assistant\/memories$/, path: "/v2/assistant/memories" },
  { operation: "assistant.memory.command", method: "POST", pattern: /^\/v2\/assistant\/memory-commands$/, path: "/v2/assistant/memory-commands" },
  { operation: "work.read", method: "GET", pattern: /^\/v2\/work\/tasks$/, path: "/v2/work/tasks" },
  { operation: "work.read", method: "GET", pattern: /^\/v2\/work\/tasks\/(task_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/work/tasks/<id>" },
  { operation: "work.read", method: "GET", pattern: /^\/v2\/work\/projects$/, path: "/v2/work/projects" },
  { operation: "work.read", method: "GET", pattern: /^\/v2\/work\/projects\/(prj_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/work/projects/<id>" },
  { operation: "work.command", method: "POST", pattern: /^\/v2\/work\/commands$/, path: "/v2/work/commands" },
  { operation: "execution.read", method: "GET", pattern: /^\/v2\/execution\/jobs$/, path: "/v2/execution/jobs" },
  { operation: "execution.read", method: "GET", pattern: /^\/v2\/execution\/jobs\/(job_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/execution/jobs/<job>" },
  { operation: "execution.read", method: "GET", pattern: /^\/v2\/execution\/routines$/, path: "/v2/execution/routines" },
  { operation: "execution.read", method: "GET", pattern: /^\/v2\/execution\/routines\/(rtn_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/execution/routines/<id>" },
  { operation: "execution.command", method: "POST", pattern: /^\/v2\/execution\/commands$/, path: "/v2/execution/commands" },
  { operation: "execution.read", method: "GET", pattern: /^\/v2\/execution\/jobs\/(job_[0-9A-HJKMNP-TV-Z]{26})\/artifacts$/, path: "/v2/execution/jobs/<job>/artifacts" },
  { operation: "execution.read", method: "GET", pattern: /^\/v2\/execution\/artifacts\/(art_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/execution/artifacts/<artifact>" },
  { operation: "execution.read", method: "GET", pattern: /^\/v2\/execution\/artifacts\/(art_[0-9A-HJKMNP-TV-Z]{26})\/content$/, path: "/v2/execution/artifacts/<artifact>/content" },
  { operation: "execution.archive", method: "POST", pattern: /^\/v2\/execution\/artifacts$/, path: "/v2/execution/artifacts" },
  { operation: "execution.archive", method: "PUT", pattern: /^\/v2\/execution\/artifacts\/(art_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/execution/artifacts/<artifact>" },
  { operation: "assistant.read", method: "GET", pattern: /^\/v2\/assistant\/conversations$/, path: "/v2/assistant/conversations" },
  { operation: "assistant.read", method: "GET", pattern: /^\/v2\/assistant\/conversations\/(conv_[0-9A-HJKMNP-TV-Z]{26})$/, path: "/v2/assistant/conversations/<id>" },
  { operation: "assistant.chat", method: "POST", pattern: /^\/v2\/assistant\/chat$/, path: "/v2/assistant/chat" },
] as const;
export type V2Route = (typeof V2_ROUTES)[number];

async function json(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { throw new HubError("INVALID", { key: "runtime.request_body_must_be_json", args: [] }); }
}
export function moduleError(cause: unknown): HubError | undefined {
  if (cause instanceof WorkError || cause instanceof AssistantError) return new HubError(cause.code, cause.params, { reason: cause.reason });
}
export async function handleV2(request: Request, server: Bun.Server<undefined>, route: V2Route, identity: Identity, store: HubStore,
  modules: BusinessModules, decide: typeof authorize, now = new Date()): Promise<Response> {
  let decision = decide(identity.actor, { operation: route.operation,
    includePrivate: ["resource.read", "execution.read", "knowledge.graph"].includes(route.operation) && new URL(request.url).searchParams.get("include_private") === "true" });
  let execution = "applied";
  let audited = false;
  try {
    if (decision.result !== "allow") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { reason: decision.result === "deny" ? decision.reason : msg("v2.approval_required") });
    const url = new URL(request.url), id = route.pattern.exec(url.pathname)?.[1];
    if (route.operation === "resource.read") {
      const resource = Id.safeParse(id);
      const privateValue = url.searchParams.get("include_private"), includePrivate = privateValue === "true";
      if (!resource.success || (privateValue !== null && !["true", "false"].includes(privateValue)))
        throw new HubError("INVALID", { key: "capability.invalid", args: [] });
      const summary = await modules.resources.resolve(resource.data, identity, { includePrivate });
      const result = summary.status === "visible" && identity.actor.role === "human" && /^(conv|task)_/.test(summary.id)
        ? { ...summary, knowledge_references: await modules.resources.count(summary.id, identity, includePrivate) }
        : summary;
      return Response.json(ResourceSummary.parse(result), { headers: { "Cache-Control": "no-store" } });
    }
    if (route.operation === "knowledge.ai-note") {
      const parsed = KnowledgeAiNoteCommand.safeParse(await json(request));
      if (!parsed.success) throw new HubError("INVALID", { key: "capability.invalid", args: [] });
      audited = true;
      const result = await modules.capabilities.execute(parsed.data.operation.op, parsed.data.operation.args, identity, parsed.data.request_id);
      return Response.json(KnowledgeAiNoteResult.parse(result.result), { status: parsed.data.operation.op.endsWith(".create") ? 201 : 200 });
    }
    if (route.operation === "knowledge.graph") {
      if (identity.actor.role !== "human") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
      const raw = Object.fromEntries([...url.searchParams].map(([key, value]) => [key, value === "true" ? true : value === "false" ? false : value]));
      const args = KnowledgeGraphArgs.safeParse(raw);
      if (!args.success) throw new HubError("INVALID", { key: "capability.invalid", args: [] });
      if (!modules.knowledge) throw new HubError("INVALID", { key: "server.no_knowledge_directory_configured_work_and_execution_are_available_i", args: [] });
      return Response.json(KnowledgeGraph.parse(await modules.knowledge.graph({ includePrivate: args.data.include_private, includeLegacy: args.data.include_legacy, type: args.data.type })), { headers: { "Cache-Control": "no-store" } });
    }
    if (route.operation === "knowledge.delete" || route.operation === "assistant.delete" || route.operation.startsWith("trash.")) {
      if (identity.actor.role !== "human") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
      const trash = modules.trash;
      const invalid = () => new HubError("INVALID", { key: "trash.invalid", args: [] });
      if (route.operation === "trash.list") {
        const input = TrashListArgs.safeParse(Object.fromEntries(url.searchParams));
        if (!input.success) throw invalid();
        return Response.json(trash.list(identity.actor.id, input.data));
      }
      const body = await json(request);
      if (route.operation === "knowledge.delete") {
        const input = KnowledgeDeleteRequest.safeParse(body);
        if (!input.success) throw invalid();
        const result = await trash.deleteNote(id!, input.data, identity);
        audited = true;
        return Response.json(result);
      }
      if (route.operation === "assistant.delete") {
        const input = AssistantConversationDeleteRequest.safeParse(body);
        if (!input.success) throw invalid();
        const count = await modules.resources.count(id!, identity);
        const result = trash.deleteConversation(id!, input.data.request_id, identity, count);
        audited = true;
        return Response.json(result);
      }
      const restore = route.operation === "trash.restore";
      const input = (restore ? TrashRestoreRequest : TrashPurgeRequest).safeParse(body);
      if (!input.success) throw invalid();
      const result = await trash.change(restore ? "restore" : "purge", id!, input.data.request_id, identity);
      audited = true;
      return Response.json(result);
    }
    if (url.pathname === "/v2/execution/targets") return Response.json((await modules.capabilities.execute("execution.target.list", Object.fromEntries([...url.searchParams].map(([key, value]) => [key, value === "true" ? true : value === "false" ? false : value])), identity)).result);
    if (url.pathname.startsWith("/v2/approval/proposals/")) return Response.json((await modules.capabilities.execute("approval.proposal.withdraw", { proposal: id }, identity)).result);
    if (route.operation === "work.plan_templates.read") return Response.json(PlanTemplate.array().parse(modules.work.planTemplates()));
    if (route.operation === "notifications.push") {
      const push = modules.notifications.push, owner = identity.actor.id;
      // Explicit ownership and role checks also apply when an injected policy is permissive.
      if (identity.actor.role !== "human") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
      if (url.pathname.endsWith("/key")) return Response.json(push.key(), { headers: { "Cache-Control": "no-store" } });
      if (request.method === "GET") return Response.json(push.devices(owner), { headers: { "Cache-Control": "no-store" } });
      if (url.pathname.endsWith("/test")) return Response.json(await push.test(owner));
      const body = request.method === "DELETE" ? undefined : await json(request);
      const value = store.db.transaction(() => {
        const value = request.method === "DELETE" ? push.remove(owner, id!) : request.method === "PATCH" ? push.update(owner, id!, body) : push.subscribe(owner, body, request.headers.get("user-agent") ?? "", request.headers.get("origin") ?? undefined);
        store.audit(identity, route.operation, "allow", undefined, "applied"); return value;
      })();
      audited = true;
      return value ? Response.json(value, { headers: { "Cache-Control": "no-store" } }) : new Response(null, { status: 204 });
    }
    if (route.operation === "agents.manage") {
      if (request.method === "GET") return Response.json(AgentInfo.array().parse(store.agents(now)));
      const body = await json(request);
      const parsed = (url.pathname.endsWith("/tokens") ? AgentTokenRequest : AgentRevokeRequest).safeParse(body);
      if (!parsed.success) throw new HubError("INVALID", { key: "agents.invalid_request", args: [] });
      const result = store.db.transaction(() => {
        const value = url.pathname.endsWith("/tokens") ? store.issueAgentToken(parsed.data.name, parsed.data.label)
          : (store.revokeAgent(parsed.data.name, parsed.data.label), undefined);
        store.audit(identity, route.operation, "allow", undefined, "applied"); return value;
      })();
      audited = true;
      return result ? Response.json(result, { headers: { "Cache-Control": "no-store" } }) : new Response(null, { status: 204 });
    }
    if (url.pathname.includes("/artifacts")) return await handleArtifacts(request, identity, store, modules);
    if (route.operation === "assistant.config") {
      if (request.method === "GET") await modules.assistantConfig.refresh();
      const value = request.method === "GET" ? modules.assistantConfig.view() : request.method === "DELETE" ? await modules.assistantConfig.clear() : await modules.assistantConfig.update(await json(request));
      return Response.json(value);
    }
    if (route.operation === "assistant.undo") {
      const body = await json(request);
      const requestId = RequestId.safeParse(body && typeof body === "object" && "request_id" in body ? body.request_id : undefined);
      if (!requestId.success) throw new HubError("INVALID", { key: "capability.invalid", args: [] });
      return Response.json(await modules.undo(id!, identity, requestId.data));
    }
    if (route.operation === "assistant.read" && url.pathname.endsWith("/tools")) {
      const detail = modules.assistant.detail(id!, identity.actor.id);
      return Response.json(AssistantToolCall.array().parse(detail.turns.flatMap(turn => modules.assistantStore.calls(turn.id))));
    }
    if (route.operation === "work.command" || route.operation === "execution.command") {
      const body = await json(request);
      const parsed = (route.operation === "work.command" ? WorkCommandRequest : ExecutionRoutineCommandRequest).safeParse(body);
      if (!parsed.success) throw new HubError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
      const { operation, request_id } = parsed.data;
      const respond = (result: unknown, status = 200) => {
        const offline = route.operation === "work.command"
          ? modules.workCommands.offlineTargets(WorkCommandRequest.parse(body).operation, WorkCommandResult.parse(result))
          : [];
        const headers = offline.length ? { "X-Lumio-Offline-Targets": offline.join(", ") } : undefined;
        return Response.json(result, { status, headers });
      };
      const commandDecision = decision = decide(identity.actor, { operation: route.operation, command: operation.op, args: operation.args });
      if (commandDecision.result === "needs_approval" && route.operation === "work.command") {
        const value = modules.workCommands.execute(WorkCommandRequest.parse(body), identity);
        audited = true; return respond(value, 202);
      }
      if (commandDecision.result !== "allow") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { reason: commandDecision.result === "deny" ? commandDecision.reason : msg("v2.approval_required") });
      if (capability(operation.op)) return respond((await modules.capabilities.execute(operation.op, operation.args, identity, request_id)).result);
      const receipt = operation.op === "work.task.delete" && identity.actor.role === "human"
        ? modules.workStore.receipt(identity.actor.id, request_id)?.result : undefined;
      const referenceCount = operation.op === "work.task.delete" && identity.actor.role === "human"
        && !(receipt?.kind === "trashed" && receipt.knowledge_references !== undefined)
        ? await modules.resources.count(operation.args.task, identity) : undefined;
      const result = store.db.transaction(() => {
        const value = route.operation === "work.command" ? modules.workCommands.execute(WorkCommandRequest.parse(body), identity) : modules.routines.command(body, identity.actor.id);
        store.audit(identity, route.operation, decision.result, undefined, "applied");
        if (referenceCount !== undefined && "kind" in value && value.kind === "trashed" && value.knowledge_references === undefined) {
          modules.workStore.saveTrashReferenceCount(identity.actor.id, request_id, referenceCount);
          return { ...value, knowledge_references: referenceCount };
        }
        return value;
      })();
      audited = true;
      return respond(result);
    }
    const read = async (name: string, args: Record<string, unknown>) => Response.json((await modules.capabilities.execute(name, args, identity)).result);
    if (route.operation === "execution.read" && url.pathname.startsWith("/v2/execution/jobs")) {
      return await read(id ? "execution.job.show" : "execution.job.list", id ? { job: id } : Object.fromEntries([...url.searchParams].map(([key, value]) => [key, key === "limit" ? Number(value) : value])));
    }
    if (route.operation === "execution.read") return id ? Response.json(ExecutionRoutine.parse(modules.routines.get(id))) : await read("execution.routine.list", {});
    if (route.operation === "work.read") {
      if (url.pathname === "/v2/work/attention") return await read("work.attention.list", {});
      if (url.pathname.startsWith("/v2/work/projects")) return await read(id ? "work.project.show" : "work.project.list", id ? { project: id } : Object.fromEntries(url.searchParams));
      if (id) return await read("work.task.show", { task: id });
      const params = Object.fromEntries(url.searchParams); if (params.q !== undefined) { params.query = params.q; delete params.q; }
      return await read("work.task.list", params);
    }
    if (route.operation === "assistant.memory.read") return Response.json(await modules.assistant.memories(identity.actor.id));
    if (route.operation === "assistant.memory.command") {
      const result = await modules.assistant.memoryCommand(await json(request), identity.actor.id, () => {
        store.audit(identity, route.operation, decision.result, undefined, "applied");
      });
      audited = true; return Response.json(result);
    }
    if (route.operation === "assistant.read") return Response.json(id ? modules.assistant.detail(id, identity.actor.id) : modules.assistant.conversations(identity.actor.id));
    const parsed = AssistantChatRequest.safeParse(await json(request));
    if (!parsed.success) throw new HubError("INVALID", { key: "v2.invalid_assistant_request_parameters", args: [] });
    // A model can be silent while thinking. The chat deadline below bounds the turn.
    server.timeout(request, 0);
    await modules.assistantConfig.refresh();
    const native=parsed.data.conversation?modules.assistant.detail(parsed.data.conversation,identity.actor.id).conversation.native_session:undefined;
    const signal = AbortSignal.any([...(native?[]:[request.signal]), modules.signal, AbortSignal.timeout(native?1800000:120000)]);
    if (parsed.data.conversation) modules.assistant.detail(parsed.data.conversation, identity.actor.id);
    if (request.headers.get("accept")?.includes("application/x-ndjson")) {
      const progress = request.headers.get("X-Lumio-Assistant-Progress") === "1";
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        let terminal = false;
        const event = (value: AssistantEvent) => {
          if (!progress && (value.type === "model_waiting" || value.type === "reasoning")) return;
          terminal ||= value.type === "result" || value.type === "error";
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        };
        void modules.assistant.chat(parsed.data, identity.actor.id, { signal, event })
          .then((result) => {
            if (!terminal) event(result.turn.status === "done" ? { type: "result", turn: result.turn.id, messages: result.messages }
              : { type: "error", turn: result.turn.id, error: result.turn.error ?? msg("v2.this_round_is_running_or_its_outcome_is_unknown_inspect_the_conversa") });
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
    if (!audited && (!["work.read", "execution.read", "assistant.read", "assistant.memory.read"].includes(route.operation) || execution !== "applied" || decision.result !== "allow")) {
      store.audit(identity, route.operation, decision.result, undefined, execution);
    }
  }
}

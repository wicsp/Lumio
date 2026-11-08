import { Id, KnowledgeDocument, KnowledgeUpdateRequest, KnowledgeUpdateResult, KnowledgeRelatedRequest, KnowledgeRelatedResult, KnowledgeReferencesRequest, KnowledgeReferencesResult } from "@lumio/schema";
import { KnowledgeTemplateRequest, KnowledgeTemplateResult, PaperResolveRequest, PaperResolveResult, KnowledgeCreateRequest, KnowledgeCreateResult } from "@lumio/schema";
import { ExecutionTarget, ExecutionTargetListArgs } from "@lumio/schema";
import { AssistantConversationDeleteRequest, KnowledgeDeleteRequest, TrashListArgs, TrashListResult, TrashPurgeRequest, TrashPurgeResult, TrashRestoreRequest, TrashRestoreResult, TrashResult } from "@lumio/schema";
import { PushSubscriptionInput, PushDevice, PushDeviceUpdate, PushPublicKey, PushTestResult } from "@lumio/schema";
import { AgentInfo, AgentTokenIssued, AgentTokenRequest, AgentRevokeRequest, ClientInvite, ClientInviteRequest, ClientJoin, ClientJoinRequest, RuntimeInvite, RuntimeInviteRequest } from "@lumio/schema";
import { AssistantConfigView, AssistantConfigUpdate, AssistantToolCall, ExecutionJobListArgs, RequestId, WorkTaskListArgs, WorkAttention, WorkCommandRequest, WorkCommandResult, PlanTemplate, type WorkCommand, WorkTask, WorkTaskDetail, WorkProject, ExecutionRoutine, ExecutionRoutineCommandRequest, ExecutionRoutineInfo,
  ProjectStatus, AssistantMemory, AssistantMemoryCommandRequest, AssistantMemoryCommandResult, AssistantChatRequest, AssistantChatResult, AssistantConversation, AssistantConversationDetail, AssistantEvent, StoredArtifact, idOf } from "@lumio/schema";
import { JobRun, Job, JobSpec, JobStatus, RoutineInfo, RuntimeName, RuntimeInfo, Actor, OperationRequest, OperationResult, Proposal, ProposalStatus, ApiError, CheckResult, LinksResult, NoteDetail, SearchResult, type ApiErrorCode, type NoteRef } from "@lumio/schema";

export class ApiClientError extends Error {
  hubUrl?: string;
  readonly code: ApiErrorCode;
  readonly operation: ApiError["error"]["operation"];
  readonly reason: string | undefined;
  readonly proposal: string | undefined;
  constructor(error: ApiError["error"], public readonly status?: number) {
    super(error.message);
    this.name = "ApiClientError";
    this.code = error.code;
    this.operation = error.operation;
    this.reason = error.reason;
    this.proposal = error.proposal;
  }
}
export const SubmitJob = JobSpec.omit({ protocol_version: true, id: true, source: true, lease: true, created: true }).extend({
  runtime: RuntimeName, run: JobRun, workdir: JobSpec.shape.workdir.default("~"),
  timeout_seconds: JobSpec.shape.timeout_seconds.default(7200),
});
export interface SubmitJobInput {
  runtime: string; run: import("@lumio/schema").JobRun; workdir?: string; timeout_seconds?: number; gpus?: number[];
}
export interface QueryOptions { includePrivate?: boolean }
export interface SearchOptions extends QueryOptions { type?: NoteRef["type"]; limit?: number }

export function createClient(options: { url: string; token?: string; language?: string; fetch?: typeof globalThis.fetch; onOfflineTargets?: (targets: string[]) => void }) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.url.replace(/\/+$/, "");
  function transportError(message: string, status?: number): ApiClientError {
    const error = new ApiClientError({ code: "INTERNAL", message }, status);
    if (status === undefined) { try { error.hubUrl = new URL(base).origin; } catch { /* invalid URL */ } }
    return error;
  }
  async function request<T>(path: string, params: Record<string, string>, schema: { parse(value: unknown): T }, body?: unknown, method?: string): Promise<T> {
    let status: number | undefined;
    try {
      const url = new URL(`${base}${path}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetcher(url, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: { ...(options.language ? { "Accept-Language": options.language } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error",
      });
      status = response.status;
      if (response.status === 204 && response.ok) return schema.parse(undefined);
      const responseBody: unknown = await response.json();
      if (!response.ok) throw new ApiClientError(ApiError.parse(responseBody).error, response.status);
      const result = schema.parse(responseBody);
      const offline = response.headers.get("X-Lumio-Offline-Targets");
      if (offline) options.onOfflineTargets?.(offline.split(",").map(target => target.trim()));
      return result;
    } catch (cause) {
      if (cause instanceof ApiClientError) throw cause;
      // Fetch/schema errors can contain request URLs or response data. Do not expose them.
      throw transportError("无法调用 Hub，或 Hub 返回了不合法的响应", status);
    }
  }
  function validate<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiClientError({ code: "INVALID", message: "请求参数不合法" });
    return parsed.data;
  }
  const queryParams = (options: QueryOptions): Record<string, string> => options.includePrivate === undefined ? {} : { include_private: String(options.includePrivate) };
  return {
    knowledgeDocument(id: string) { return request(`/v2/knowledge/notes/${encodeURIComponent(validate(Id, id))}/document`, {}, KnowledgeDocument); },
    // 删除与回收站（ADR 0038）：只有人可用。任务与项目的删除走 workCommand。
    deleteNote(id: string, input: KnowledgeDeleteRequest) { return request(`/v2/knowledge/notes/${encodeURIComponent(validate(Id, id))}`, {}, TrashResult, validate(KnowledgeDeleteRequest, input), "DELETE"); },
    deleteConversation(id: string, input: AssistantConversationDeleteRequest) { return request(`/v2/assistant/conversations/${validate(idOf("conv"), id)}`, {}, TrashResult, validate(AssistantConversationDeleteRequest, input), "DELETE"); },
    trash(args: TrashListArgs = {}) { const input = validate(TrashListArgs, args); return request("/v2/trash", input.kind ? { kind: input.kind } : {}, TrashListResult); },
    restoreTrash(id: string, input: TrashRestoreRequest) { return request(`/v2/trash/${encodeURIComponent(validate(Id, id))}/restore`, {}, TrashRestoreResult, validate(TrashRestoreRequest, input)); },
    purgeTrash(id: string, input: TrashPurgeRequest) { return request(`/v2/trash/${encodeURIComponent(validate(Id, id))}`, {}, TrashPurgeResult, validate(TrashPurgeRequest, input), "DELETE"); },
    updateNote(id: string, input: KnowledgeUpdateRequest) { return request(`/v2/knowledge/notes/${encodeURIComponent(validate(Id, id))}/document`, {}, KnowledgeUpdateResult, validate(KnowledgeUpdateRequest, input), "PUT"); },
    relatedNotes(input: KnowledgeRelatedRequest) { return request("/v2/knowledge/related", {}, KnowledgeRelatedResult, validate(KnowledgeRelatedRequest, input)); },
    noteReferences(input: KnowledgeReferencesRequest) { return request("/v2/knowledge/references", {}, KnowledgeReferencesResult, validate(KnowledgeReferencesRequest, input)); },
    knowledgeTemplate(input: KnowledgeTemplateRequest) { return request("/v2/knowledge/templates", validate(KnowledgeTemplateRequest, input), KnowledgeTemplateResult); },
    resolvePaper(input: PaperResolveRequest) { return request("/v2/knowledge/papers/resolve", {}, PaperResolveResult, validate(PaperResolveRequest, input)); },
    createNote(input: KnowledgeCreateRequest) { return request("/v2/knowledge/notes", {}, KnowledgeCreateResult, validate(KnowledgeCreateRequest, input)); },
    pushKey() { return request("/v2/notifications/push/key", {}, PushPublicKey); },
    pushDevices() { return request("/v2/notifications/push/devices", {}, PushDevice.array()); },
    subscribePush(input: PushSubscriptionInput) { return request("/v2/notifications/push/devices", {}, PushDevice, validate(PushSubscriptionInput, input)); },
    updatePushDevice(id: string, input: PushDeviceUpdate) {
      return request(`/v2/notifications/push/devices/${validate(idOf("pdev"), id)}`, {}, PushDevice, validate(PushDeviceUpdate, input), "PATCH");
    },
    removePushDevice(id: string) { return request(`/v2/notifications/push/devices/${validate(idOf("pdev"), id)}`, {}, { parse: () => undefined }, undefined, "DELETE"); },
    testPush() { return request("/v2/notifications/push/test", {}, PushTestResult, {}); },
    agents() { return request("/v2/agents", {}, AgentInfo.array()); },
    issueAgentToken(input: AgentTokenRequest) { return request("/v2/agents/tokens", {}, AgentTokenIssued, validate(AgentTokenRequest, input)); },
    revokeAgent(input: AgentRevokeRequest) { return request("/v2/agents/revoke", {}, { parse: () => undefined }, validate(AgentRevokeRequest, input)); },
    executionJobs(filter: ExecutionJobListArgs = {}) {
      return request("/v2/execution/jobs", Object.fromEntries(Object.entries(validate(ExecutionJobListArgs, filter)).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])), Job.array());
    },
    executionJob(id: string) { return request(`/v2/execution/jobs/${validate(idOf("job"), id)}`, {}, Job); },
    assistantConfig() { return request("/v2/assistant/config", {}, AssistantConfigView); },
    updateAssistantConfig(input: AssistantConfigUpdate) { return request("/v2/assistant/config", {}, AssistantConfigView, validate(AssistantConfigUpdate, input), "PUT"); },
    clearAssistantConfig() { return request("/v2/assistant/config", {}, AssistantConfigView, undefined, "DELETE"); },
    assistantTools(conversation: string) { return request(`/v2/assistant/conversations/${validate(idOf("conv"), conversation)}/tools`, {}, AssistantToolCall.array()); },
    undoAssistantTool(tool: string, request_id: string) { return request(`/v2/assistant/tools/${validate(idOf("tool"), tool)}/undo`, {}, WorkCommandResult, { request_id: validate(RequestId, request_id) }); },
    workAttention() { return request("/v2/work/attention", {}, WorkAttention.array()); },
    workCommand(input: WorkCommandRequest) { return request("/v2/work/commands", {}, WorkCommandResult, validate(WorkCommandRequest, input)); },
    workPlanTemplates() { return request("/v2/work/plan-templates", {}, PlanTemplate.array()); },
    saveWorkPlanTemplate(args: Extract<WorkCommand, { op: "work.plan_template.save" }>["args"], request_id: string) {
      return request("/v2/work/commands", {}, WorkCommandResult, validate(WorkCommandRequest, { request_id, operation: { op: "work.plan_template.save", args } }));
    },
    deleteWorkPlanTemplate(template: string, request_id: string) {
      return request("/v2/work/commands", {}, WorkCommandResult, validate(WorkCommandRequest, { request_id, operation: { op: "work.plan_template.delete", args: { template } } }));
    },
    workTasks(filter: Omit<WorkTaskListArgs, "status"> & { status?: string } = {}) {
      const input = validate(WorkTaskListArgs, filter);
      return request("/v2/work/tasks", Object.fromEntries(Object.entries(input)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => [key === "query" ? "q" : key, value])), WorkTask.array());
    },
    workTask(id: string) { return request(`/v2/work/tasks/${validate(idOf("task"), id)}`, {}, WorkTaskDetail); },
    workProjects(filter: { status?: string } = {}) { return request("/v2/work/projects", filter.status ? { status: validate(ProjectStatus, filter.status) } : {}, WorkProject.array()); },
    workProject(id: string) { return request(`/v2/work/projects/${validate(idOf("prj"), id)}`, {}, WorkProject); },
    executionCommand(input: ExecutionRoutineCommandRequest) { return request("/v2/execution/commands", {}, ExecutionRoutine, validate(ExecutionRoutineCommandRequest, input)); },
    executionRoutines() { return request("/v2/execution/routines", {}, ExecutionRoutineInfo.array()); },
    executionRoutine(id: string) { return request(`/v2/execution/routines/${validate(idOf("rtn"), id)}`, {}, ExecutionRoutine); },
    jobArtifacts(id: string, query: QueryOptions = {}) { return request(`/v2/execution/jobs/${validate(idOf("job"), id)}/artifacts`, queryParams(query), StoredArtifact.array()); },
    artifact(id: string, query: QueryOptions = {}) { return request(`/v2/execution/artifacts/${validate(idOf("art"), id)}`, queryParams(query), StoredArtifact); },
    async artifactContent(id: string, query: QueryOptions = {}): Promise<Response> {
      const path = `/v2/execution/artifacts/${validate(idOf("art"), id)}/content`; let status: number | undefined;
      try {
        const url = new URL(`${base}${path}`); for (const [key, value] of Object.entries(queryParams(query))) url.searchParams.set(key, value);
        const response = await fetcher(url, { headers: { ...(options.language ? { "Accept-Language": options.language } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, redirect: "error" });
        status = response.status;
        if (!response.ok) throw new ApiClientError(ApiError.parse(await response.json()).error, status);
        return response;
      } catch (cause) {
        if (cause instanceof ApiClientError) throw cause;
        throw transportError("无法读取 Hub 归档文件", status);
      }
    },
    memories() { return request("/v2/assistant/memories", {}, AssistantMemory.array()); },
    memoryCommand(input: AssistantMemoryCommandRequest) { return request("/v2/assistant/memory-commands", {}, AssistantMemoryCommandResult, validate(AssistantMemoryCommandRequest, input)); },
    assistantChat(input: AssistantChatRequest) { return request("/v2/assistant/chat", {}, AssistantChatResult, validate(AssistantChatRequest, input)); },
    conversations() { return request("/v2/assistant/conversations", {}, AssistantConversation.array()); },
    conversation(id: string) { return request(`/v2/assistant/conversations/${validate(idOf("conv"), id)}`, {}, AssistantConversationDetail); },
    async *assistantEvents(input: AssistantChatRequest, signal?: AbortSignal): AsyncGenerator<AssistantEvent> {
      const payload = validate(AssistantChatRequest, input);
      let release: (() => Promise<void>) | undefined;
      let status: number | undefined;
      try {
        const response = await fetcher(`${base}/v2/assistant/chat`, { method: "POST", redirect: "error", signal,
          headers: { ...(options.language ? { "Accept-Language": options.language } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify(payload) });
        status = response.status;
        if (!response.ok) throw new ApiClientError(ApiError.parse(await response.json()).error, response.status);
        if (!response.body) throw new Error("missing stream");
        const reader = response.body.getReader();
        release = async () => { await reader.cancel().catch(() => {}); reader.releaseLock(); };
        const decoder = new TextDecoder(); let pending = "", terminal = false;
        while (true) {
          const chunk = await reader.read(); pending += decoder.decode(chunk.value, { stream: !chunk.done });
          let end: number;
          while ((end = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            if (line.trim()) {
              if (terminal) throw new Error("event after final result");
              const event = AssistantEvent.parse(JSON.parse(line));
              terminal = event.type === "result" || event.type === "error";
              yield event;
            }
          }
          if (chunk.done) break;
        }
        if (pending.trim() || !terminal) throw new Error("truncated assistant stream");
      } catch (cause) {
        if (cause instanceof ApiClientError) throw cause;
        throw transportError("助手连接中断或返回了不合法的事件；请查询已保存的对话，勿自动重试操作", status);
      } finally { await release?.(); }
    },
    runtimeInvite(name: string) { return request("/v1/runtime-invites", {}, RuntimeInvite, validate(RuntimeInviteRequest, { name })); },
    clientInvite(name: string) { return request("/v1/client-invites", {}, ClientInvite, validate(ClientInviteRequest, { name })); },
    clientJoin(code: string) { return request("/v1/client/join", {}, ClientJoin, validate(ClientJoinRequest, { code })); },
    removeRuntime(name: string) { return request(`/v1/runtimes/${encodeURIComponent(validate(RuntimeName, name))}`, {}, { parse: () => undefined }, undefined, "DELETE"); },
    submitJob(input: SubmitJobInput) { return request("/v1/jobs", {}, Job, validate(SubmitJob, input)); },
    jobs(status?: JobStatus, task?: string, routine?: string) {
      return request("/v1/jobs", { ...(status === undefined ? {} : { status: validate(JobStatus, status) }), ...(task === undefined ? {} : { task }),
        ...(routine === undefined ? {} : { routine }) }, Job.array());
    },
    routines() { return request("/v1/routines", {}, RoutineInfo.array()); },
    job(id: string) { return request(`/v1/jobs/${encodeURIComponent(validate(JobSpec.shape.id, id))}`, {}, Job); },
    cancelJob(id: string) { return request(`/v1/jobs/${encodeURIComponent(validate(JobSpec.shape.id, id))}/cancel`, {}, Job, {}); },
    runtimes() { return request("/v1/runtimes", {}, RuntimeInfo.array()); },
    actors() { return request("/v1/actors", {}, Actor.array()); },
    operation(input: OperationRequest) { return request("/v1/operations", {}, OperationResult, validate(OperationRequest, input)); },
    targets(args: { online?: boolean } = {}) { const value = validate(ExecutionTargetListArgs, args); return request("/v2/execution/targets", value.online === undefined ? {} : { online: String(value.online) }, ExecutionTarget.array()); },
    withdrawProposal(id: string) { return request(`/v2/approval/proposals/${encodeURIComponent(validate(idOf("prop"), id))}/withdraw`, {}, Proposal, {}); },
    proposals(status: ProposalStatus = "pending") { return request("/v1/proposals", { status: validate(ProposalStatus, status) }, Proposal.array()); },
    acceptProposal(id: string) { return request(`/v1/proposals/${encodeURIComponent(id)}/accept`, {}, Proposal, {}); },
    rejectProposal(id: string) { return request(`/v1/proposals/${encodeURIComponent(id)}/reject`, {}, Proposal, {}); },
    search(query: string, options: SearchOptions = {}) {
      return request("/v1/search", { q: query, ...queryParams(options),
        ...(options.type !== undefined ? { type: options.type } : {}),
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
      }, SearchResult);
    },
    show(reference: string, options: QueryOptions = {}) {
      return request(`/v1/notes/${encodeURIComponent(reference)}`, queryParams(options), NoteDetail);
    },
    links(reference: string, options: QueryOptions = {}) {
      return request(`/v1/notes/${encodeURIComponent(reference)}/links`, queryParams(options), LinksResult);
    },
    check(options: QueryOptions = {}) {
      return request("/v1/check", queryParams(options), CheckResult);
    },
  };
}

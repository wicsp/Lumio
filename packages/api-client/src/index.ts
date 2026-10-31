import { ClientInvite, ClientInviteRequest, ClientJoin, ClientJoinRequest, RuntimeInvite, RuntimeInviteRequest } from "@lumio/schema";
import { WorkCommandRequest, WorkCommandResult, WorkTask, WorkTaskDetail, WorkProject, ExecutionRoutine, ExecutionRoutineCommandRequest, ExecutionRoutineInfo,
  AssistantMemory, AssistantMemoryCommandRequest, AssistantMemoryCommandResult, AssistantChatRequest, AssistantChatResult, AssistantConversation, AssistantConversationDetail, AssistantEvent, StoredArtifact, idOf } from "@lumio/schema";
import { JobRun, Job, JobSpec, JobStatus, RoutineInfo, RuntimeName, RuntimeInfo, Actor, OperationRequest, OperationResult, Proposal, ProposalStatus, ApiError, CheckResult, LinksResult, NoteDetail, SearchResult, type ApiErrorCode, type NoteRef } from "@lumio/schema";

export class ApiClientError extends Error {
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

export function createClient(options: { url: string; token?: string; fetch?: typeof globalThis.fetch }) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.url.replace(/\/+$/, "");
  async function request<T>(path: string, params: Record<string, string>, schema: { parse(value: unknown): T }, body?: unknown, method?: string): Promise<T> {
    let status: number | undefined;
    try {
      const url = new URL(`${base}${path}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetcher(url, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error",
      });
      status = response.status;
      if (response.status === 204 && response.ok) return schema.parse(undefined);
      const responseBody: unknown = await response.json();
      if (!response.ok) throw new ApiClientError(ApiError.parse(responseBody).error, response.status);
      return schema.parse(responseBody);
    } catch (cause) {
      if (cause instanceof ApiClientError) throw cause;
      // Fetch/schema errors can contain request URLs or response data. Do not expose them.
      throw new ApiClientError({ code: "INTERNAL", message: "无法调用 Hub，或 Hub 返回了不合法的响应" }, status);
    }
  }
  function validate<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiClientError({ code: "INVALID", message: "请求参数不合法" });
    return parsed.data;
  }
  const queryParams = (options: QueryOptions): Record<string, string> => options.includePrivate === undefined ? {} : { include_private: String(options.includePrivate) };
  return {
    workCommand(input: WorkCommandRequest) { return request("/v2/work/commands", {}, WorkCommandResult, validate(WorkCommandRequest, input)); },
    workTasks(filter: { project?: string; status?: string; query?: string } = {}) {
      return request("/v2/work/tasks", { ...(filter.project ? { project: validate(idOf("prj"), filter.project) } : {}),
        ...(filter.status ? { status: filter.status } : {}), ...(filter.query ? { q: filter.query } : {}) }, WorkTask.array());
    },
    workTask(id: string) { return request(`/v2/work/tasks/${validate(idOf("task"), id)}`, {}, WorkTaskDetail); },
    workProjects() { return request("/v2/work/projects", {}, WorkProject.array()); },
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
        const response = await fetcher(url, { headers: options.token ? { Authorization: `Bearer ${options.token}` } : {}, redirect: "error" });
        status = response.status;
        if (!response.ok) throw new ApiClientError(ApiError.parse(await response.json()).error, status);
        return response;
      } catch (cause) {
        if (cause instanceof ApiClientError) throw cause;
        throw new ApiClientError({ code: "INTERNAL", message: "无法读取 Hub 归档文件" }, status);
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
      try {
        const response = await fetcher(`${base}/v2/assistant/chat`, { method: "POST", redirect: "error", signal,
          headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify(payload) });
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
        throw new ApiClientError({ code: "INTERNAL", message: "助手连接中断或返回了不合法的事件；请查询已保存的对话，勿自动重试操作" });
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

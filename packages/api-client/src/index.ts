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

export function createClient(options: { url: string; token: string; fetch?: typeof globalThis.fetch }) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.url.replace(/\/+$/, "");
  async function request<T>(path: string, params: Record<string, string>, schema: { parse(value: unknown): T }, body?: unknown): Promise<T> {
    try {
      const url = new URL(`${base}${path}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${options.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error",
      });
      const responseBody: unknown = await response.json();
      if (!response.ok) throw new ApiClientError(ApiError.parse(responseBody).error, response.status);
      return schema.parse(responseBody);
    } catch (cause) {
      if (cause instanceof ApiClientError) throw cause;
      // Fetch/schema errors can contain request URLs or response data. Do not expose them.
      throw new ApiClientError({ code: "INTERNAL", message: "无法调用 Hub，或 Hub 返回了不合法的响应" });
    }
  }
  function validate<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiClientError({ code: "INVALID", message: "请求参数不合法" });
    return parsed.data;
  }
  const queryParams = (options: QueryOptions): Record<string, string> => options.includePrivate === undefined ? {} : { include_private: String(options.includePrivate) };
  return {
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

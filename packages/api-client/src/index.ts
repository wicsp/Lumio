import { ApiError, LinksResult, NoteDetail, SearchResult, type ApiErrorCode, type NoteRef } from "@lumio/schema";

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
export interface QueryOptions { includePrivate?: boolean }
export interface SearchOptions extends QueryOptions { type?: NoteRef["type"]; limit?: number }

export function createClient(options: { url: string; token: string; fetch?: typeof globalThis.fetch }) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.url.replace(/\/+$/, "");
  async function get<T>(path: string, params: Record<string, string>, schema: { parse(value: unknown): T }): Promise<T> {
    try {
      const url = new URL(`${base}${path}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetcher(url, { headers: { Authorization: `Bearer ${options.token}` }, redirect: "error" });
      const body: unknown = await response.json();
      if (!response.ok) throw new ApiClientError(ApiError.parse(body).error, response.status);
      return schema.parse(body);
    } catch (cause) {
      if (cause instanceof ApiClientError) throw cause;
      // Fetch/schema errors can contain request URLs or response data. Do not expose them.
      throw new ApiClientError({ code: "INTERNAL", message: "无法调用 Hub，或 Hub 返回了不合法的响应" });
    }
  }
  const queryParams = (options: QueryOptions): Record<string, string> => options.includePrivate === undefined ? {} : { include_private: String(options.includePrivate) };
  return {
    search(query: string, options: SearchOptions = {}) {
      return get("/v1/search", { q: query, ...queryParams(options),
        ...(options.type !== undefined ? { type: options.type } : {}),
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
      }, SearchResult);
    },
    show(reference: string, options: QueryOptions = {}) {
      return get(`/v1/notes/${encodeURIComponent(reference)}`, queryParams(options), NoteDetail);
    },
    links(reference: string, options: QueryOptions = {}) {
      return get(`/v1/notes/${encodeURIComponent(reference)}/links`, queryParams(options), LinksResult);
    },
  };
}

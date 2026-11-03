/**
 * 浏览器会话（ADR 0026）：请求会话持有令牌；保存与恢复由 App 负责。登出或 401 时中止所有未完成请求。
 */
import { ApiClientError, createClient } from "@lumio/api-client";
import { acceptLanguage, t } from "./i18n.ts";

/**
 * API 前缀由页面告诉浏览器（ADR 0027）：Hub 直接提供页面时为空（同源根路径），旧的独立 Web 服务为 "/hub"。
 * 没有这个 meta 时按旧页面处理。
 */
export function apiBase(): string {
  const value = typeof document === "undefined" ? undefined : document.querySelector<HTMLMetaElement>('meta[name="lumio-api-base"]')?.content;
  return value === undefined ? "/hub" : value;
}
export type Client = ReturnType<typeof createClient>;

export interface Session {
  client: Client;
  /** 中止本会话全部未完成请求（包括助手流）。 */
  close(): void;
  readonly signal: AbortSignal;
  /** Hub 的 /health：设置页用来显示版本。 */
  health(): Promise<{ ok: boolean; version?: string }>;
}

/** 返回绑定当前页面 API 地址（见 apiBase）的会话；任何 401 都调用 onUnauthorized。 */
export function createSession(token: string | undefined, onUnauthorized: () => void): Session {
  const controller = new AbortController();
  let closed=false;
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const target = typeof input === "string" && input.startsWith("/") ? new URL(input, window.location.origin) : input;
    const headers = new Headers(init.headers);
    const hub = typeof document === "undefined" ? undefined : document.querySelector<HTMLMetaElement>('meta[name="lumio-hub"]')?.content;
    if (hub) headers.set("X-Lumio-Hub", hub);
    headers.set("Accept-Language", acceptLanguage());
    const response = await window.fetch(target, { ...init, headers, signal, credentials: "omit", cache: "no-store" });
    if (response.status === 401 && token&&!closed) queueMicrotask(()=>{if(!closed)onUnauthorized();});
    return response;
  }) as typeof fetch;
  // api-client 用 new URL(base + path) 组装地址，需要绝对地址。
  const client = createClient({ url: `${window.location.origin}${apiBase()}`, ...(token ? { token } : {}), fetch: fetcher });
  const health = async () => {
    const response = await fetcher(`${apiBase()}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { ok?: unknown; version?: unknown };
    return { ok: body.ok === true, ...(typeof body.version === "string" ? { version: body.version } : {}) };
  };
  return { client, health, signal: controller.signal, close: () => {closed=true;controller.abort();} };
}

const CODE_TEXT: Record<string, string> = {
  UNAUTHENTICATED: t("Your session has expired. Connect again."),
  FORBIDDEN: t("You don't have permission to do this."),
  NOT_FOUND: t("This item wasn't found. It may have been deleted."),
  CONFLICT: t("This was changed somewhere else."),
};

/** 给人看的错误说明；只用 Hub 返回的说明或通用提示，不显示内部异常。 */
export function errorText(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === "INTERNAL" || error.code === "INVALID") return error.message;
    return error.message || CODE_TEXT[error.code] || t("Something went wrong.");
  }
  if (error instanceof DOMException && error.name === "AbortError") return t("Request cancelled.");
  return t("Couldn't complete this. Check the connection to the Hub.");
}

export const isConflict = (error: unknown) => error instanceof ApiClientError && error.code === "CONFLICT";
export const isAborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** A failed verification may be retried in memory, never persisted before success. */
export class LoginError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

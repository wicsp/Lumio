/**
 * 浏览器会话（ADR 0026）：请求会话持有令牌；保存与恢复由 App 负责。登出或 401 时中止所有未完成请求。
 */
import { ApiClientError, createClient } from "@lumio/api-client";
import { ApiError } from "@lumio/schema";
import type { AssistantConfigUpdate, AssistantConfigView, AssistantToolCall, SpeechBinding, SpeechBindingUpdate, SpeechVocabulary, SpeechVocabularyUpdate, WorkAttention } from "@lumio/schema";
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
  /** ADR 0029/0030 的接口，处理旧 Hub 没有接口的情况。 */
  hub: HubExtras;
  /** 语音 WebSocket 的第一条消息需要令牌（ADR 0055 第 2 节：浏览器 WebSocket 不能带 Authorization 头）。 */
  readonly token?: string;
}

export interface HubExtras {
  ai?: Client;
  /** 需要你处理（ADR 0030）。旧 Hub 没有这个接口时返回 undefined，界面退回按 Job 显示。 */
  attention(): Promise<WorkAttention[] | undefined>;
  assistantConfig(): Promise<AssistantConfigView>;
  /** 对话里的工具调用记录；旧 Hub 返回 []。 */
  assistantTools(conversation: string): Promise<AssistantToolCall[]>;
  saveAssistantConfig(update: AssistantConfigUpdate): Promise<AssistantConfigView>;
  clearAssistantConfig(): Promise<AssistantConfigView>;
  /** 语音（ADR 0055）：旧 Hub 没有这些接口时 speechBindings 返回 []，界面不显示麦克风。 */
  speechBindings(): Promise<SpeechBinding[]>;
  saveSpeechBinding(update: SpeechBindingUpdate): Promise<SpeechBinding | null>;
  speechVocabulary(): Promise<SpeechVocabulary>;
  saveSpeechVocabulary(update: SpeechVocabularyUpdate): Promise<SpeechVocabulary>;
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
  // 语音配置接口不在 api-client 的路由表里（ADR 0055）：直接用同一个 fetcher，错误按 ApiError 转成 ApiClientError。
  const speechRequest = async <T>(path: "bindings" | "vocabulary", body?: unknown): Promise<T> => {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetcher(`${apiBase()}/v2/speech/${path}`, { method: body === undefined ? "GET" : "PUT", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = ApiError.safeParse(data);
      throw new ApiClientError(parsed.success ? parsed.data.error : { code: "INTERNAL", message: `HTTP ${response.status}` }, response.status);
    }
    return data as T;
  };
  // 旧 Hub（R3-2 之前）没有这些接口：需要你处理退回按 Job 显示，工具记录为空。
  const missing = (cause: unknown) => cause instanceof ApiClientError && cause.code === "NOT_FOUND";
  const hub: HubExtras = {
    ai:client,
    attention: () => client.workAttention().catch((cause: unknown) => { if (missing(cause)) return undefined; throw cause; }),
    assistantConfig: () => client.assistantConfig(),
    saveAssistantConfig: (update) => client.updateAssistantConfig(update),
    clearAssistantConfig: () => client.clearAssistantConfig(),
    assistantTools: (conversation) => client.assistantTools(conversation).catch((cause: unknown) => { if (missing(cause)) return []; throw cause; }),
    speechBindings: () => speechRequest<SpeechBinding[]>("bindings").catch((cause: unknown) => { if (missing(cause)) return []; throw cause; }),
    saveSpeechBinding: (update) => speechRequest<SpeechBinding | null>("bindings", update),
    speechVocabulary: () => speechRequest<SpeechVocabulary>("vocabulary"),
    saveSpeechVocabulary: (update) => speechRequest<SpeechVocabulary>("vocabulary", update),
  };
  return { client, health, hub, ...(token ? { token } : {}), signal: controller.signal, close: () => {closed=true;controller.abort();} };
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

import { AssistantError, type AssistantModel } from "@lumio/assistant";
import { AssistantModelRequest, AssistantModelResponse } from "@lumio/schema";

export interface ModelConfiguration {
  baseUrl: string;
  model: string;
  /** Runtime-only credential lookup; serializing configuration cannot expose the key. */
  credential(): string | undefined;
}
export function modelConfiguration(env: NodeJS.ProcessEnv): ModelConfiguration | undefined {
  const base = env.LUMIO_ASSISTANT_BASE_URL, model = env.LUMIO_ASSISTANT_MODEL;
  if (base === undefined && model === undefined && !env.LUMIO_ASSISTANT_API_KEY) return;
  if (!base || !model?.trim()) throw new AssistantError("INVALID", "助手需要同时配置 LUMIO_ASSISTANT_BASE_URL 和 LUMIO_ASSISTANT_MODEL");
  let url: URL;
  try {
    url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new AssistantError("INVALID", "助手模型地址必须是不含凭据、查询或片段的 HTTP(S) 地址"); }
  const key = env.LUMIO_ASSISTANT_API_KEY;
  return { baseUrl: url.href.replace(/\/+$/, ""), model, credential: () => key || undefined };
}

const invalid = () => new AssistantError("INVALID", "模型返回了不完整或不支持的响应；请检查兼容接口配置");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
interface Call { id: string; name: string; arguments: string }
const MAX_BYTES = 4 * 1024 * 1024;

/** HTTP stays in the Hub adapter. No provider, model, tool or retries are enabled implicitly. */
export class ChatCompletionsModel implements AssistantModel {
  constructor(private readonly config: ModelConfiguration, private readonly fetcher: typeof fetch = fetch) {}
  async complete(raw: AssistantModelRequest, options: { signal?: AbortSignal; token(text: string): void }): Promise<AssistantModelResponse> {
    const input = AssistantModelRequest.parse(raw);
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(120_000)]);
    let response: Response | undefined;
    try {
      const key = this.config.credential();
      response = await this.fetcher(`${this.config.baseUrl}/chat/completions`, { method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: input.model ?? this.config.model, stream: true,
          messages: input.messages.map(message => ({ role: message.role, content: message.content,
            ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
            ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}),
          })),
          ...(input.tools.length ? { tools: input.tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {}),
        }),
      });
      if (!response.ok) throw new AssistantError("INVALID", response.status === 401 || response.status === 403 ? "模型服务拒绝授权，请检查运行时凭据" : "模型服务未接受请求，请检查地址、模型与服务状态");
      if (!response.body) throw invalid();
      const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      try {
        const read = async (): Promise<string | undefined> => {
          const part = await reader.read(); bytes += part.value?.byteLength ?? 0;
          if (bytes > MAX_BYTES) throw invalid();
          if (part.done) { const last = decoder.decode(); return last || undefined; }
          return decoder.decode(part.value, { stream: true });
        };
        if (!response.headers.get("content-type")?.includes("text/event-stream")) {
          let text = "", part: string | undefined;
          while ((part = await read()) !== undefined) text += part;
          return this.json(JSON.parse(text), input, options.token);
        }
        let buffer = "", data: string[] = [], content = "", finish: string | undefined, done = false;
        const calls = new Map<number, Call>();
        const event = () => {
          if (!data.length) return;
          const payload = data.join("\n"); data = [];
          if (done) throw invalid();
          if (payload === "[DONE]") { if (!finish) throw invalid(); done = true; return; }
          const chunk = object(JSON.parse(payload));
          if (!Array.isArray(chunk.choices)) throw invalid();
          if (!chunk.choices.length) return;
          if (chunk.choices.length !== 1) throw invalid();
          const choice = object(chunk.choices[0]);
          if (choice.index !== 0 || finish) throw invalid();
          const delta = object(choice.delta);
          if (delta.refusal) throw invalid();
          if (delta.content !== undefined && delta.content !== null) {
            if (typeof delta.content !== "string") throw invalid();
            content += delta.content; options.token(delta.content);
          }
          if (delta.tool_calls !== undefined) {
            if (!Array.isArray(delta.tool_calls)) throw invalid();
            for (const raw of delta.tool_calls) {
              const item = object(raw), index = item.index;
              if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= 16 || (item.type !== undefined && item.type !== "function")) throw invalid();
              const call = calls.get(index as number) ?? { id: "", name: "", arguments: "" };
              if (item.id !== undefined) { if (typeof item.id !== "string") throw invalid(); call.id += item.id; }
              if (item.function !== undefined) {
                const fn = object(item.function);
                if (fn.name !== undefined) { if (typeof fn.name !== "string") throw invalid(); call.name += fn.name; }
                if (fn.arguments !== undefined) { if (typeof fn.arguments !== "string") throw invalid(); call.arguments += fn.arguments; }
              }
              calls.set(index as number, call);
            }
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (typeof choice.finish_reason !== "string") throw invalid(); finish = choice.finish_reason;
          }
        };
        let part: string | undefined;
        while (!done && (part = await read()) !== undefined) {
          buffer += part;
          // Accept LF and CRLF, preserving UTF-8 and JSON fragments across arbitrary reads.
          let end: number;
          while ((end = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
            if (!line) event(); else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (buffer.trim() || data.length || !done) throw invalid();
        return this.result(content, [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value), finish, input);
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (cause) {
      if (cause instanceof AssistantError) throw cause;
      if (signal.aborted) throw new AssistantError("INTERNAL", "模型请求已取消或超时");
      throw new AssistantError("INTERNAL", "无法连接模型服务或解析其响应，请检查配置与服务状态");
    } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  private json(raw: unknown, input: AssistantModelRequest, token: (text: string) => void): AssistantModelResponse {
    const body = object(raw);
    if (!Array.isArray(body.choices) || body.choices.length !== 1) throw invalid();
    const choice = object(body.choices[0]), message = object(choice.message);
    if (message.role !== "assistant" || message.refusal) throw invalid();
    const content = message.content ?? "";
    if (typeof content !== "string") throw invalid();
    const rawCalls = message.tool_calls ?? [];
    if (!Array.isArray(rawCalls)) throw invalid();
    const result = this.result(content, rawCalls.map(raw => {
      const call = object(raw), fn = object(call.function);
      if (call.type !== "function" || typeof call.id !== "string" || typeof fn.name !== "string" || typeof fn.arguments !== "string") throw invalid();
      return { id: call.id, name: fn.name, arguments: fn.arguments };
    }), choice.finish_reason, input);
    if (content) token(content); return result;
  }
  private result(content: string, calls: Call[], finish: unknown, input: AssistantModelRequest): AssistantModelResponse {
    if ((calls.length ? finish !== "tool_calls" : finish !== "stop") || calls.length > 16) throw invalid();
    const ids = new Set<string>();
    return AssistantModelResponse.parse({ content, tool_calls: calls.map(call => {
      if (!call.id || ids.has(call.id) || !input.tools.some(tool => tool.name === call.name)) throw invalid();
      ids.add(call.id); const args = object(JSON.parse(call.arguments));
      return { id: call.id, name: call.name, args };
    }) });
  }
}

export function configuredModel(config?: ModelConfiguration): AssistantModel {
  return config ? new ChatCompletionsModel(config) : { async complete() { throw new AssistantError("INVALID", "助手尚未配置模型地址与模型名称"); } };
}

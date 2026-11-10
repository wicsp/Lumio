import { beforeEach as beforeLocale, afterEach as afterLocale } from "bun:test";
let previousLocale: string | undefined;
beforeLocale(() => { previousLocale = process.env.LUMIO_LANG; process.env.LUMIO_LANG = "zh"; });
afterLocale(() => { if (previousLocale === undefined) delete process.env.LUMIO_LANG; else process.env.LUMIO_LANG = previousLocale; });
import { expect, test } from "bun:test";
import { ChatCompletionsModel, configuredModel, modelConfiguration, modelRequestOptions } from "../src/assistant-model.ts";
import { AssistantConfiguration } from "../src/assistant-config.ts";
import { errorMessage, withLanguage } from "../src/messages.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantChatResult, AssistantConversationDetail, AssistantEvent, toolName } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";
import { readConfig } from "../src/config.ts";
import type { AssistantModelRequest } from "@lumio/schema";
const input: AssistantModelRequest = { messages: [{ role: "user", content: "合成问题" }], tools: [{ name: "fixture_read", description: "synthetic", input_schema: { type: "object" } }] };
const config = () => modelConfiguration({ LUMIO_ASSISTANT_BASE_URL: "http://127.0.0.1:1/v1/", LUMIO_ASSISTANT_MODEL: "synthetic-model", LUMIO_ASSISTANT_API_KEY: "synthetic-token" })!;
const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
function streamed(text: string): Response {
  const bytes = new TextEncoder().encode(text); let index = 0;
  return new Response(new ReadableStream({ pull(controller) { if (index >= bytes.length) controller.close(); else controller.enqueue(bytes.slice(index, ++index)); } }), { headers: { "Accept-Language": "zh", "Content-Type": "text/event-stream" } });
}
function fake(handler: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>): typeof fetch { return handler as typeof fetch; }
test("model configuration has no default network/model, validates endpoints and never serializes credentials", async () => {
  expect(modelConfiguration({})).toBeUndefined();
  await expect(configuredModel().complete(input, { token() {} })).rejects.toMatchObject({ code: "INVALID" });
  for (const env of [{ LUMIO_ASSISTANT_API_KEY: "synthetic" }, { LUMIO_ASSISTANT_MODEL: "synthetic" }, { LUMIO_ASSISTANT_BASE_URL: "http://user:password@localhost/v1", LUMIO_ASSISTANT_MODEL: "synthetic" }, { LUMIO_ASSISTANT_BASE_URL: "https://localhost/v1?key=synthetic", LUMIO_ASSISTANT_MODEL: "synthetic" }]) expect(() => modelConfiguration(env)).toThrow();
  expect(JSON.stringify(config())).not.toContain("synthetic-token");
});
test("compatible adapter maps dialogue/tools and assembles split UTF-8 and tool arguments before returning", async () => {
  let requests = 0; const tokens: string[] = [];
  const model = new ChatCompletionsModel(config(), fake((url, init) => {
    requests++; expect(String(url)).toBe("http://127.0.0.1:1/v1/chat/completions"); expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-token");
    const body = JSON.parse(String(init?.body)); expect(body.model).toBe("override"); expect(body.stream).toBe(true);
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "fixture_read", description: "synthetic", parameters: { type: "object" } } });
    expect(body.messages.at(-2).tool_calls[0].function.arguments).toBe('{"q":"old"}');
    expect(body.messages.at(-1).tool_call_id).toBe("old-call");
    return streamed(chunk({ role: "assistant", content: "读取中文" }) + chunk({ tool_calls: [{ index: 0, id: "provider-1", type: "function", function: { name: "fixture_read", arguments: '{"q":' } }] }) + chunk({ tool_calls: [{ index: 0, function: { arguments: '"合成"}' } }] }, "tool_calls") + "data: [DONE]\r\n\r\n");
  }));
  const result = await model.complete({ ...input, model: "override", messages: [...input.messages, { role: "assistant", content: "", tool_calls: [{ id: "old-call", name: "fixture_read", args: { q: "old" } }] }, { role: "tool", content: "{}", tool_call_id: "old-call" }] }, { token: text => tokens.push(text) });
  expect(result).toEqual({ content: "读取中文", tool_calls: [{ id: "provider-1", name: "fixture_read", args: { q: "合成" } }] }); expect(tokens.join("")).toBe("读取中文"); expect(requests).toBe(1);
});
test("truncated/malformed/limited streams never release tool calls, and failed requests are not retried", async () => {
  const call = { tool_calls: [{ index: 0, id: "provider-1", type: "function", function: { name: "fixture_read", arguments: "{}" } }] };
  const cases = [chunk(call), chunk(call, "tool_calls"), chunk(call, "length") + "data: [DONE]\n\n", chunk({ tool_calls: [{ ...call.tool_calls[0], function: { name: "fixture_read", arguments: "[]" } }] }, "tool_calls") + "data: [DONE]\n\n", chunk({ tool_calls: [{ ...call.tool_calls[0], function: { name: "not_registered", arguments: "{}" } }] }, "tool_calls") + "data: [DONE]\n\n", "data: not-json\n\n"];
  for (const text of cases) {
    let attempts = 0; const model = new ChatCompletionsModel(config(), fake(() => { attempts++; return streamed(text); }));
    await expect(model.complete(input, { token() {} })).rejects.toBeInstanceOf(Error); expect(attempts).toBe(1);
  }
});
test("JSON fallback and terminal content work; credential/provider errors and redirects stay redacted", async () => {
  const response = { choices: [{ message: { role: "assistant", content: "合成回复" }, finish_reason: "stop" }] };
  const tokens: string[] = [];
  expect(await new ChatCompletionsModel(config(), fake(() => Response.json(response))).complete(input, { token: t => tokens.push(t) })).toEqual({ content: "合成回复", tool_calls: [] });
  expect(tokens).toEqual(["合成回复"]);
  expect(await new ChatCompletionsModel(config(), fake(() => streamed(chunk({ content: "完成" }, "stop") + "data: [DONE]\n\n"))).complete(input, { token() {} })).toEqual({ content: "完成", tool_calls: [] });
  for (const status of [302, 401, 500]) {
    let attempts = 0;
    const outcome = await new ChatCompletionsModel(config(), fake(() => { attempts++; return new Response("synthetic-secret-response", { status }); })).complete(input, { token() {} }).then(() => ({ ok: true, error: "" }), cause => ({ ok: false, error: String(cause) }));
    expect(outcome.ok).toBe(false); expect(outcome.error).not.toContain("synthetic-secret"); expect(outcome.error).not.toContain("synthetic-token");
    expect(attempts).toBe(1);
  }
});
test("response size and cancellation are bounded, and network exceptions never reveal configuration", async () => {
  const oversized = new ChatCompletionsModel(config(), fake(() => new Response("x".repeat(4 * 1024 * 1024 + 1))));
  await expect(oversized.complete(input, { token() {} })).rejects.toBeInstanceOf(Error);
  const controller = new AbortController(); controller.abort();
  const model = new ChatCompletionsModel(config(), fake((_url, init) => { init?.signal?.throwIfAborted(); throw new Error("synthetic-token http://secret"); }));
  await expect(model.complete(input, { signal: controller.signal, token() {} })).rejects.toThrow("INTERNAL");
  await expect(model.complete(input, { token() {} })).rejects.toThrow("INTERNAL");
});

test("a complete terminal SSE event closes the reader even when a compatible server leaves the connection open", async () => {
  let sent = false, cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(chunk({ content: "结束" }, "stop") + "data: [DONE]\n\n")); } }, cancel() { cancelled = true; } }), { headers: { "Accept-Language": "zh", "Content-Type": "text/event-stream" } });
  expect(await new ChatCompletionsModel(config(), fake(() => response)).complete(input, { token() {} })).toEqual({ content: "结束", tool_calls: [] }); expect(cancelled).toBe(true);
});

test("configured Hub uses a local compatible model service without injected model or real credentials", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lumio-model-hub-"));
  let requests = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-provider-key");
    const body = await request.json() as { model: string; messages: { content: string }[]; tools?: unknown };
    expect(body.model).toBe("synthetic-model"); expect(Array.isArray(body.tools)).toBe(true);
    expect(body.messages.at(-1)?.content).toBe("你好"); requests++;
    return streamed(chunk({ content: "本地合成回答" }, "stop") + "data: [DONE]\n\n");
  } });
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  try {
    const store = await HubStore.open(temp); store.createActor("model-owner", "human");
    const token = store.createToken("model-owner", "model-owner"); store.close();
    const config = readConfig({ LUMIO_STATE_DIR: temp, LUMIO_ASSISTANT_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, LUMIO_ASSISTANT_MODEL: "synthetic-model", LUMIO_ASSISTANT_API_KEY: "synthetic-provider-key" });
    expect(JSON.stringify(config)).not.toContain("synthetic-provider-key");
    hub = await startHub({ ...config, port: 0 }, { log() {} });
    const chat = async (input: unknown) => {
      const response = await fetch(`http://127.0.0.1:${hub!.server.port}/v2/assistant/chat`, { method: "POST", headers: { "Accept-Language": "zh", Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
      expect(response.status).toBe(200); return AssistantChatResult.parse(await response.json());
    };
    const input = { request_id: "synthetic-http-model", message: "你好" };
    const result = await chat(input);
    expect(result.turn.status).toBe("done"); expect(result.messages.at(-1)?.content).toBe("本地合成回答");
    expect(await chat(input)).toEqual(result); expect(requests).toBe(1);
  } finally { await hub?.stop(); await provider.stop(true); await rm(temp, { recursive: true, force: true }); }
});

test("chat returns JSON and NDJSON after a model is silent past the server idle timeout", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lumio-chat-idle-"));
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  try {
    const store = await HubStore.open(temp);
    store.createActor("idle-owner", "human");
    const token = store.createToken("idle-owner", "idle-owner");
    store.close();
    hub = await startHub({ ...readConfig({ HOME: temp, LUMIO_STATE_DIR: temp }), port: 0 }, {
      log() {},
      assistantModel: {
        async complete() {
          await Bun.sleep(12_000);
          return { content: "Synthetic reply after thinking", tool_calls: [] };
        },
      },
    });
    const url = `http://127.0.0.1:${hub.server.port}/v2/assistant/chat`;
    const chat = (format: "application/json" | "application/x-ndjson") => fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: format },
      body: JSON.stringify({ request_id: `synthetic-idle-${format === "application/json" ? "json" : "ndjson"}`, message: "Synthetic slow query" }),
    });
    const [result, events] = await Promise.all([
      chat("application/json").then(async response => AssistantChatResult.parse(await response.json())),
      chat("application/x-ndjson").then(async response => (await response.text()).trim().split("\n")
        .map(line => AssistantEvent.parse(JSON.parse(line)))),
    ]);
    expect(result.turn.status).toBe("done");
    expect(result.messages.at(-1)?.content).toBe("Synthetic reply after thinking");
    expect(events.at(-1)).toMatchObject({
      type: "result", messages: expect.arrayContaining([expect.objectContaining({ content: "Synthetic reply after thinking" })]),
    });
  } finally { await hub?.stop(); await rm(temp, { recursive: true, force: true }); }
}, 25_000);

test("DeepSeek non-thinking mode is scoped to its official host, including config verification", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumio-deepseek-config-"));
  try {
    for (const base_url of ["https://api.deepseek.com", "https://api.deepseek.com/v1/", "https://api.deepseek.com/beta"]) {
      expect(modelRequestOptions(base_url)).toEqual({ thinking: { type: "disabled" } });
      const manager = new AssistantConfiguration({ home, fetch: fake((_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.thinking).toEqual({ type: "disabled" }); expect(body.stream).toBe(false);
        return Response.json({ choices: [{ message: { role: "assistant", content: "Synthetic ping" } }] });
      }) });
      await manager.update({ base_url, model: "deepseek-flash", api_key: "synthetic-token" });
    }
    for (const baseUrl of ["https://api.deepseek.com.example.invalid/v1", "https://example.invalid/api.deepseek.com", "http://127.0.0.1:1/v1"]) {
      expect(modelRequestOptions(baseUrl)).toEqual({});
      const model = new ChatCompletionsModel({ baseUrl, model: "deepseek-flash", credential: () => undefined }, fake((_url, init) => {
        expect(JSON.parse(String(init?.body))).not.toHaveProperty("thinking");
        return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Synthetic reply" } }] });
      }));
      await model.complete(input, { token() {} });
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const [status, reason, english, chinese] of [
  [400, "request", "format", "格式"], [422, "request", "parameters", "参数"],
  [401, "auth", "API key", "密钥"], [403, "auth", "permissions", "权限"],
  [402, "balance", "balance", "余额"], [404, "endpoint", "not found", "不存在"],
  [429, "rate_limit", "rate limit", "限流"], [408, "timeout", "timed out", "超时"],
  [413, "size", "too large", "过大"], [500, "unavailable", "unavailable", "不可用"],
  [503, "unavailable", "unavailable", "不可用"], [504, "timeout", "timed out", "超时"],
  [302, "rejected", "rejected", "拒绝"], [409, "rejected", "rejected", "拒绝"],
] as const) test(`HTTP ${status} gives actionable localized errors without exposing provider data or retrying`, async () => {
  let attempts = 0, cancelled = false;
  const model = new ChatCompletionsModel(config(), fake(() => {
    attempts++;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("synthetic-private-body synthetic-token")); }, cancel() { cancelled = true; } }),
      { status, statusText: "synthetic-private-status" });
  }));
  const cause = await model.complete(input, { token() {} }).catch(cause => cause);
  expect(cause).toMatchObject({ code: "INVALID", params: { key: `assistant-model.http.${reason}`, args: [status] } });
  for (const [locale, guidance] of [["en", english], ["zh", chinese]] as const) {
    const message = withLanguage(locale, () => errorMessage(cause));
    expect(message).toContain(`HTTP ${status}`); expect(message).toContain(guidance);
    expect(message).not.toContain("synthetic-private"); expect(message).not.toContain("synthetic-token");
  }
  expect(attempts).toBe(1); expect(cancelled).toBe(true);
});

test("DeepSeek completes tool continuations and saved conversation history; HTTP errors reach JSON, history and NDJSON", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lumio-deepseek-hub-"));
  let hub: Awaited<ReturnType<typeof startHub>> | undefined, calls = 0, failureStatus: number | undefined;
  const model = () => new ChatCompletionsModel({ baseUrl: "https://api.deepseek.com", model: "deepseek-flash", credential: () => "synthetic-key" }, fake((_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    // Faithful regression: without the explicit toggle, a continuation without
    // reasoning_content is rejected by DeepSeek's default thinking mode.
    if (body.thinking?.type !== "disabled" && body.messages.some((message: { role: string }) => message.role === "assistant")) {
      return Response.json({ error: { message: "The reasoning_content in the thinking mode must be passed back to the API." } }, { status: 400 });
    }
    if (failureStatus) return new Response("synthetic-private-provider-error", { status: failureStatus });
    expect(body.tools.some((tool: { function: { name: string } }) => tool.function.name === toolName("work.task.list"))).toBe(true);
    if (body.messages.at(-1).role === "user") {
      return streamed(chunk({ tool_calls: [{ index: 0, id: "synthetic-provider-call", type: "function", function: { name: toolName("work.task.list"), arguments: "{}" } }] }, "tool_calls") + "data: [DONE]\n\n");
    }
    const last = body.messages.at(-1), prior = body.messages.at(-2);
    expect(last.role).toBe("tool"); expect(last.tool_call_id).toBe(prior.tool_calls[0].id);
    expect(JSON.parse(last.content)).toEqual([]);
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Synthetic task list is empty." } }] });
  }));
  try {
    const store = await HubStore.open(temp); store.createActor("synthetic-owner", "human");
    const token = store.createToken("synthetic-owner", "synthetic-owner"); store.close();
    const start = () => startHub({ ...readConfig({ HOME: temp, LUMIO_STATE_DIR: temp }), port: 0 }, { log() {}, assistantModel: model() });
    hub = await start();
    const chat = async (request_id: string, conversation?: string, stream = false, locale = "zh") => fetch(`http://127.0.0.1:${hub!.server.port}/v2/assistant/chat`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept-Language": locale,
        ...(stream ? { Accept: "application/x-ndjson" } : {}) },
      body: JSON.stringify({ request_id, message: "Synthetic task query", ...(conversation ? { conversation } : {}) }),
    });
    const first = AssistantChatResult.parse(await (await chat("synthetic-deepseek-first")).json());
    expect(first.turn.status).toBe("done"); expect(first.messages.at(-1)?.content).toBe("Synthetic task list is empty.");
    expect(first.messages.some(message => message.role === "tool")).toBe(true); expect(calls).toBe(2);
    // An adapter memory cache cannot repair persisted history after a restart.
    await hub.stop(); hub = await start();
    const second = AssistantChatResult.parse(await (await chat("synthetic-deepseek-next", first.conversation.id)).json());
    expect(second.turn.status).toBe("done"); expect(calls).toBe(4);
    failureStatus = 429;
    const failed = AssistantChatResult.parse(await (await chat("synthetic-deepseek-failed", first.conversation.id)).json());
    expect(failed.turn.status).toBe("failed"); expect(failed.turn.error).toContain("HTTP 429"); expect(failed.turn.error).toContain("限流");
    const detailResponse = await fetch(`http://127.0.0.1:${hub.server.port}/v2/assistant/conversations/${first.conversation.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const detail = AssistantConversationDetail.parse(await detailResponse.json());
    expect(detail.turns.find(turn => turn.id === failed.turn.id)?.error).toBe(failed.turn.error);
    failureStatus = 402;
    const stream = await chat("synthetic-deepseek-stream-failed", undefined, true, "en");
    const events = (await stream.text()).trim().split("\n").map(line => AssistantEvent.parse(JSON.parse(line)));
    const error = events.find(event => event.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type === "error") { expect(error.error).toContain("HTTP 402"); expect(error.error).toContain("balance"); }
    expect(JSON.stringify(events)).not.toContain("synthetic-private-provider-error"); expect(calls).toBe(6);
  } finally { await hub?.stop(); await rm(temp, { recursive: true, force: true }); }
});

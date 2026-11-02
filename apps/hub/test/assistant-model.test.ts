import { expect, test } from "bun:test";
import { ChatCompletionsModel, configuredModel, modelConfiguration } from "../src/assistant-model.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantChatResult } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";
import { readConfig } from "../src/config.ts";
import type { AssistantModelRequest } from "@lumio/schema";
const input: AssistantModelRequest = { messages: [{ role: "user", content: "合成问题" }], tools: [{ name: "fixture_read", description: "synthetic", input_schema: { type: "object" } }] };
const config = () => modelConfiguration({ LUMIO_ASSISTANT_BASE_URL: "http://127.0.0.1:1/v1/", LUMIO_ASSISTANT_MODEL: "synthetic-model", LUMIO_ASSISTANT_API_KEY: "synthetic-token" })!;
const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
function streamed(text: string): Response {
  const bytes = new TextEncoder().encode(text); let index = 0;
  return new Response(new ReadableStream({ pull(controller) { if (index >= bytes.length) controller.close(); else controller.enqueue(bytes.slice(index, ++index)); } }), { headers: { "Content-Type": "text/event-stream" } });
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
  await expect(model.complete(input, { signal: controller.signal, token() {} })).rejects.toThrow("取消或超时");
  await expect(model.complete(input, { token() {} })).rejects.toThrow("无法连接模型服务");
});

test("a complete terminal SSE event closes the reader even when a compatible server leaves the connection open", async () => {
  let sent = false, cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(chunk({ content: "结束" }, "stop") + "data: [DONE]\n\n")); } }, cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } });
  expect(await new ChatCompletionsModel(config(), fake(() => response)).complete(input, { token() {} })).toEqual({ content: "结束", tool_calls: [] }); expect(cancelled).toBe(true);
});

test("configured Hub uses a local compatible model service without injected model or real credentials", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lumio-model-hub-"));
  let requests = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-provider-key");
    const body = await request.json() as { model: string; messages: { content: string }[]; tools?: unknown };
    expect(body.model).toBe("synthetic-model"); expect(body.tools).toBeUndefined();
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
      const response = await fetch(`http://127.0.0.1:${hub!.server.port}/v2/assistant/chat`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
      expect(response.status).toBe(200); return AssistantChatResult.parse(await response.json());
    };
    const input = { request_id: "synthetic-http-model", message: "你好" };
    const result = await chat(input);
    expect(result.turn.status).toBe("done"); expect(result.messages.at(-1)?.content).toBe("本地合成回答");
    expect(await chat(input)).toEqual(result); expect(requests).toBe(1);
  } finally { await hub?.stop(); await provider.stop(true); await rm(temp, { recursive: true, force: true }); }
});

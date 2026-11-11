import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantModel, AssistantTool } from "@lumio/assistant";
import { newId } from "@lumio/foundation";
import {
  AIConnection, AIProfile, ApiError, AssistantChatRequest, AssistantChatResult, AssistantConversation, AssistantEvent,
  CAPABILITIES, NativeMCPRequest, NativeMCPResult, NativeRuntimeCommand, NativeRuntimeMessage, ResourceRef, ResourceSummary,
  WORKBENCH_TOOLS, WorkCommandResult, WorkbenchSearchResult, toolName,
  type AssistantModelRequest, type AssistantModelResponse,
} from "@lumio/schema";
import { authorize } from "../src/authorize.ts";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";

const publicRef = ResourceRef.parse({ module: "knowledge", id: "pap_00000000000000000000000001" });
const privateRef = ResourceRef.parse({ module: "knowledge", id: "ast_00000000000000000000000007" });
const missingRef = ResourceRef.parse({ module: "knowledge", id: "pap_00000000000000000000000009" });
const actionNames = WORKBENCH_TOOLS.map(toolName);
const tool = (name: string, args: Record<string, unknown> = {}) => ({ id: randomUUID(), name: toolName(name), args });
const call = (...tool_calls: AssistantModelResponse["tool_calls"]): AssistantModelResponse => ({ content: "", tool_calls });
const done = { content: "Synthetic reply.", tool_calls: [] };

async function fixture(model?: AssistantModel, options: { authorize?: typeof authorize; assistantTools?: AssistantTool[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lumio-a1-4-")), vault = join(root, "vault");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url), vault, { recursive: true });
  const hub = await startHub({ ...readConfig({ HOME: root, LUMIO_STATE_DIR: join(root, "state"), LUMIO_VAULT: vault }),
    port: 0, localRuntime: "server" }, { ...options, assistantModel: model, log() {} });
  const credential = (name: string, role: "human" | "agent" | "runtime" = "human") => {
    const actor = hub.store.createActor(name, role);
    return { actor, token: hub.store.createToken(name, name) };
  };
  const owner = credential("owner");
  const api = (path: string, body?: unknown, token = owner.token, stream = false) => fetch(new URL(path, hub.server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(stream ? { Accept: "application/x-ndjson" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const seed = (actor = owner.actor, main = true) => {
    const now = new Date(), time = now.toISOString();
    const id = newId("conv", now, randomBytes);
    hub.modules.assistantStore.putConversation(AssistantConversation.parse({ id, owner: actor.id, title: "Synthetic chat", revision: 1,
      created: time, updated: time }));
    if (main) hub.modules.assistantMain.bindMain(actor.id, id);
    return id;
  };
  const chat = (conversation: string, input: Partial<AssistantChatRequest> = {}, stream = true, token = owner.token) =>
    api("/v2/assistant/chat", AssistantChatRequest.parse({ request_id: randomUUID(), message: "Display the requested workbench items.", conversation, ...input }), token, stream);
  return { hub, owner, credential, api, seed, chat, close: async () => { await hub.stop(); await rm(root, { recursive: true, force: true }); } };
}

async function stream(response: Response): Promise<AssistantEvent[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("application/x-ndjson");
  return (await response.text()).trim().split("\n").map(line => AssistantEvent.parse(JSON.parse(line)));
}

const ui = (events: AssistantEvent[]) => events.filter(event => event.type === "ui");
const failed = (events: AssistantEvent[]) => events.flatMap(event =>
  event.type === "tool" && event.tool.status === "failed" ? [event.tool.result] : []);

test("only the main chat receives workbench tools and an in-flight retry receives no UI events", async () => {
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  let project: ResourceRef;
  const f = await fixture({ async complete(input) {
    const names = input.tools.map(spec => spec.name);
    if (input.messages.at(-1)?.content === "Ordinary") {
      expect(names).toEqual(CAPABILITIES.map(capability => toolName(capability.name)));
      return call(tool("ui.clear"));
    }
    if (input.messages.at(-1)?.role === "tool") return done;
    expect(names.filter(name => actionNames.includes(name))).toEqual(actionNames);
    entered.resolve();
    await resume.promise;
    return call(tool("ui.navigate", { section: "work", target: { ...project, label: "Model supplied label" } }),
      tool("ui.highlight", { refs: [publicRef] }), tool("ui.show", { panel: { kind: "refs", refs: [publicRef] } }),
      tool("ui.show", { panel: { kind: "dependency_graph", project } }), tool("ui.clear"));
  } });
  try {
    const regular = f.seed(f.owner.actor, false), main = f.seed();
    const created = WorkCommandResult.parse(await (await f.api("/v2/work/commands", {
      request_id: randomUUID(), operation: { op: "work.project.create", args: { title: "Synthetic dependency project" } },
    })).json());
    if (created.kind !== "project") throw new Error("Expected a project");
    project = ResourceRef.parse({ module: "work", id: created.project.id });
    const request_id = randomUUID();
    const original = f.chat(main, { request_id }).then(stream);
    await entered.promise;
    const retryEvents: AssistantEvent[] = [];
    const inFlight = f.hub.modules.assistant.chat({
      request_id, conversation: main, message: "Display the requested workbench items.",
    }, f.owner.actor.id, { event: event => retryEvents.push(event) });
    resume.resolve();
    const first = await original;
    const retried = AssistantChatResult.parse(await inFlight);
    expect(first.at(-1)).toMatchObject({ type: "result", turn: retried.turn.id });
    expect(retryEvents).toEqual([]);
    const second = await stream(await f.chat(main, { request_id }));
    expect(ui(first).map(event => event.action)).toEqual([
      { action: "navigate", section: "work", target: project },
      { action: "highlight", refs: [publicRef] },
      { action: "show", panel: { kind: "refs", refs: [publicRef] } },
      { action: "show", panel: { kind: "dependency_graph", project } },
      { action: "clear" },
    ]);
    expect(ui(first).every(event => first.some(toolEvent => toolEvent.type === "tool"
      && toolEvent.turn === event.turn && toolEvent.tool.id === event.tool && toolEvent.tool.status === "succeeded"))).toBe(true);
    expect(ui(second)).toEqual([]);
    expect(second.at(-1)).toMatchObject({ type: "result", turn: first.at(-1)?.turn });
    expect(ui(await stream(await f.chat(regular, { message: "Ordinary" })))).toEqual([]);
    const agent = f.credential("agent", "agent");
    expect((await f.chat(main, {}, true, agent.token)).status).toBe(403);
    expect(() => f.hub.modules.assistantMain.bindMain(agent.actor.id, f.seed(agent.actor, false))).toThrow();
    const other = f.credential("other");
    expect(() => f.hub.modules.assistantMain.bindMain(other.actor.id, main)).toThrow();
    expect(() => f.hub.modules.assistantMain.bindMain(f.owner.actor.id, regular)).toThrow();
  } finally { resume.resolve(); await f.close(); }
});

test("invalid routes, private notes and agent-denied references fail the entire action", async () => {
  let deniedProject: ResourceRef;
  const f = await fixture({ async complete(input) {
    return input.messages.at(-1)?.role === "tool" ? done : call(
      tool("ui.navigate", { section: "settings" }),
      tool("ui.navigate", { section: "execution", target: publicRef }),
      tool("ui.navigate", { section: "knowledge", target: publicRef, url: "https://example.test" }),
      tool("ui.clear", { action: "clear" }),
      tool("ui.highlight", { refs: [publicRef, privateRef] }),
      tool("ui.show", { panel: { kind: "refs", refs: [publicRef, missingRef] } }),
      tool("ui.show", { panel: { kind: "dependency_graph", project: deniedProject } }),
    );
  } }, {
    authorize: (actor, input) => actor?.role === "agent" && input.operation === "work.read"
      ? { result: "deny", reason: "synthetic denied work read" } : authorize(actor, input),
  });
  try {
    const main = f.seed();
    const result = WorkCommandResult.parse(await (await f.api("/v2/work/commands", {
      request_id: randomUUID(), operation: { op: "work.project.create", args: { title: "Synthetic restricted project" } },
    })).json());
    if (result.kind !== "project") throw new Error("Expected a project");
    deniedProject = ResourceRef.parse({ module: "work", id: result.project.id });
    expect(ResourceSummary.parse(await (await f.api(`/v2/resources/${privateRef.id}?include_private=true`)).json()).status).toBe("visible");
    const events = await stream(await f.chat(main));
    expect(ui(events)).toEqual([]);
    expect(failed(events)).toMatchObject([
      { code: "INVALID" }, { code: "INVALID" }, { code: "INVALID" }, { code: "INVALID" },
      { code: "FORBIDDEN" }, { code: "FORBIDDEN" }, { code: "FORBIDDEN" },
    ]);
    expect(events.at(-1)?.type).toBe("result");
  } finally { await f.close(); }
});

test("search cards require their exact tool result to have reached the model in the same turn", async () => {
  const card = WorkbenchSearchResult.parse({ title: "Synthetic result", url: "https://example.test/search", snippet: "Synthetic snippet" });
  const show = (result: WorkbenchSearchResult) => tool("ui.show", { panel: { kind: "search", results: [result] } });
  let step = 0;
  const f = await fixture({ async complete(input) {
    if (input.messages.at(-1)?.content === "Try a card from the preceding turn") return call(show(card));
    switch (step++) {
      case 0: return call(tool("fixture_search"), show(card));
      case 1: return call(show(card), show({ ...card, snippet: "Invented snippet" }), show({ ...card, url: "https://example.test/other" }));
      default: return done;
    }
  } }, { assistantTools: [{ spec: { name: "fixture_search", description: "Fixture search", input_schema: { type: "object" } },
    effect: "read", execute: async () => ({ results: [card] }) }] });
  try {
    const main = f.seed();
    const first = await stream(await f.chat(main));
    expect(ui(first).map(event => event.action)).toEqual([{ action: "show", panel: { kind: "search", results: [card] } }]);
    expect(failed(first)).toMatchObject([{ code: "FORBIDDEN" }, { code: "FORBIDDEN" }, { code: "FORBIDDEN" }]);
    const second = await stream(await f.chat(main, { message: "Try a card from the preceding turn" }));
    expect(ui(second)).toEqual([]);
    expect(failed(second)).toMatchObject([{ code: "FORBIDDEN" }]);
  } finally { await f.close(); }
});

test("a main chat with a JSON response cannot report a display action as successful", async () => {
  let toolResult: AssistantModelRequest["messages"][number] | undefined;
  const f = await fixture({ async complete(input) {
    if (input.messages.at(-1)?.role !== "tool") return call(tool("ui.clear"));
    toolResult = input.messages.at(-1);
    return done;
  } });
  try {
    const main = f.seed();
    const response = await f.chat(main, {}, false);
    expect(response.status).toBe(200);
    expect(AssistantChatResult.parse(await response.json()).turn.status).toBe("done");
    expect(JSON.parse(toolResult!.content)).toMatchObject({ code: "CONFLICT", reason: "The initiating chat stream is unavailable" });
  } finally { await f.close(); }
});

test("model reload and conversation deletion reach the main chat", async () => {
  const entered = Promise.withResolvers<void>();
  const f = await fixture();
  try {
    const main = f.seed();
    f.hub.modules.assistant.setModel({ complete(input, { signal }) {
      expect(input.tools.map(spec => spec.name)).toContain(toolName("ui.clear"));
      entered.resolve();
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    } });
    const chat = f.chat(main);
    await entered.promise;
    const deleted = await fetch(new URL(`/v2/assistant/conversations/${main}`, f.hub.server.url), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${f.owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: randomUUID() }),
    });
    expect(deleted.status).toBe(200);
    expect((await stream(await chat)).at(-1)?.type).toBe("error");
    expect(f.hub.modules.assistantMain.mainConversation(f.owner.actor.id)).toBeUndefined();
  } finally { await f.close(); }
});

test("native MCP exposes workbench tools only on a new main session and uses the active turn's stream", async () => {
  const f = await fixture();
  try {
    const runtime = f.credential("server", "runtime");
    f.hub.store.registerRuntime(runtime.actor.id, {
      protocol_version: 2, name: "server", engines: [{ name: "codex", version: "synthetic", sandbox: "os" }], tags: [], max_concurrent: 1,
    }, new Date());
    const native = f.hub.modules.native;
    const opens = new Map<string, string>();
    const turns = new Map<string, (turn: string) => void>();
    const channel = {
      id: randomUUID(), data: { runtime: runtime.actor.id }, close() {}, terminate() {},
      send(raw: string) {
        const packet = NativeRuntimeCommand.parse(JSON.parse(raw));
        if (packet.type === "open") opens.set(packet.session.id, packet.mcp_token);
        if (packet.type === "turn") turns.get(packet.session)?.(packet.turn);
      },
    };
    native.channelOpen(channel);
    const receive = (message: unknown) => native.channelMessage(channel, JSON.stringify(NativeRuntimeMessage.parse(message)));
    receive({ type: "hello", protocol: 1, instance: "synthetic", version: "synthetic", isolation: "macos-seatbelt" });
    const connection = AIConnection.parse(await (await f.api("/v2/ai/connections", { name: "Synthetic", kind: "codex-account", host: "server" })).json());
    const profile = AIProfile.parse(await (await f.api("/v2/ai/profiles", { name: "Synthetic", connection: connection.id,
      engine: "codex", model: "default" })).json());
    const ordinary = await native.create(f.owner.actor.id, { request_id: randomUUID(), profile: profile.id });
    const main = await native.create(f.owner.actor.id, { request_id: randomUUID(), profile: profile.id }, { main: true });
    const event = (session: string, sequence: number, event: object, turn?: string) =>
      receive({ type: "event", session, sequence, event, turn });
    const mcp = (session: string, endpoint: "tools" | "call", body?: unknown) =>
      f.api(`/v2/native-mcp/${session}/${endpoint}`, body, opens.get(session)!);
    const start = async (session: typeof main) => {
      event(session.id, 1, { type: "state", view: { state: "ready", models: [] } });
      const names = (await (await mcp(session.id, "tools")).json() as { tools: { name: string }[] }).tools.map(tool => tool.name);
      const start = Promise.withResolvers<string>();
      turns.set(session.id, start.resolve);
      const response = f.chat(session.conversation);
      const turn = await Promise.race([start.promise, response.then(result => {
        if (!result.ok) throw new Error(`Native turn did not start: ${result.status}`);
        return start.promise;
      })]);
      return { names, response, turn };
    };
    const first = await start(ordinary), second = await start(main);
    try {
      expect(first.names).toEqual(CAPABILITIES.map(capability => toolName(capability.name)));
      expect(second.names.filter(name => actionNames.includes(name))).toEqual(actionNames);
      const request = NativeMCPRequest.parse({ session: main.id, request_id: randomUUID(), tool: toolName("ui.highlight"), args: { refs: [publicRef] } });
      const rejected = await mcp(ordinary.id, "call", { ...request, session: ordinary.id });
      expect(rejected.status).toBe(403);
      expect(ApiError.parse(await rejected.json()).error.code).toBe("FORBIDDEN");
      const privateCall = await mcp(main.id, "call", { ...request, request_id: randomUUID(), args: { refs: [publicRef, privateRef] } });
      expect(privateCall.status).toBe(403);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await mcp(main.id, "call", request);
        expect(response.status).toBe(200);
        expect(NativeMCPResult.parse(await response.json()).result).toEqual({ displayed: true });
      }
    } finally {
      event(ordinary.id, 2, { type: "complete", status: "done", text: "Ordinary completed." }, first.turn);
      event(main.id, 2, { type: "complete", status: "done", text: "Main completed." }, second.turn);
    }
    expect(ui(await stream(await first.response))).toEqual([]);
    expect(ui(await stream(await second.response))).toEqual([
      { type: "ui", turn: second.turn, tool: expect.stringMatching(/^tool_/), action: { action: "highlight", refs: [publicRef] } },
    ]);
    const late = await mcp(main.id, "call", { request_id: randomUUID(), tool: toolName("ui.clear"), args: {} });
    expect(late.status).toBe(403);
  } finally { await f.close(); }
});

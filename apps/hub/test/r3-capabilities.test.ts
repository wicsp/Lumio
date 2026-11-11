import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Actor, ApiError, AssistantChatResult, AssistantConfigView, AssistantToolCall, CAPABILITIES, WorkAttention,
  WorkCommandResult, WorkTask, WorkTaskDetail, Job, toolName } from "@lumio/schema";
import type { AssistantModel } from "@lumio/assistant";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { HubStore } from "../src/store.ts";
import { authorize } from "../src/authorize.ts";
import { AssistantConfiguration } from "../src/assistant-config.ts";
import { assistantConfiguration } from "../src/assistant-setup.ts";
import { modelConfiguration } from "../src/assistant-model.ts";

let temp: string, hub: Awaited<ReturnType<typeof startHub>>, human: string, agent: string, runtime: string, logs: string[];
let model: AssistantModel;
let sequence = 0;
const requestId = () => `synthetic-r3-request-${++sequence}`;
const url = () => `http://127.0.0.1:${hub.server.port}`;
async function checked<T>(path: string, schema: { parse(value: unknown): T }, body?: unknown, method?: string): Promise<T> {
  const response = await api(path, body, human, method); const value = await response.json();
  if (!response.ok) throw Object.assign(new Error("HTTP failure"), ApiError.parse(value).error);
  return schema.parse(value);
}
const client = () => ({
  assistantChat: (body: unknown) => checked("/v2/assistant/chat", AssistantChatResult, body),
  assistantTools: (id: string) => checked(`/v2/assistant/conversations/${id}/tools`, AssistantToolCall.array()),
  workTask: (id: string) => checked(`/v2/work/tasks/${id}`, WorkTaskDetail),
  undoAssistantTool: (id: string, request_id: string) => checked(`/v2/assistant/tools/${id}/undo`, WorkCommandResult, { request_id }),
  workAttention: () => checked("/v2/work/attention", WorkAttention.array()),
  job: (id: string) => checked(`/v1/jobs/${id}`, Job),
  assistantConfig: () => checked("/v2/assistant/config", AssistantConfigView),
  updateAssistantConfig: (body: unknown) => checked("/v2/assistant/config", AssistantConfigView, body, "PUT"),
  clearAssistantConfig: () => checked("/v2/assistant/config", AssistantConfigView, undefined, "DELETE"),
});
async function api(path: string, body?: unknown, token = human, method = body === undefined ? "GET" : "POST") {
  return fetch(url() + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function command(op: string, args: object, token = human, id = requestId()) {
  const response = await api("/v2/work/commands", { request_id: id, operation: { op, args } }, token);
  expect(response.status).toBe(200); return WorkCommandResult.parse(await response.json());
}
async function task(args: object = {}) {
  const result = await command("work.task.create", { title: "Synthetic task", ...args });
  if (result.kind !== "task") throw new Error("task expected"); return result.task;
}
async function dispatch(id: string, args: object = {}) {
  const result = await command("work.task.dispatch", { to: "pi@server", task: id, ...args });
  if (result.kind !== "job") throw new Error("job expected"); return result.job;
}
async function finish(job: Job, status: "done" | "waiting_for_human" | "failed" | "unknown") {
  expect((await api("/v1/runtime/ack", { accepted: [job.spec.id] }, runtime)).status).toBe(200);
  expect((await api("/v1/runtime/results", { job: job.spec.id, lease: job.spec.lease, status, finished: new Date().toISOString(),
    report: "Synthetic report ".repeat(60), ...(status === "waiting_for_human" ? { question: "Which synthetic input?" } : {}) }, runtime)).status).toBe(200);
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-r3-")); logs = [];
  const vault = join(temp, "vault"); await cp(new URL("../../../fixtures/query-vault", import.meta.url), vault, { recursive: true });
  const store = await HubStore.open(join(temp, "state"));
  store.createActor("owner", "human"); store.createActor("agent", "agent"); const actor = store.createActor("server", "runtime");
  human = store.createToken("human", "owner"); agent = store.createToken("agent", "agent"); runtime = store.createToken("runtime", "server");
  store.registerRuntime(actor.id, { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "synthetic", sandbox: "none" }], tags: [], max_concurrent: 1 }, new Date());
  store.close();
  model = { async complete() { return { content: "Synthetic reply", tool_calls: [] }; } };
  hub = await startHub({ ...readConfig({ HOME: temp, LUMIO_STATE_DIR: join(temp, "state"), LUMIO_VAULT: vault }), localRuntime: "server", port: 0 }, {
    log: line => logs.push(line), assistantModel: { complete: (input, options) => model.complete(input, options) },
  });
});
afterEach(async () => { await hub?.stop(); await rm(temp, { recursive: true, force: true }); });

const actor = Actor.parse({ id: "act_00000000000000000000000001", name: "fixture", role: "agent", created: "2026-01-01T00:00:00Z" });
for (const [op, args, reason] of [
  ["work.task.finish", {}, "agent-operation-not-allowed"],
  ["work.task.reopen", {}, "agent-operation-not-allowed"],
  ["work.task.checkpoint", {}, "agent-operation-not-allowed"],
  ["work.task.hand", { to: "nobody" }, "agent-cannot-hand-to-nobody"],
  ["execution.routine.create", {}, "agent-cannot-change-routines"],
  ["execution.routine.update", {}, "agent-cannot-change-routines"],
  ["approval.proposal.accept", {}, "agent-cannot-decide-proposals"],
  ["approval.proposal.reject", {}, "agent-cannot-decide-proposals"],
  ["work.task.delete", {}, "agent-cannot-delete-or-archive"],
  ["work.project.archive", {}, "agent-cannot-delete-or-archive"],
  ["work.task.acknowledge", {}, "agent-operation-not-allowed"],
] as const) test(`agent refusal: ${op} ${JSON.stringify(args)}`, () => {
  expect(authorize(actor, { operation: op, args })).toEqual({ result: "deny", reason });
  expect(authorize(actor, { operation: "work.command", command: op, args })).toEqual({ result: "deny", reason });
});

test("catalog tools validate arguments, preserve identity, expose todo/create/comment, and return a clear denial to the model", async () => {
  let step = 0, created = "";
  model = { async complete(input) {
    expect(input.tools.map(value => value.name)).toEqual(CAPABILITIES.map(value => toolName(value.name)));
    if (step++ === 0) return { content: "", tool_calls: [{ id: "provider-1", name: toolName("work.task.list"), args: { status: "todo" } }] };
    if (step === 2) { expect(JSON.parse(input.messages.at(-1)!.content)).toEqual([]); return { content: "", tool_calls: [{ id: "provider-2", name: toolName("work.task.create"), args: { title: "From conversation" } }] }; }
    if (step === 3) { created = JSON.parse(input.messages.at(-1)!.content).task.id; return { content: "", tool_calls: [{ id: "provider-3", name: toolName("work.task.comment"), args: { task: created, body: "Synthetic comment" } }] }; }
    if (step === 4) return { content: "", tool_calls: [{ id: "provider-4", name: toolName("work.task.update"), args: { task: created, expected_revision: 1, patch: { status: "done" } } }] };
    const failure = JSON.parse(input.messages.at(-1)!.content); expect(failure.code).toBe("INVALID");
    return { content: "Only you can mark a task done.", tool_calls: [] };
  } };
  const chat = await client().assistantChat({ request_id: requestId(), message: "Make a todo and comment" });
  expect(AssistantChatResult.parse(chat).turn.status).toBe("done");
  const calls = await client().assistantTools(chat.conversation.id);
  expect(calls).toHaveLength(4); expect(calls[1]?.change).toMatchObject({ capability: "work.task.create", target: created, after_revision: 1 });
  expect(calls[2]?.change?.target).toBe(created);
  const detail = await client().workTask(created); expect(detail.task.created_by).toBe(hub.store.assistantActor().id);
  expect(detail.comments[0]?.author).toBe(hub.store.assistantActor().id); expect(detail.task.turn.reason).toBe("todo");
  await expect(hub.modules.capabilities.execute("work.task.create", { title: "x", injected: true }, hub.store.authenticate(`Bearer ${agent}`)! , requestId())).rejects.toMatchObject({ code: "INVALID" });
  await expect(hub.modules.capabilities.execute("work.task.create", { title: "x" }, hub.store.authenticate(`Bearer ${agent}`)!)).rejects.toMatchObject({ code: "INVALID" });
});

test("HTTP agents can read and write low-risk fields but cannot dispatch, approve, acknowledge or set terminal statuses", async () => {
  const created = await command("work.task.create", { title: "Agent created" }, agent);
  if (created.kind !== "task") throw new Error("task expected");
  expect(created.task.created_by).toBe(hub.store.authenticate(`Bearer ${agent}`)!.actor.id);
  for (const to of ["external", "human"] as const) {
    const current = hub.modules.work.task(created.task.id);
    await command("work.task.hand", { task: current.id, expected_revision: current.revision, to, ...(to === "external" ? { note: "Synthetic wait" } : {}) }, agent);
  }
  for (const op of ["work.task.finish", "work.task.reopen", "work.task.hand", "work.task.checkpoint"]) {
    const args = op.endsWith("hand") ? { task: created.task.id, expected_revision: 3, to: "nobody" } : op.endsWith("checkpoint") ? { task: created.task.id, stage: "end", action: "finish" }
      : { task: created.task.id, expected_revision: 3, ...(op.endsWith("finish") ? { outcome: "cancelled" } : {}) };
    const response = await api("/v2/work/commands", { request_id: requestId(), operation: { op, args } }, agent);
    expect(response.status).toBe(403); expect(ApiError.parse(await response.json()).error.reason).toMatch(/^agent-/);
  }
  const proposal = hub.store.createProposal({ op: "task.dispatch", args: { task: created.task.id, trigger: "cli" } }, "synthetic", hub.store.authenticate(`Bearer ${human}`)!.actor.id);
  const denied = await api(`/v1/proposals/${proposal.id}/accept`, {}, agent); expect(denied.status).toBe(403);
  expect(ApiError.parse(await denied.json()).error.reason).toBe("agent-cannot-decide-proposals");
  for (const path of ["/v2/work/tasks", "/v2/work/projects", "/v2/work/attention", "/v2/execution/routines", "/v1/jobs"]) expect((await api(path, undefined, agent)).status).toBe(200);
  for (const def of CAPABILITIES.filter(value => value.kind === "write")) expect(def.result).toBeDefined();
});

test("assistant can adjust prerequisites through the task update tool while cycles are rejected", async () => {
  const prerequisite = await task({ title: "Existing prerequisite" });
  const added = await task({ title: "New prerequisite" });
  const dependent = await task({ title: "Dependent task", dependencies: [prerequisite.id] });
  let step = 0;
  model = { async complete(input) {
    const update = input.tools.find(tool => tool.name === toolName("work.task.update"));
    expect(update?.description).toContain("patch.dependencies");
    const last = input.messages.at(-1);
    if (step++ === 0) return { content: "", tool_calls: [
      { id: "read", name: toolName("work.task.show"), args: { task: dependent.id } },
    ] };
    if (step === 2) {
      const current = WorkTaskDetail.parse(JSON.parse(last!.content)).task;
      return { content: "", tool_calls: [{ id: "add", name: update!.name, args: {
        task: current.id, expected_revision: current.revision, patch: { dependencies: [...current.dependencies, added.id] },
      } }] };
    }
    if (step === 3) return { content: "", tool_calls: [{ id: "cycle", name: update!.name, args: {
      task: added.id, expected_revision: added.revision, patch: { dependencies: [dependent.id] },
    } }] };
    if (step === 4) {
      expect(JSON.parse(last!.content).code).toBe("CONFLICT");
      return { content: "", tool_calls: [{ id: "remove", name: update!.name, args: {
        task: dependent.id, expected_revision: dependent.revision + 1, patch: { dependencies: [added.id] },
      } }] };
    }
    return { content: "Adjusted prerequisites", tool_calls: [] };
  } };
  const chat = await client().assistantChat({ request_id: requestId(), message: "Adjust these synthetic prerequisites" });
  expect(chat.turn.status).toBe("done");
  const calls = await client().assistantTools(chat.conversation.id);
  expect(calls.map(call => call.status)).toEqual(["succeeded", "succeeded", "failed", "succeeded"]);
  expect(calls[1]?.change?.before).toEqual({ dependencies: [prerequisite.id] });
  const current = (await client().workTask(dependent.id)).task;
  expect(current.dependencies).toEqual([added.id]);
  expect(current.outcome).toBe(dependent.outcome);
  expect((await client().workTask(added.id)).task.dependencies).toEqual([]);
});

test("private reads require the in-process tool closure and a human owner; each read is marked and audited", async () => {
  for (const name of ["knowledge.note.show", "knowledge.note.search", "knowledge.note.links"]) {
    let step = 0;
    model = { async complete() { return step++ === 0 ? { content: "", tool_calls: [{ id: "synthetic", name: toolName(name), args: name.endsWith("search") ? { query: "privateonly" } : { ref: "Private" } }] } : { content: "Synthetic private answer", tool_calls: [] }; } };
    const chat = await client().assistantChat({ request_id: requestId(), message: "Read private fixture" });
    const calls = await client().assistantTools(chat.conversation.id);
    expect(AssistantToolCall.parse(calls[0]).private_read).toBe(true);
    expect(hub.store.db.query("SELECT * FROM audit WHERE operation=? AND execution_result='private-read'").all(name)).toHaveLength(1);
    step = 0;
    const agentOwner = hub.store.authenticate(`Bearer ${agent}`)!.actor.id;
    const agentChat = await hub.modules.assistant.chat({ request_id: requestId(), message: "Read private fixture" }, agentOwner);
    const agentCalls = hub.modules.assistantStore.calls(agentChat.turn.id);
    expect(agentCalls[0]?.private_read).not.toBe(true);
    expect(JSON.stringify(agentCalls)).not.toContain("私密发现");
  }
  expect((await api("/v1/notes/Private", undefined, agent)).status).toBe(404);
  expect((await api("/v1/notes/Private?include_private=true", undefined, agent)).status).toBe(403);
  const injection = await api("/v2/work/tasks?humanConversation=true", undefined, agent); expect(injection.status).toBe(400);
  // Private reads never become implicit memory.
  expect(await hub.modules.assistant.memories(hub.store.authenticate(`Bearer ${human}`)!.actor.id)).toEqual([]);
});

test("update changes record nullable before fields; undo uses revision checks, survives retries and refuses conflicts", async () => {
  const created = await task();
  let step = 0;
  model = { async complete() { return step++ === 0 ? { content: "", tool_calls: [{ id: "update", name: toolName("work.task.update"), args: { task: created.id, expected_revision: 1, patch: { title: "Changed", due: "2027-01-01T00:00:00Z" } } }] } : { content: "Updated", tool_calls: [] }; } };
  const chat = await client().assistantChat({ request_id: requestId(), message: "Change task" });
  const call = (await client().assistantTools(chat.conversation.id))[0]!;
  expect(call.change).toMatchObject({ before: { title: created.title, due: null }, after_revision: 2 });
  const undoId = requestId(); const undone = await client().undoAssistantTool(call.id, undoId);
  expect(await client().undoAssistantTool(call.id, undoId)).toEqual(undone);
  const restored = (await client().workTask(created.id)).task; expect(restored.title).toBe(created.title); expect(restored.due).toBeUndefined(); expect(restored.revision).toBe(3);
  expect((await client().assistantTools(chat.conversation.id))[0]?.change?.undone?.by).toBe(hub.store.authenticate(`Bearer ${human}`)!.actor.id);
  await command("work.task.update", { task: created.id, expected_revision: 3, patch: { title: "Human edit" } });
  await expect(client().undoAssistantTool(call.id, requestId())).rejects.toMatchObject({ code: "CONFLICT" });
  expect(hub.modules.work.task(created.id).title).toBe("Human edit");
});

for (const status of ["waiting_for_human", "done", "failed", "unknown"] as const) test(`attention shows ${status} only after application and only for the latest round`, async () => {
  const created = await task(), job = await dispatch(created.id);
  expect(await client().workAttention()).toEqual([]);
  await finish(job, status);
  const attention = WorkAttention.array().parse(await client().workAttention());
  expect(attention).toHaveLength(1); expect(attention[0]?.kind).toBe(status === "waiting_for_human" ? "question" : status === "done" ? "review" : "failed");
  expect(attention[0]?.summary?.length).toBe(500); expect(attention[0]?.agent).toBe("pi@server");
  if (status === "waiting_for_human") expect(attention[0]?.question).toBe("Which synthetic input?");
  const identity = hub.store.authenticate(`Bearer ${agent}`)!;
  expect((await hub.modules.capabilities.execute("work.attention.list", {}, identity)).result).toEqual(attention);
  await dispatch(created.id); expect(await client().workAttention()).toEqual([]);
});
for (const status of ["done", "cancelled", "paused"] as const) test(`attention disappears when task becomes ${status}`, async () => {
  const created = await task(), job = await dispatch(created.id); await finish(job, "done");
  const current = hub.modules.work.task(created.id);
  await command(status === "paused" ? "work.task.hand" : "work.task.finish", { task: current.id, expected_revision: current.revision, ...(status === "paused" ? { to: "nobody" } : { outcome: status }) });
  expect(await client().workAttention()).toEqual([]);
});
test("hand to human clears attention and records the change; later rounds still require review", async () => {
  const created = await task(), job = await dispatch(created.id); await finish(job, "failed");
  const prior = hub.modules.work.task(created.id);
  await command("work.task.hand", { task: created.id, expected_revision: prior.revision, to: "human" }); expect(await client().workAttention()).toEqual([]);
  expect(hub.modules.work.task(created.id)).toMatchObject({ outcome: prior.outcome, turn: { holder: "human", reason: "todo" }, revision: prior.revision + 1 });
  expect(hub.modules.work.detail(created.id).turns.at(-1)?.by).toBe(hub.store.authenticate(`Bearer ${human}`)!.actor.id);
  await hub.stop();
  hub = await startHub({ ...readConfig({ HOME: temp, LUMIO_STATE_DIR: join(temp, "state") }), localRuntime: "server", port: 0 }, { log() {} });
  expect(await client().workAttention()).toEqual([]);
  expect(hub.modules.work.task(created.id).created_by).toBe(hub.store.authenticate(`Bearer ${human}`)!.actor.id);
  const next = await dispatch(created.id); await finish(next, "done"); expect((await client().workAttention())[0]?.round).toBe(2);
});
test("answer and continue commits once; failure rolls back the comment, job, execution and receipt", async () => {
  const created = await task();
  const audit = hub.store.audit.bind(hub.store); let fail = true;
  hub.store.audit = (...args) => { if (args[1] === "work.command" && fail) { fail = false; throw new Error("synthetic audit failure"); } return audit(...args); };
  const payload = { request_id: requestId(), operation: { op: "work.task.dispatch", args: { task: created.id, to: "pi@server", comment: "Synthetic answer" } } };
  expect((await api("/v2/work/commands", payload)).status).toBe(500);
  expect(hub.modules.work.detail(created.id)).toMatchObject({ comments: [], executions: [], task: { turn: { holder: "human", reason: "todo" } } });
  expect(hub.store.db.query("SELECT * FROM jobs").all()).toEqual([]);
  expect((await api("/v2/work/commands", payload)).status).toBe(200);
  expect((await api("/v2/work/commands", payload)).status).toBe(200);
  const detail = await client().workTask(created.id); expect(detail.comments).toHaveLength(1); expect(detail.executions).toHaveLength(1);
  expect(detail.executions[0]?.input_snapshot).toContain("Synthetic answer");
  const job = await client().job(detail.executions[0]!.job); expect(job.spec.run.kind === "agent" && job.spec.run.prompt).toContain("Result / Changes / Verification");
  const bad = { ...payload, request_id: requestId() }; expect((await api("/v2/work/commands", bad)).status).toBe(409); expect((await client().workTask(created.id)).comments).toHaveLength(1);
});

test("config API validates before writing, reloads the next conversation immediately, and never exposes the key", async () => {
  const key = "synthetic-model-private-credential"; const seen: unknown[] = [];
  const modelServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
    const body = await request.json() as Record<string, unknown>; seen.push(body);
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: `model:${body.model}` } }] });
  } });
  try {
    expect(await client().assistantConfig()).toEqual({ api_key_set: false, managed: true });
    expect((await api("/v2/assistant/config", undefined, agent)).status).toBe(403);
    const input = { base_url: `${modelServer.url}v1`, model: "synthetic-new-model", api_key: key };
    const view = AssistantConfigView.parse(await client().updateAssistantConfig(input)); expect(view.api_key_set).toBe(true); expect(JSON.stringify(view)).not.toContain(key);
    const path = join(temp, ".config/lumio/hub.env"); expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain(key);
    const chat = await client().assistantChat({ request_id: requestId(), message: "Which model?" }); expect(chat.messages.at(-1)?.content).toBe("model:synthetic-new-model");
    expect(seen).toHaveLength(2); expect(JSON.stringify(logs)).not.toContain(key); expect(JSON.stringify(hub.store.db.query("SELECT * FROM audit").all())).not.toContain(key);
    const preserved = await readFile(path, "utf8");
    const invalid = await api("/v2/assistant/config", { ...input, base_url: "http://user:password@invalid", check: false }, human, "PUT");
    expect(invalid.status).toBe(400); expect(ApiError.parse(await invalid.json()).error.reason).toBe("assistant-config-address"); expect(await readFile(path, "utf8")).toBe(preserved);
    await client().updateAssistantConfig({ ...input, api_key: undefined, model: "retained-key" });
    expect((await client().assistantConfig()).api_key_set).toBe(true);
    await hub.stop();
    hub = await startHub({ ...readConfig({ HOME: temp, LUMIO_STATE_DIR: join(temp, "state") }), port: 0 }, { log: line => logs.push(line) });
    expect((await client().assistantConfig()).model).toBe("retained-key");
    expect((await client().assistantChat({ request_id: requestId(), message: "After restart" })).messages.at(-1)?.content).toBe("model:retained-key");
    await client().clearAssistantConfig(); expect(await client().assistantConfig()).toEqual({ api_key_set: false, managed: true });
    const noModel = await client().assistantChat({ request_id: requestId(), message: "After clear" }); expect(noModel.turn.status).toBe("failed");
  } finally { await modelServer.stop(true); }
});

for (const [status, reason] of [[401, "auth"], [403, "auth"], [400, "model"], [404, "model"], [500, "address"], [200, "response"]] as const) test(`config ${status} failure is sanitized and never writes (${reason})`, async () => {
  const key = "synthetic-key-not-for-errors";
  const manager = new AssistantConfiguration({ home: temp, fetch: (async () => new Response(key, { status })) as unknown as typeof fetch });
  await manager.load();
  await expect(manager.update({ base_url: "https://synthetic.invalid/v1", model: "fake", api_key: key })).rejects.toMatchObject({ code: "INVALID", details: { reason: `assistant-config-${reason}` } });
  expect(manager.view()).toEqual({ api_key_set: false, managed: true });
  expect(await Bun.file(manager.path).exists()).toBe(false);
});
test("externally injected model configuration is read-only; skip-check, key clearing and timeout use the shared implementation", async () => {
  const external = modelConfiguration({ LUMIO_ASSISTANT_BASE_URL: "http://127.0.0.1:1/v1", LUMIO_ASSISTANT_MODEL: "external", LUMIO_ASSISTANT_API_KEY: "synthetic" })!;
  const manager = new AssistantConfiguration({ home: temp, external }); await manager.load();
  expect(manager.view()).toMatchObject({ managed: false, api_key_set: true });
  await expect(manager.update({ base_url: external.baseUrl, model: "other", check: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(manager.clear()).rejects.toMatchObject({ code: "FORBIDDEN" });
  const local = new AssistantConfiguration({ home: temp, fetch: (async (_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("synthetic private failure"))))) as unknown as typeof fetch, timeoutMs: 5 });
  await expect(local.update({ base_url: external.baseUrl, model: "other" })).rejects.toMatchObject({ details: { reason: "assistant-config-timeout" } });
  await local.update({ base_url: external.baseUrl, model: "other", api_key: "fixture-key", check: false });
  await local.update({ base_url: external.baseUrl, model: "other", clear_api_key: true, check: false }); expect(local.view().api_key_set).toBe(false);
});

test("CLI setup/status/clear use the running Hub with no service restart", async () => {
  await mkdir(join(temp, ".config/lumio"), { recursive: true });
  await writeFile(join(temp, ".config/lumio/config.json"), JSON.stringify({ hub_url: url(), token: human }));
  const lines: string[] = [], options = { home: temp, log: (line: string) => lines.push(line), stdin: async () => "synthetic-cli-key", run: async () => { throw new Error("must not restart"); } };
  await assistantConfiguration(["setup", "--base-url", "http://127.0.0.1:1/v1", "--model", "cli-fake", "--api-key-stdin", "--skip-check"], options);
  expect(await client().assistantConfig()).toMatchObject({ model: "cli-fake", api_key_set: true });
  await assistantConfiguration(["status"], options); expect(lines.join(" ")).toContain("cli-fake"); expect(lines.join(" ")).not.toContain("synthetic-cli-key");
  await assistantConfiguration(["clear"], options); expect((await client().assistantConfig()).api_key_set).toBe(false);
});


test("CLI attention, answer-and-continue and hand expose contract JSON", async () => {
  async function cli(args: string[]) {
    const child = Bun.spawn([process.execPath, new URL("../../cli/src/main.ts", import.meta.url).pathname, ...args], {
      env: { HOME: temp, PATH: process.env.PATH, LUMIO_LANG: "zh", LUMIO_HUB_URL: url(), LUMIO_TOKEN: human }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(code).toBe(0); return JSON.parse(stdout);
  }
  const created = await task();
  const job = Job.parse(await cli(["task", "continue", created.id, "--to", "pi@server", "--comment", "Synthetic CLI answer", "--json", "--request-id", "synthetic-cli-continue"]));
  expect(hub.modules.work.detail(created.id).comments[0]?.body).toBe("Synthetic CLI answer");
  await finish(job, "done"); expect(WorkAttention.array().parse(await cli(["attention", "--json"]))).toHaveLength(1);
  WorkCommandResult.parse(await cli(["task", "hand", created.id, "--to", "human", "--json"]));
  expect(await cli(["attention", "--json"])).toEqual([]);
});

test("HTTP config from outside environment reports unmanaged and refuses both update and clear", async () => {
  await hub.stop();
  hub = await startHub({ ...readConfig({ HOME: temp, LUMIO_STATE_DIR: join(temp, "state"), LUMIO_ASSISTANT_BASE_URL: "http://127.0.0.1:1/v1", LUMIO_ASSISTANT_MODEL: "injected", LUMIO_ASSISTANT_API_KEY: "synthetic-external-key" }), port: 0 }, { log: line => logs.push(line) });
  expect(await client().assistantConfig()).toMatchObject({ model: "injected", managed: false, api_key_set: true });
  await expect(client().updateAssistantConfig({ base_url: "http://127.0.0.1:1/v1", model: "other", check: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(client().clearAssistantConfig()).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(JSON.stringify(logs)).not.toContain("synthetic-external-key");
});


test("catalog read endpoints validate their results, and project writes preserve their actors", async () => {
  const project = await command("work.project.create", { title: "Synthetic project", goal: "Original goal" }, agent);
  if (project.kind !== "project") throw new Error("project expected");
  const update = await command("work.project.update", { project: project.project.id, expected_revision: 1, patch: { goal: null } });
  if (update.kind !== "project") throw new Error("project expected");
  const created = await task({ project: project.project.id }); const job = await dispatch(created.id);
  const identity = hub.store.authenticate(`Bearer ${agent}`)!;
  const args: Record<string, object> = {
    "knowledge.note.search": { query: "index" }, "knowledge.note.show": { ref: "Main" }, "knowledge.note.links": { ref: "Main" },
    "work.task.list": {}, "work.task.show": { task: created.id }, "work.project.list": {}, "work.project.show": { project: project.project.id },
    "execution.target.list": {}, "execution.job.list": {}, "execution.job.show": { job: job.spec.id }, "execution.routine.list": {}, "approval.proposal.list": {}, "work.attention.list": {},
  };
  for (const def of CAPABILITIES.filter(value => value.kind === "read")) {
    const result = await hub.modules.capabilities.execute(def.name, args[def.name], identity);
    expect(def.result.safeParse(result.result).success).toBe(true);
  }
  const latest = await checked(`/v2/execution/jobs?limit=1`, Job.array()); expect(latest[0]?.spec.id).toBe(job.spec.id);
  expect(await checked(`/v2/execution/jobs/${job.spec.id}`, Job)).toEqual(job);
  const stored = hub.modules.work.project(project.project.id);
  expect(stored.created_by).toBe(identity.actor.id); expect(stored.updated_by).toBe(hub.store.authenticate(`Bearer ${human}`)!.actor.id); expect(stored.goal).toBeUndefined();
});

test("an intervening human edit conflicts with the first undo without overwriting it", async () => {
  const created = await task(); let step = 0;
  model = { async complete() { return step++ === 0 ? { content: "", tool_calls: [{ id: "synthetic", name: toolName("work.task.update"), args: { task: created.id, expected_revision: 1, patch: { title: "Assistant edit" } } }] } : { content: "Updated", tool_calls: [] }; } };
  const chat = await client().assistantChat({ request_id: requestId(), message: "Update" });
  const call = (await client().assistantTools(chat.conversation.id))[0]!;
  await command("work.task.update", { task: created.id, expected_revision: 2, patch: { title: "Human edit wins" } });
  await expect(client().undoAssistantTool(call.id, requestId())).rejects.toMatchObject({ code: "CONFLICT" });
  expect(hub.modules.work.task(created.id).title).toBe("Human edit wins");
  expect((await client().assistantTools(chat.conversation.id))[0]?.change?.undone).toBeUndefined();
});

test("a model attempting unavailable approval and acknowledge tools receives explicit failure reasons", async () => {
  let step = 0;
  const names = ["approval.proposal.accept", "work.task.acknowledge"];
  model = { async complete(input) {
    if (step) { const result = JSON.parse(input.messages.at(-1)!.content); expect(result.code).toBe("INVALID"); expect(result.reason).toContain("not provided"); }
    return step < names.length ? { content: "", tool_calls: [{ id: "synthetic", name: toolName(names[step++]!), args: {} }] } : { content: "Those operations require the user.", tool_calls: [] };
  } };
  const result = await client().assistantChat({ request_id: requestId(), message: "Attempt forbidden tools" });
  expect(result.turn.status).toBe("done"); expect((await client().assistantTools(result.conversation.id)).every(call => call.status === "failed")).toBe(true);
});


test("assistant task tools create proposals that take effect only after human approval", async () => {
  const delegation = await task({ title: "Synthetic delegation" });
  const planned = await task({ title: "Synthetic plan" });
  const operations = [
    { name: "work.task.dispatch", args: { task: delegation.id, expected_revision: delegation.revision, to: "pi@server" } },
    { name: "work.task.plan.set", args: { task: planned.id, expected_revision: planned.revision,
      plan: { stages: [{ kind: "agent", id: "implement", agent: "pi@server", instruction: "Synthetic implementation" }] } } },
  ];
  const results: WorkCommandResult[] = [];
  model = { async complete(input) {
    const last = input.messages.at(-1)!;
    if (last.role === "tool") {
      results.push(...input.messages.filter(message => message.role === "tool").map(message => WorkCommandResult.parse(JSON.parse(message.content))));
      return { content: "Submitted for approval.", tool_calls: [] };
    }
    return { content: "", tool_calls: operations.map(({ name, args }, index) => {
      const tool = input.tools.find(value => value.name === toolName(name));
      expect(tool?.description).toContain("approv");
      return { id: "synthetic-proposal-" + index, name: toolName(name), args };
    }) };
  } };
  const chat = await client().assistantChat({ request_id: requestId(), message: "Propose a delegation and a plan" });
  expect(chat.turn.status, JSON.stringify(chat)).toBe("done");
  const calls = await client().assistantTools(chat.conversation.id);
  const author = hub.store.assistantActor().id;
  expect(calls).toHaveLength(operations.length);
  expect(results).toHaveLength(operations.length);
  for (const { name, args } of operations) {
    const call = calls.find(value => value.capability === name)!;
    expect(call.status).toBe("succeeded");
    expect(call.change).toBeUndefined();
    const result = WorkCommandResult.parse(call.result);
    if (result.kind !== "proposal") throw new Error("proposal expected");
    expect(results).toContainEqual(result);
    expect(hub.store.proposal(result.proposal)).toMatchObject({ status: "pending", author,
      operation: { op: "work.command", args: { request_id: call.id, operation: { op: name, args } } } });
    const before = await client().workTask(args.task);
    expect(before.executions).toEqual([]);
    expect(before.task.revision).toBe(args.expected_revision);
    expect(before.task.plan).toBeUndefined();
    expect((await api("/v1/proposals/" + result.proposal + "/accept", {}, agent)).status).toBe(403);
    expect((await api("/v1/proposals/" + result.proposal + "/accept", {})).status).toBe(200);
  }
  const dispatched = await client().workTask(delegation.id);
  expect(dispatched.executions).toHaveLength(1);
  expect(dispatched.task).toMatchObject({ updated_by: author, turn: { holder: "pi@server", reason: "working" } });
  const saved = await client().workTask(planned.id);
  expect(saved.executions).toEqual([]);
  expect(saved.task).toMatchObject({ updated_by: author, plan: { stage: "implement", rounds: 0 } });
});

test("answer-and-continue defaults to the previous agent even if the task owner has changed", async () => {
  const created = await task(), first = await dispatch(created.id); await finish(first, "waiting_for_human");
  const current = hub.modules.work.task(created.id);
  await command("work.task.hand", { task: current.id, expected_revision: current.revision, to: "human" });
  const next = await dispatch(created.id, { comment: "Synthetic answer for the same agent" });
  expect(next.spec.run.kind === "agent" && next.spec.run.engine).toBe("pi"); expect(next.spec.runtime).toBe(first.spec.runtime);
  expect(hub.modules.work.task(created.id).turn.holder).toBe("pi@server");
});


test("local setup before CLI pairing is refreshed by the running Hub without a restart", async () => {
  await assistantConfiguration(["setup", "--base-url", "http://127.0.0.1:1/v1", "--model", "local-before-pairing", "--api-key-stdin", "--skip-check"], {
    home: temp, stdin: async () => "synthetic-local-key", log() {},
  });
  expect(await client().assistantConfig()).toMatchObject({ model: "local-before-pairing", api_key_set: true, managed: true });
  await assistantConfiguration(["clear"], { home: temp, log() {} });
  expect(await client().assistantConfig()).toEqual({ api_key_set: false, managed: true });
});

test("agent delegation proposes once; human approval executes as author with the original request ID and records both actors", async () => {
  const created = await task(), request_id = requestId();
  const payload = { request_id, operation: { op: "work.task.dispatch", args: { task: created.id, to: "pi@server", comment: "Synthetic proposed answer" } } };
  const first = await api("/v2/work/commands", payload, agent);
  expect(first.status).toBe(202);
  const proposed = WorkCommandResult.parse(await first.json());
  if (proposed.kind !== "proposal") throw new Error("proposal expected");
  expect(WorkCommandResult.parse(await (await api("/v2/work/commands", payload, agent)).json())).toEqual(proposed);
  expect(hub.modules.work.detail(created.id).executions).toEqual([]);
  expect(hub.modules.work.detail(created.id).comments).toEqual([]);
  const before = hub.store.proposal(proposed.proposal)!;
  expect(before.operation).toMatchObject({ op: "work.command", args: { request_id, operation: { args: { expected_revision: 1 } } } });
  expect((await api(`/v1/proposals/${proposed.proposal}/accept`, {}, agent)).status).toBe(403);
  expect((await api(`/v1/proposals/${proposed.proposal}/accept`, {})).status).toBe(200);
  const identity = hub.store.authenticate(`Bearer ${agent}`)!, humanId = hub.store.authenticate(`Bearer ${human}`)!.actor.id;
  const detail = WorkTaskDetail.parse(await client().workTask(created.id));
  expect(detail.executions).toHaveLength(1); expect(detail.task.turn).toMatchObject({ holder: "pi@server", reason: "working" });
  expect(detail.task.updated_by).toBe(identity.actor.id); expect(detail.comments[0]!.author).toBe(identity.actor.id);
  expect(detail.turns.at(-1)!.by).toBe(identity.actor.id);
  expect(hub.modules.workStore.receipt(identity.actor.id, request_id)?.result.kind).toBe("job");
  expect(hub.modules.workStore.receipt(humanId, request_id)).toBeUndefined();
  const audits = hub.store.db.query<{ actor_id: string; operation: string }, [string]>("SELECT actor_id,operation FROM audit WHERE proposal_id=?").all(proposed.proposal);
  expect(audits.some(row => row.actor_id === identity.actor.id && row.operation.includes(humanId))).toBe(true);
  expect(audits.some(row => row.actor_id === humanId && row.operation === "proposal.accept")).toBe(true);
  expect((await api(`/v1/proposals/${proposed.proposal}/accept`, {})).status).toBe(409);
  expect(WorkCommandResult.parse(await (await api("/v2/work/commands", payload, agent)).json())).toEqual(proposed);
  expect(hub.modules.work.detail(created.id).executions).toHaveLength(1);
});

test("changed revisions conflict on delegation and plan approval; rejected or failed proposals produce no side effects", async () => {
  const created = await task();
  for (const op of ["work.task.dispatch", "work.task.plan.set"] as const) {
    const revision = hub.modules.work.task(created.id).revision;
    const operation = op === "work.task.dispatch" ? { op, args: { task: created.id, to: "pi@server", comment: "Must not be saved" } }
      : { op, args: { task: created.id, expected_revision: revision, plan: { stages: [{ kind: "agent", id: "implement", agent: "pi@server", instruction: "Synthetic implementation" }] } } };
    const proposed = WorkCommandResult.parse(await (await api("/v2/work/commands", { request_id: requestId(), operation }, agent)).json());
    if (proposed.kind !== "proposal") throw new Error("proposal expected");
    await command("work.task.update", { task: created.id, expected_revision: revision, patch: { title: `Synthetic revision ${revision}` } });
    const response = await api(`/v1/proposals/${proposed.proposal}/accept`, {});
    expect(response.status).toBe(409); expect(ApiError.parse(await response.json()).error.code).toBe("CONFLICT");
    expect(hub.store.proposal(proposed.proposal)!.status).toBe("pending");
    expect((await api(`/v1/proposals/${proposed.proposal}/reject`, {})).status).toBe(200);
  }
  const detail = hub.modules.work.detail(created.id);
  expect(detail.executions).toEqual([]); expect(detail.comments).toEqual([]); expect(detail.task.plan).toBeUndefined();
});

test("plan approval stores the approved plan without starting a round and keeps author attribution", async () => {
  const created = await task(), request_id = requestId();
  const operation = { op: "work.task.plan.set", args: { task: created.id, expected_revision: 1,
    plan: { stages: [{ kind: "agent", id: "implement", agent: "pi@server", instruction: "Synthetic instructions" }] } } };
  const result = WorkCommandResult.parse(await (await api("/v2/work/commands", { request_id, operation }, agent)).json());
  if (result.kind !== "proposal") throw new Error("proposal expected");
  expect((await api(`/v1/proposals/${result.proposal}/accept`, {})).status).toBe(200);
  const detail = hub.modules.work.detail(created.id), humanId = hub.store.authenticate(`Bearer ${human}`)!.actor.id;
  expect(detail.task.plan).toMatchObject({ stage: "implement", rounds: 0, approved: { by: humanId, proposal: result.proposal } });
  expect(detail.task.updated_by).toBe(hub.store.authenticate(`Bearer ${agent}`)!.actor.id);
  expect(detail.executions).toEqual([]); expect(detail.task.turn.holder).toBe("human");
});

test("attention membership comes only from turn even when the latest execution suggests review", async () => {
  const created = await task(), job = await dispatch(created.id); await finish(job, "done");
  expect(await client().workAttention()).toHaveLength(1);
  await command("work.task.hand", { task: created.id, expected_revision: hub.modules.work.task(created.id).revision, to: "external", note: "Synthetic external wait" });
  expect(await client().workAttention()).toEqual([]);
  expect(hub.modules.work.detail(created.id).executions.at(-1)!.applied).toBe(true);
});

test("T1 readiness reaches HTTP, agent and assistant capabilities; deletion, restoration and purge unblock safely", async () => {
  const seed = await Bun.file(new URL("../../../fixtures/work/readiness.json", import.meta.url)).json();
  const a = await task({ title: seed.title }), child = await task({ title: "Synthetic blocked child", dependencies: [a.id], parent: a.id, tags: seed.tags });
  expect(child.blocked_by).toEqual([a.id]);
  const schema = WorkTask.array();
  const query = `readiness=blocked&tag=infra&parent=${a.id}&q=blocked`;
  expect(await checked(`/v2/work/tasks?${query}`, schema)).toMatchObject([{ id: child.id, blocked_by: [a.id] }]);
  expect((await client().workTask(a.id))).toMatchObject({ dependents: [child.id], children: [child.id] });
  const identity = hub.store.authenticate(`Bearer ${agent}`)!;
  expect((await hub.modules.capabilities.execute("work.task.list", { readiness: "blocked", tag: "infra", parent: a.id }, identity)).result).toMatchObject([{ id: child.id, blocked_by: [a.id] }]);
  const tool = hub.modules.capabilities.tools().find(value => value.capability === "work.task.show")!;
  const assistant = hub.store.assistantActor(), owner = hub.store.authenticate(`Bearer ${human}`)!.actor.id;
  expect(await tool.execute({ task: child.id }, { actor: assistant.id, owner, request: requestId(), signal: new AbortController().signal })).toMatchObject({ task: { blocked_by: [a.id] } });
  for (const language of ["en", "zh-CN"]) {
    const response = await fetch(url() + "/v2/work/commands", { method: "POST", headers: { Authorization: `Bearer ${human}`, "Content-Type": "application/json", "Accept-Language": language },
      body: JSON.stringify({ request_id: requestId(), operation: { op: "work.task.dispatch", args: { task: child.id, to: "pi@server" } } }) });
    expect(response.status).toBe(409);
    const error = ApiError.parse(await response.json()).error;
    expect(error.message).toContain(a.id); expect(error.message).toContain(a.title);
    expect(error.message).toContain(language === "en" ? "Unfinished prerequisites" : "前置未完成");
  }
  expect(await client().workAttention()).toEqual([]);
  await command("work.task.delete", { task: a.id, expected_revision: 1 });
  expect((await client().workTask(child.id)).task.blocked_by).toEqual([]);
  expect((await api(`/v2/trash/${a.id}/restore`, { request_id: requestId() })).status).toBe(200);
  expect((await client().workTask(child.id)).task.blocked_by).toEqual([a.id]);
  await command("work.task.delete", { task: a.id, expected_revision: 2 });
  expect((await api(`/v2/trash/${a.id}`, { request_id: requestId() }, human, "DELETE")).status).toBe(200);
  expect((await client().workTask(child.id)).task).toMatchObject({ dependencies: [a.id], blocked_by: [] });
  expect((await checked("/v2/work/tasks?readiness=ready", schema))).toMatchObject([{ id: child.id }]);
  await dispatch(child.id);
  await command("work.task.finish", { task: child.id, expected_revision: 2, outcome: "done" });
});

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backupBusiness, restoreBusiness } from "../src/backup.ts";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AssistantService, type AssistantModel, type AssistantTool } from "@lumio/assistant";
import { AssistantModelRequest, AssistantChatResult, AssistantConversation, AssistantTurn, AssistantToolCall, type AssistantEvent } from "@lumio/schema";
import { SqliteAssistantStore } from "../src/assistant.ts";

const owner = "act_00000000000000000000000001", other = "act_00000000000000000000000002";
const time = "2026-10-31T00:00:00Z";
const toolActor = { id: "act_00000000000000000000000003", name: "assistant", role: "agent" as const, created: time };
function fixture(db: Database, model: AssistantModel, tools: AssistantTool[] = []) {
  let n = 0;
  const store = new SqliteAssistantStore(db);
  const context = { toolActor, now: () => new Date(time), id: (prefix: string) => `${prefix}_${String(++n).padStart(26, "0")}` };
  return { store, context, service: new AssistantService(store, model, tools, context) };
}

test("assistant persists its own dialogue and tool loop, streams events and replays requests without repeating tools", async () => {
  const db = new Database(":memory:"); let models = 0, reads = 0;
  const events: AssistantEvent[] = [];
  const model: AssistantModel = { async complete(input, options) {
    models++;
    if (models === 1) return { content: "", tool_calls: [{ id: "provider-1", name: "read_fixture", args: { query: "合成" } }] };
    expect(input.messages.at(-1)).toMatchObject({ role: "tool", content: '{"text":"合成资料"}' });
    expect(input.messages.at(-2)?.tool_calls?.[0]?.id).toBe(input.messages.at(-1)?.tool_call_id);
    options.token("整理结果"); return { content: "整理结果", tool_calls: [] };
  } };
  const tools: AssistantTool[] = [{ spec: { name: "read_fixture", description: "读取合成资料", input_schema: { type: "object" } }, effect: "read",
    async execute(args, context) { reads++; expect(args).toEqual({ query: "合成" }); expect(context.actor).toBe(toolActor.id); expect(context.owner).toBe(owner); return { text: "合成资料" }; } }];
  try {
    const f = fixture(db, model, tools), request = { request_id: "synthetic-chat-001", message: "查阅并整理" };
    const result = AssistantChatResult.parse(await f.service.chat(request, owner, { event: (event) => events.push(event) }));
    expect(result.turn.status).toBe("done"); expect(result.messages.map((value) => value.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(events.some((event) => event.type === "token")).toBe(true); expect(events.at(-1)?.type).toBe("result");
    expect((await f.service.chat(request, owner)).turn.id).toBe(result.turn.id);
    const restarted = new AssistantService(f.store, model, tools, f.context);
    expect((await restarted.chat(request, owner)).turn.id).toBe(result.turn.id);
    expect(reads).toBe(1); expect(models).toBe(2);
    expect(() => restarted.detail(result.conversation.id, other)).toThrow("找不到对话");
    expect(restarted.conversations(other)).toEqual([]);
    await expect(restarted.chat({ ...request, message: "不同输入" }, owner)).rejects.toThrow("不同的操作");
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('notes','work_tasks')").all()).toEqual([]);
  } finally { db.close(); }
});

test("uncertain writes and restart recovery never replay side effects", async () => {
  const db = new Database(":memory:"); let writes = 0, models = 0;
  const model: AssistantModel = { async complete() { models++; return { content: "尝试操作", tool_calls: [{ id: "provider-1", name: "write_fixture", args: {} }] }; } };
  const tools: AssistantTool[] = [{ spec: { name: "write_fixture", description: "合成写操作", input_schema: {} }, effect: "write",
    async execute() { writes++; throw new Error("synthetic response lost"); } }];
  try {
    const f = fixture(db, model, tools), request = { request_id: "synthetic-write-001", message: "合成操作" };
    const result = await f.service.chat(request, owner);
    expect(result.turn.status).toBe("unknown"); expect(f.store.calls(result.turn.id)[0]!.status).toBe("unknown");
    f.service.recover(); await f.service.chat(request, owner);
    expect(writes).toBe(1); expect(models).toBe(1);
    const conversation = AssistantConversation.parse({ id: "conv_00000000000000000000000090", owner, title: "恢复测试", revision: 1, created: time, updated: time });
    const turn = AssistantTurn.parse({ id: "turn_00000000000000000000000090", conversation: conversation.id, request_id: "synthetic-recover-001", status: "running", created: time });
    f.store.putConversation(conversation); f.store.putTurn(turn);
    f.store.putCall(AssistantToolCall.parse({ id: "tool_00000000000000000000000090", turn: turn.id, name: "write_fixture", args: {}, status: "running", created: time }));
    f.service.recover(); expect(f.store.turns().find((value) => value.id === turn.id)?.status).toBe("unknown");
    expect(f.store.calls(turn.id)[0]!.status).toBe("unknown"); expect(writes).toBe(1);
  } finally { db.close(); }
});

test("one dialogue has one active turn; concurrent duplicate requests share the result", async () => {
  const db = new Database(":memory:"); let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const model: AssistantModel = { async complete() { await gate; return { content: "完成", tool_calls: [] }; } };
  try {
    const f = fixture(db, model), request = { request_id: "synthetic-active-001", message: "等待合成模型" };
    const first = f.service.chat(request, owner), duplicate = f.service.chat(request, owner);
    const conversation = f.service.conversations(owner)[0]!;
    await expect(f.service.chat({ conversation: conversation.id, request_id: "synthetic-active-002", message: "并行问题" }, owner)).rejects.toThrow("正在进行");
    finish(); expect((await first).turn.id).toBe((await duplicate).turn.id);
    expect(f.store.turns(conversation.id)).toHaveLength(1);
  } finally { finish(); db.close(); }
});

test("memory is owner-scoped, explicit, and unavailable sources are rechecked before use", async () => {
  const db = new Database(":memory:"); let visible = true;
  const model: AssistantModel = { async complete() { return { content: "完成", tool_calls: [] }; } };
  try {
    const f = fixture(db, model);
    const service = new AssistantService(f.store, model, [], { ...f.context, canRead: async () => visible });
    await service.remember(owner, "使用中文");
    await service.remember(owner, "有来源的合成记忆", [{ module: "knowledge", id: "pap_00000000000000000000000001" }]);
    expect(await service.memories(owner)).toHaveLength(2); expect(await service.memories(other)).toEqual([]);
    visible = false; expect(await service.memories(owner)).toHaveLength(1);
    await expect(service.remember(owner, "不可见来源", [{ module: "knowledge", id: "pap_00000000000000000000000002" }])).rejects.toThrow("不可访问");
  } finally { db.close(); }
});

test("empty final replies fail clearly while a disconnected event listener cannot change a completed turn", async () => {
  const db = new Database(":memory:");
  try {
    const f = fixture(db, { async complete() { return { content: "   ", tool_calls: [] }; } });
    const result = await f.service.chat({ request_id: "synthetic-empty-001", message: "合成问题" }, owner);
    expect(result.turn.status).toBe("failed"); expect(result.turn.error).toContain("空回复");
    const service = new AssistantService(f.store, { async complete() { return { content: "已完成", tool_calls: [] }; } }, [], f.context);
    const completed = await service.chat({ request_id: "synthetic-display-001", message: "另一个问题" }, owner, { event() { throw new Error("display closed"); } });
    expect(completed.turn.status).toBe("done");
  } finally { db.close(); }
});

test("memory commands are actor-scoped and idempotent, forget tombstones prevent replay and remove active context", async () => {
  const db = new Database(":memory:"), systems: string[] = [];
  const model: AssistantModel = { async complete(input) { systems.push(input.messages[0]!.content); return { content: "完成", tool_calls: [] }; } };
  try {
    const f = fixture(db, model), request = { request_id: "synthetic-memory-remember-001", operation: { op: "assistant.memory.remember", args: { content: "第一位用户偏好中文" } } };
    const result = await f.service.memoryCommand(request, owner); if (result.kind !== "memory") throw new Error("memory expected");
    expect(await f.service.memoryCommand(request, owner)).toEqual(result); expect(await f.service.memories(owner)).toHaveLength(1);
    await expect(f.service.memoryCommand({ ...request, operation: { ...request.operation, args: { content: "不同输入" } } }, owner)).rejects.toThrow("不同的记忆操作");
    await f.service.memoryCommand({ ...request, operation: { ...request.operation, args: { content: "第二位用户偏好简短" } } }, other);
    await f.service.memoryCommand({ request_id: "synthetic-other-forget-001", operation: { op: "assistant.memory.forget", args: { memory: result.memory.id } } }, other);
    expect(await f.service.memories(owner)).toHaveLength(1); expect(await f.service.memories(other)).toHaveLength(1);
    await f.service.chat({ request_id: "synthetic-memory-chat-001", message: "你好" }, owner); expect(systems.at(-1)).toContain("第一位用户偏好中文");
    const forgotten = await f.service.memoryCommand({ request_id: "synthetic-memory-forget-001", operation: { op: "assistant.memory.forget", args: { memory: result.memory.id } } }, owner);
    expect(forgotten).toEqual({ kind: "forgotten", memory: result.memory.id }); expect(await f.service.memoryCommand(request, owner)).toEqual(forgotten);
    expect(await f.service.memories(owner)).toEqual([]);
    await f.service.chat({ request_id: "synthetic-memory-chat-002", message: "新问题" }, owner); expect(systems.at(-1)).not.toContain("第一位用户偏好中文");
    const receipt = db.query<{ operation_hash: string; result: string }, [string, string]>("SELECT operation_hash,result FROM assistant_memory_requests WHERE owner=? AND request=?").get(owner, request.request_id)!;
    expect(receipt.operation_hash).toMatch(/^[0-9a-f]{64}$/); expect(receipt.result).not.toContain("第一位用户偏好中文");
  } finally { db.close(); }
});

test("source permission is checked as the tool agent, including receipt replay; forgetting revoked content stays possible", async () => {
  const db = new Database(":memory:"); let visible = true;
  const model: AssistantModel = { async complete() { return { content: "完成", tool_calls: [] }; } };
  try {
    const f = fixture(db, model), service = new AssistantService(f.store, model, [], { ...f.context, canRead: async (_source, actor) => { expect(actor).toBe(toolActor.id); return visible; } });
    const request = { request_id: "synthetic-source-memory-001", operation: { op: "assistant.memory.remember", args: { content: "有来源的事实", sources: [{ module: "knowledge", id: "pap_00000000000000000000000001" }] } } };
    const created = await service.memoryCommand(request, owner); if (created.kind !== "memory") throw new Error("memory expected");
    visible = false; expect(await service.memories(owner)).toEqual([]); await expect(service.memoryCommand(request, owner)).rejects.toThrow("不可访问");
    await service.memoryCommand({ request_id: "synthetic-source-forget-001", operation: { op: "assistant.memory.forget", args: { memory: created.memory.id } } }, owner);
    expect(await service.memoryCommand(request, owner)).toEqual({ kind: "forgotten", memory: created.memory.id });
  } finally { db.close(); }
});

test("memory mutation, receipt and audit commit together, and explicit tool authority never defaults to a human", async () => {
  const db = new Database(":memory:"); let models = 0;
  const model: AssistantModel = { async complete() { models++; return { content: "完成", tool_calls: [] }; } };
  const tool: AssistantTool = { spec: { name: "fixture", description: "synthetic", input_schema: {} }, effect: "read", async execute() { return {}; } };
  try {
    const f = fixture(db, model); db.exec("CREATE TABLE synthetic_audit(result TEXT)");
    const request = { request_id: "synthetic-memory-audit-001", operation: { op: "assistant.memory.remember", args: { content: "应随审计回滚" } } };
    await expect(f.service.memoryCommand(request, owner, () => { db.exec("INSERT INTO synthetic_audit VALUES('attempt')"); throw new Error("injected audit failure"); })).rejects.toThrow("injected audit failure");
    expect(await f.service.memories(owner)).toEqual([]); expect(db.query("SELECT * FROM assistant_memory_requests").all()).toEqual([]); expect(db.query("SELECT * FROM synthetic_audit").all()).toEqual([]);
    await f.service.memoryCommand(request, owner, () => { db.exec("INSERT INTO synthetic_audit VALUES('applied')"); });
    expect(await f.service.memories(owner)).toHaveLength(1); expect(models).toBe(0);
    expect(() => new AssistantService(f.store, model, [tool], { ...f.context, toolActor: undefined })).toThrow("agent 身份");
    expect(() => new AssistantService(f.store, model, [tool], { ...f.context, toolActor: { ...toolActor, role: "human" } })).toThrow("不能继承人类权限");
  } finally { db.close(); }
});


test("each model request has an immutable context and revocations apply again between tool steps", async () => {
  const db = new Database(":memory:"); let visible = true, models = 0;
  const model: AssistantModel = { async complete(input) {
    models++;
    const row = db.query<{ request: string; tool_actor: string }, [number]>("SELECT request,tool_actor FROM assistant_contexts WHERE step=?").get(models - 1)!;
    expect(AssistantModelRequest.parse(JSON.parse(row.request))).toEqual(input); expect(row.tool_actor).toBe(toolActor.id);
    if (models === 1) { expect(input.messages[0]!.content).toContain("需撤回的合成记忆"); visible = false; return { content: "", tool_calls: [{ id: "fixture-call", name: "fixture_read", args: {} }] }; }
    expect(input.messages[0]!.content).not.toContain("需撤回的合成记忆"); return { content: "完成", tool_calls: [] };
  } };
  const tool: AssistantTool = { spec: { name: "fixture_read", description: "synthetic", input_schema: {} }, effect: "read", async execute() { return {}; } };
  try {
    const f = fixture(db, model, [tool]); const service = new AssistantService(f.store, model, [tool], { ...f.context, canRead: async () => visible });
    await service.remember(owner, "需撤回的合成记忆", [{ module: "knowledge", id: "pap_00000000000000000000000001" }]);
    const request = { request_id: "synthetic-context-loop", message: "合成问题" }; const result = await service.chat(request, owner); expect(result.turn.status).toBe("done");
    const rows = db.query<{ request: string }, []>("SELECT request FROM assistant_contexts ORDER BY step").all(); expect(rows).toHaveLength(2);
    expect(AssistantModelRequest.parse(JSON.parse(rows[0]!.request)).messages).toHaveLength(2);
    expect(AssistantModelRequest.parse(JSON.parse(rows[1]!.request)).messages).toHaveLength(4);
    expect(() => f.store.putContext(result.turn.id, 0, inputForSnapshot(), time, toolActor.id)).toThrow();
    const restarted = new AssistantService(f.store, model, [tool], f.context); restarted.recover();
    expect(await restarted.chat(request, owner)).toEqual(result); expect(models).toBe(2);
  } finally { db.close(); }
});
function inputForSnapshot(): AssistantModelRequest { return { messages: [{ role: "user", content: "合成" }], tools: [] }; }

test("a context persistence failure prevents the network/model invocation", async () => {
  const db = new Database(":memory:"); let models = 0;
  try {
    const f = fixture(db, { async complete() { models++; return { content: "不应发生", tool_calls: [] }; } });
    db.exec("CREATE TRIGGER fail_context BEFORE INSERT ON assistant_contexts BEGIN SELECT RAISE(FAIL,'synthetic context failure'); END");
    const result = await f.service.chat({ request_id: "synthetic-context-fail", message: "合成" }, owner);
    expect(result.turn.status).toBe("failed"); expect(models).toBe(0); expect(db.query("SELECT * FROM assistant_contexts").all()).toEqual([]);
  } finally { db.close(); }
});

test("business snapshot and restore retain typed assistant contexts with their conversations", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-context-backup-")), state = join(root, "state"); await mkdir(state);
  const db = new Database(join(state, "hub.sqlite"));
  try {
    const f = fixture(db, { async complete() { return { content: "合成回答", tool_calls: [] }; } });
    const result = await f.service.chat({ request_id: "synthetic-context-backup", message: "合成备份" }, owner); expect(result.turn.status).toBe("done");
    await backupBusiness(state, join(root, "backup")); await restoreBusiness(join(root, "backup"), join(root, "restore"));
    const restored = new Database(join(root, "restore", "hub.sqlite"), { readonly: true });
    try {
      const context = restored.query<{ request: string }, [string]>("SELECT request FROM assistant_contexts WHERE turn=?").get(result.turn.id)!;
      expect(AssistantModelRequest.parse(JSON.parse(context.request)).messages.at(-1)?.content).toBe("合成备份");
      expect(restored.query("SELECT owner FROM assistant_conversations WHERE id=?").get(result.conversation.id)).toEqual({ owner });
    } finally { restored.close(); }
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});


test("cancelling between tools settles unstarted calls and keeps the same receipt after recovery", async () => {
  const db = new Database(":memory:"), controller = new AbortController(); let invoked = 0, models = 0;
  const model: AssistantModel = { async complete() { models++; return { content: "", tool_calls: [{ id: "first", name: "fixture", args: {} }, { id: "second", name: "fixture", args: {} }] }; } };
  const tool: AssistantTool = { spec: { name: "fixture", description: "synthetic", input_schema: {} }, effect: "read", async execute() { invoked++; controller.abort(); return {}; } };
  try {
    const f = fixture(db, model, [tool]), request = { request_id: "synthetic-between-tools", message: "合成取消" };
    const result = await f.service.chat(request, owner, { signal: controller.signal }); expect(result.turn.status).toBe("cancelled"); expect(invoked).toBe(1);
    expect(f.store.calls(result.turn.id).map(call => call.status)).toEqual(["succeeded", "failed"]);
    expect(f.store.calls(result.turn.id)[1]!.error).toContain("未执行");
    const restarted = new AssistantService(f.store, model, [tool], f.context); restarted.recover();
    expect(await restarted.chat(request, owner)).toEqual(result); expect(models).toBe(1); expect(invoked).toBe(1);
    // Repair older settled records that still contain a never-started prepared row without changing the turn.
    const second = f.store.calls(result.turn.id)[1]!; f.store.putCall({ ...second, status: "prepared", finished: undefined, error: undefined }); restarted.recover();
    expect(await restarted.chat(request, owner)).toEqual(result); expect(f.store.calls(result.turn.id)[1]!.status).toBe("failed");
  } finally { db.close(); }
});

test("an uncertain write settles later prepared calls without invoking or replaying them", async () => {
  const db = new Database(":memory:"); let invoked = 0;
  const model: AssistantModel = { async complete() { return { content: "", tool_calls: [{ id: "first", name: "fixture", args: {} }, { id: "second", name: "fixture", args: {} }] }; } };
  const tool: AssistantTool = { spec: { name: "fixture", description: "synthetic", input_schema: {} }, effect: "write", async execute() { invoked++; throw new Error("synthetic interrupted effect"); } };
  try {
    const f = fixture(db, model, [tool]), request = { request_id: "synthetic-unknown-pair", message: "合成写入" }; const result = await f.service.chat(request, owner);
    expect(result.turn.status).toBe("unknown"); expect(f.store.calls(result.turn.id).map(call => call.status)).toEqual(["unknown", "failed"]);
    const restarted = new AssistantService(f.store, model, [tool], f.context); restarted.recover(); expect(await restarted.chat(request, owner)).toEqual(result); expect(invoked).toBe(1);
  } finally { db.close(); }
});

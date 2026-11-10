import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AssistantModel } from "@lumio/assistant";
import { parseFrontmatter } from "@lumio/knowledge";
import {
  AI_NOTE_CAPABILITY_NAMES, AiNote, ApiError, AssistantChatResult, KnowledgeAiNoteResult,
  AIConnection, AIProfile, KnowledgeUpdateResult, NativeMCPResult, NativeRuntimeCommand, NativeSession, NoteDetail, ResourceSummary, RunLogEvent, TrashResult, WorkCommandResult, toolName,
} from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";

const [create, update] = AI_NOTE_CAPABILITY_NAMES;
const privateNote = "ast_00000000000000000000000001";
const publicNote = "idea_00000000000000000000000001";

async function fixture(model?: AssistantModel) {
  const root = await mkdtemp(join(tmpdir(), "lumio-k4-hub-")), vault = join(root, "vault");
  await cp(new URL("../../../fixtures/k4-ai-notes", import.meta.url), vault, { recursive: true });
  const hub = await startHub({
    ...readConfig({ HOME: root, LUMIO_STATE_DIR: join(root, "state"), LUMIO_VAULT: vault }),
    port: 0, localRuntime: "server",
  }, { assistantModel: model, assistantHome: join(root, "assistant"), log() {} });
  const credential = (name: string, role: "human" | "agent" | "runtime" = "human") => {
    const actor = hub.store.createActor(name, role);
    return { actor, token: hub.store.createToken(name, name) };
  };
  const owner = credential("owner"), agent = credential("agent", "agent");
  const api = (path: string, token: string, method = "GET", body?: unknown) =>
    fetch(new URL(path, hub.server.url), {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const note = (op: string, args: object, token = agent.token, request_id = randomUUID()) =>
    api("/v2/knowledge/ai-note-commands", token, "POST", { request_id, operation: { op, args } });
  const command = async (op: string, args: object, request_id = randomUUID()) => {
    const response = await api("/v2/work/commands", owner.token, "POST", { request_id, operation: { op, args } });
    expect(response.status).toBe(200);
    return WorkCommandResult.parse(await response.json());
  };
  const resource = async (id: string, token = owner.token, suffix = "") => {
    const response = await api(`/v2/resources/${id}${suffix}`, token);
    expect(response.status).toBe(200);
    return ResourceSummary.parse(await response.json());
  };
  const metadata = async (path: string) => AiNote.parse(parseFrontmatter(await readFile(join(vault, path))).data);
  return { hub, owner, agent, credential, api, note, command, resource, metadata,
    async close() { await hub.stop(); await rm(root, { recursive: true, force: true }); } };
}

test("agents write versioned AI notes and can only use visible sources", async () => {
  const f = await fixture();
  try {
    expect(await f.resource(privateNote, f.agent.token)).toEqual({ id: privateNote, status: "unavailable" });
    expect(await f.resource(privateNote, f.owner.token, "?include_private=true")).toMatchObject({ status: "visible" });
    const source = { title: "Synthetic digest", body: "Markdown body", derived_from: [privateNote] };
    const forbidden = await f.note(create, source);
    expect(forbidden.status).toBe(403);
    expect(ApiError.parse(await forbidden.json()).error.reason).toBe("source-unavailable");
    const runtime = f.credential("runtime", "runtime");
    expect((await f.note(create, { ...source, derived_from: [] }, runtime.token)).status).toBe(403);

    const args = { ...source, tags: ["synthetic"], derived_from: [publicNote, "https://example.com/source"] };
    const requestId = randomUUID();
    const response = await f.note(create, args, f.agent.token, requestId);
    expect(response.status).toBe(201);
    const initial = KnowledgeAiNoteResult.parse(await response.json()), id = initial.note.id!;
    expect(initial.note).toMatchObject({ type: "ai-note", path: `ai/notes/Synthetic digest ${id}.md` });
    expect(await f.metadata(initial.note.path)).toMatchObject({ generated_by: f.agent.actor.id, derived_from: args.derived_from });
    expect(KnowledgeAiNoteResult.parse(await (await f.note(create, args, f.agent.token, requestId)).json())).toEqual(initial);
    expect((await f.note(create, { ...args, title: "Different request" }, f.agent.token, requestId)).status).toBe(409);
    const read = NoteDetail.parse(await (await f.api(`/v1/notes/${id}`, f.agent.token)).json());
    expect(read.revision).toBe(initial.revision);

    expect((await f.note(update, { note: publicNote, expected_revision: initial.revision, title: "Forbidden write" })).status).toBe(400);
    expect((await f.api(`/v2/knowledge/notes/${id}`, f.agent.token, "DELETE", { request_id: randomUUID(), expected_revision: initial.revision })).status).toBe(403);
    const path = `/v2/knowledge/notes/${id}/document`;
    const humanEdit = await f.api(path, f.owner.token, "PUT", {
      request_id: randomUUID(), expected_revision: initial.revision, title: "Human correction", body: "Corrected by human",
    });
    expect(humanEdit.status).toBe(200);
    const edited = KnowledgeUpdateResult.parse(await humanEdit.json());
    const conflict = await f.note(update, { note: id, expected_revision: initial.revision, title: "Stale overwrite" });
    expect(conflict.status).toBe(409);
    expect(ApiError.parse(await conflict.json()).error.code).toBe("CONFLICT");
    expect((await f.note(update, { note: id, expected_revision: edited.revision, derived_from: [privateNote] })).status).toBe(403);
    const updated = await f.note(update, { note: id, expected_revision: edited.revision, tags: ["updated"] });
    expect(updated.status).toBe(200);
    expect(KnowledgeAiNoteResult.parse(await updated.json()).note.title).toBe("Human correction");
    expect(await f.metadata(initial.note.path)).toMatchObject({ generated_by: f.agent.actor.id, tags: ["updated"], derived_from: args.derived_from });

    const audits = f.hub.store.db.query("SELECT actor_id,operation,authorization,execution_result FROM audit WHERE operation LIKE 'knowledge.ainote.%'").all();
    expect(audits).toContainEqual({ actor_id: f.agent.actor.id, operation: create, authorization: "allow", execution_result: `applied:${id}` });
    expect(audits).toContainEqual({ actor_id: f.agent.actor.id, operation: create, authorization: "deny", execution_result: "FORBIDDEN" });
  } finally { await f.close(); }
});

test("assistant records the triggering message and its anchor survives trash and restore", async () => {
  let saved: KnowledgeAiNoteResult | undefined, step = 0;
  const f = await fixture({ async complete(input) {
    if (step++ === 0) return { content: "", tool_calls: [{ id: "record", name: toolName(create), args: {
      title: "Conversation summary", body: "Synthetic assistant notes",
    } }] };
    saved = KnowledgeAiNoteResult.parse(JSON.parse(input.messages.at(-1)!.content));
    return { content: "Recorded.", tool_calls: [] };
  } });
  try {
    const response = await f.api("/v2/assistant/chat", f.owner.token, "POST", { request_id: randomUUID(), message: "Record a synthetic note" });
    expect(response.status).toBe(200);
    const chat = AssistantChatResult.parse(await response.json()), conversation = chat.conversation.id;
    const message = chat.messages.find(value => value.role === "user")!.id;
    expect(await f.metadata(saved!.note.path)).toMatchObject({ generated_by: f.hub.store.assistantActor().id, derived_from: [message] });
    expect(await f.resource(message)).toMatchObject({ status: "visible", parent: conversation });
    expect(await f.resource(conversation)).toMatchObject({ knowledge_references: 1 });
    expect(await f.resource(message, f.agent.token)).toEqual({ id: message, status: "unavailable" });
    const other = f.credential("other-owner");
    expect(await f.resource(message, other.token)).toEqual({ id: message, status: "unavailable" });
    expect((await f.note(create, { title: "Inaccessible source", body: "", derived_from: [message] })).status).toBe(403);

    const remove = () => f.api(`/v2/assistant/conversations/${conversation}`, f.owner.token, "DELETE", { request_id: randomUUID() });
    const deletion = await remove();
    expect(deletion.status).toBe(200);
    expect(TrashResult.parse(await deletion.json()).knowledge_references).toBe(1);
    expect(await f.resource(message)).toEqual({ id: message, status: "trashed" });
    expect(await f.resource(message, other.token)).toEqual({ id: message, status: "unavailable" });
    expect((await f.api(`/v2/trash/${conversation}/restore`, f.owner.token, "POST", { request_id: randomUUID() })).status).toBe(200);
    expect(await f.resource(message)).toMatchObject({ status: "visible", parent: conversation });
    expect((await remove()).status).toBe(200);
    expect((await f.api(`/v2/trash/${conversation}`, f.owner.token, "DELETE", { request_id: randomUUID() })).status).toBe(200);
    expect(await f.resource(message)).toEqual({ id: message, status: "deleted" });
    expect(await f.resource(message, other.token)).toEqual({ id: message, status: "unavailable" });
  } finally { await f.close(); }
});

test("job tokens supply their own source and task deletion returns a deduplicated receipt", async () => {
  const f = await fixture();
  try {
    const runtime = f.credential("server", "runtime");
    f.hub.store.registerRuntime(runtime.actor.id, {
      protocol_version: 2, name: "server", engines: [{ name: "pi", version: "synthetic", sandbox: "none" }], tags: [], max_concurrent: 1,
    }, new Date());
    const task = await f.command("work.task.create", { title: "Synthetic task" });
    if (task.kind !== "task") throw new Error("Expected task");
    const run = await f.command("work.task.dispatch", { task: task.task.id, to: "pi@server" });
    if (run.kind !== "job") throw new Error("Expected job");
    const job = run.job.spec.id;
    const token = f.hub.store.issueJobAccess(run.job.spec, new Date())!.token;
    const response = await f.note(create, {
      title: "Job summary", body: `[Synthetic task](lumio:${task.task.id})`, derived_from: [task.task.id],
    }, token);
    expect(response.status).toBe(201);
    const saved = KnowledgeAiNoteResult.parse(await response.json());
    expect((await f.metadata(saved.note.path)).derived_from).toEqual([task.task.id, job]);
    expect(await f.resource(job)).toMatchObject({ status: "visible", parent: task.task.id });
    const event = RunLogEvent.parse({
      schema_version: 1, id: "evt_00000000000000000000000001", run: job, sequence: 1, time: new Date().toISOString(),
      type: "status", payload: { message: "Synthetic private payload" },
    });
    const artifact = "art_00000000000000000000000001", bytes = Buffer.from(JSON.stringify(event) + "\n");
    f.hub.modules.artifacts.stage({
      id: artifact, owner: { module: "execution", id: job }, key: `${artifact}.bin`, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), private: true, status: "staged",
      media_type: "application/vnd.lumio.runlog+jsonl", created: event.time,
    });
    await f.hub.modules.artifacts.publish(artifact, (async function* () { yield bytes; })());
    expect(await f.resource(event.id, f.agent.token)).toEqual({ id: event.id, status: "unavailable" });
    expect(await f.resource(event.id, f.owner.token, "?include_private=true")).toEqual({
      id: event.id, status: "visible", title: "status", timestamp: event.time, parent: job,
    });
    expect(await f.resource(task.task.id)).toMatchObject({ knowledge_references: 1 });

    const taskRevision = f.hub.modules.work.task(task.task.id).revision;
    const args = { task: task.task.id, expected_revision: taskRevision }, requestId = randomUUID();
    const deletion = await f.command("work.task.delete", args, requestId);
    expect(deletion).toMatchObject({ kind: "trashed", knowledge_references: 1 });
    expect(await f.resource(task.task.id)).toEqual({ id: task.task.id, status: "trashed" });
    const replacement = await f.note(update, { note: saved.note.id, expected_revision: saved.revision, derived_from: [], body: "No anchors" });
    expect(replacement.status).toBe(200);
    expect(await f.command("work.task.delete", args, requestId)).toEqual(deletion);
  } finally { await f.close(); }
});

test("native MCP lists and executes AI note capabilities with the active message", async () => {
  const f = await fixture();
  try {
    const runtime = f.credential("server", "runtime");
    f.hub.store.registerRuntime(runtime.actor.id, {
      protocol_version: 2, name: "server", engines: [{ name: "codex", version: "synthetic", sandbox: "os" }], tags: [], max_concurrent: 1,
    }, new Date());
    const native = f.hub.modules.native;
    let open: Extract<NativeRuntimeCommand, { type: "open" }> | undefined;
    const { promise: turn, resolve: gotTurn } = Promise.withResolvers<Extract<NativeRuntimeCommand, { type: "turn" }>>();
    const channel = {
      id: randomUUID(), data: { runtime: runtime.actor.id }, close() {}, terminate() {},
      send(raw: string) {
        const packet = NativeRuntimeCommand.parse(JSON.parse(raw));
        if (packet.type === "open") open = packet;
        if (packet.type === "turn") gotTurn(packet);
      },
    };
    native.channelOpen(channel);
    native.channelMessage(channel, JSON.stringify({
      type: "hello", protocol: 1, instance: "synthetic", version: "synthetic", isolation: "macos-seatbelt",
    }));
    const post = (path: string, body: object) => f.api(path, f.owner.token, "POST", body);
    const connection = AIConnection.parse(await (await post("/v2/ai/connections", { name: "Synthetic", kind: "codex-account", host: "server" })).json());
    const profile = AIProfile.parse(await (await post("/v2/ai/profiles", { name: "Synthetic", connection: connection.id, engine: "codex", model: "default" })).json());
    const session = NativeSession.parse(await (await post("/v2/assistant/native-sessions", { request_id: randomUUID(), profile: profile.id })).json());
    const event = (sequence: number, event: object, turn?: string) =>
      native.channelMessage(channel, JSON.stringify({ type: "event", session: session.id, sequence, event, turn }));
    event(1, { type: "state", view: { state: "ready", models: [] } });
    const base = `/v2/native-mcp/${session.id}`, token = open!.mcp_token;
    const tools = await f.api(`${base}/tools`, token);
    expect(tools.status).toBe(200);
    const catalog = await tools.json() as { tools: { name: string }[] };
    expect(catalog.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([toolName(create), toolName(update)]));
    const chat = post("/v2/assistant/chat", { request_id: randomUUID(), conversation: session.conversation, message: "Record this in an AI note" });
    const active = await Promise.race([turn, chat.then(() => { throw new Error("Native turn did not start"); })]);
    try {
      const call = (capability: string, args: object) => f.api(`${base}/call`, token, "POST", { request_id: randomUUID(), tool: toolName(capability), args });
      const created = await call(create, { title: "Native summary", body: "Synthetic native assistant note" });
      expect(created.status).toBe(200);
      const result = KnowledgeAiNoteResult.parse(NativeMCPResult.parse(await created.json()).result);
      const message = f.hub.modules.assistantStore.messages(session.conversation).find(value => value.turn === active.turn && value.role === "user")!;
      expect((await f.metadata(result.note.path)).derived_from).toEqual([message.id]);
      const conflict = await call(update, { note: result.note.id, expected_revision: "0".repeat(64), title: "Stale update" });
      expect(conflict.status).toBe(409);
      expect(ApiError.parse(await conflict.json()).error).toMatchObject({ code: "CONFLICT", reason: "revision_conflict" });
    } finally {
      event(2, { type: "complete", status: "done", text: "Recorded." }, active.turn);
      expect((await chat).status).toBe(200);
    }
  } finally { await f.close(); }
});

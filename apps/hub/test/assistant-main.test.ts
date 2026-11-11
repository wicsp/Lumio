import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantModel } from "@lumio/assistant";
import { parseFrontmatter } from "@lumio/knowledge";
import {
  AI_NOTE_CAPABILITY_NAMES, AiNote, ApiError, AssistantChatResult, AssistantConversationDetail, AssistantEvent,
  AssistantMain, AssistantModelRequest, KnowledgeAiNoteResult, ResourceRef, WorkCommandResult, toolName,
} from "@lumio/schema";
import { authorize } from "../src/authorize.ts";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";

const publicRef = ResourceRef.parse({ module: "knowledge", id: "idea_00000000000000000000000001" });
const privateRef = ResourceRef.parse({ module: "knowledge", id: "ast_00000000000000000000000001" });

async function fixture(model: AssistantModel, authorizeRead = authorize) {
  const root = await mkdtemp(join(tmpdir(), "lumio-a1-3-"));
  const vault = join(root, "vault");
  await cp(new URL("../../../fixtures/k4-ai-notes", import.meta.url), vault, { recursive: true });
  const config = { ...readConfig({ HOME: root, LUMIO_STATE_DIR: join(root, "state"), LUMIO_VAULT: vault }), port: 0 };
  const start = () => startHub(config, {
    authorize: authorizeRead, assistantModel: model, assistantHome: join(root, "assistant"), log() {},
  });
  let hub = await start();
  const credential = (name: string, role: "human" | "agent" | "runtime" = "human") => {
    const actor = hub.store.createActor(name, role);
    return { actor, token: hub.store.createToken(name, name) };
  };
  const owner = credential("owner");
  const api = (path: string, method: string, body?: unknown, token = owner.token, accept = "application/json") =>
    fetch(new URL(path, hub.server.url), {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Accept-Language": "en", Accept: accept },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ensure = (request_id = randomUUID(), token = owner.token) => api("/v2/assistant/main", "POST", { request_id }, token);
  const chat = (input: object, accept?: string) =>
    api("/v2/assistant/chat", "POST", { request_id: randomUUID(), ...input }, owner.token, accept);
  const task = async (args: object) => {
    const response = await api("/v2/work/commands", "POST", { request_id: randomUUID(), operation: { op: "work.task.create", args } });
    expect(response.status).toBe(200);
    const result = WorkCommandResult.parse(await response.json());
    if (result.kind !== "task") throw new Error("Expected a task");
    return result.task;
  };
  return {
    get hub() { return hub; }, owner, vault, api, ensure, chat, task, credential,
    async restart() { await hub.stop(); hub = await start(); },
    async close() { await hub.stop(); await rm(root, { recursive: true, force: true }); },
  };
}

const reply = { content: "Synthetic reply", tool_calls: [] };
const events = async (response: Response) => {
  expect(response.status).toBe(200);
  return (await response.text()).trim().split("\n").map(line => AssistantEvent.parse(JSON.parse(line)));
};

test("main ensure creates one durable conversation per human and leaves existing chats ordinary", async () => {
  const f = await fixture({ async complete() { return reply; } });
  try {
    const ordinary = AssistantChatResult.parse(await (await f.chat({ message: "Ordinary chat" })).json()).conversation.id;
    const request = randomUUID();
    const first = await Promise.all(Array.from({ length: 4 }, async () => AssistantMain.parse(await (await f.ensure(request)).json())));
    const id = first[0]!.conversation;
    expect(id).not.toBe(ordinary);
    expect(first.filter(result => result.created)).toHaveLength(1);
    expect(first.every(result => result.conversation === id)).toBe(true);
    const detail = AssistantConversationDetail.parse(await (await f.api("/v2/assistant/conversations/" + id, "GET")).json());
    expect(detail.conversation).toMatchObject({ owner: f.owner.actor.id, revision: 1 });
    expect(detail.messages).toEqual([]);
    expect(detail.turns).toEqual([]);

    const other = f.credential("other");
    expect(AssistantMain.parse(await (await f.ensure(randomUUID(), other.token)).json()).conversation).not.toBe(id);
    expect((await f.api("/v2/assistant/conversations/" + id, "GET", undefined, other.token)).status).toBe(404);
    for (const role of ["agent", "runtime"] as const) {
      const denied = await f.ensure(randomUUID(), f.credential(role, role).token);
      expect(denied.status).toBe(403);
      expect(ApiError.parse(await denied.json()).error.code).toBe("FORBIDDEN");
    }
    expect((await f.api("/v2/assistant/main", "POST", { request_id: randomUUID(), extra: true })).status).toBe(400);
    for (const conversation of [undefined, ordinary]) {
      expect((await f.chat({ conversation, message: "Unexpected focus", focus: { section: "work" } }, "application/x-ndjson")).status).toBe(400);
    }
    await f.restart();
    expect(AssistantMain.parse(await (await f.ensure()).json())).toEqual({ conversation: id, created: false });
  } finally { await f.close(); }
});

test("validates Unicode and byte budgets, snapshots delivered focus, and uses the agent view for anchors and links", async () => {
  const inputs: AssistantModelRequest[] = [];
  const readers: string[] = [];
  let taskRef: ResourceRef;
  const f = await fixture({ async complete(input) {
    inputs.push(AssistantModelRequest.parse(input));
    if (input.messages.at(-1)?.content === "What should I do here?") {
      return { content: "", tool_calls: [{ id: "synthetic-read", name: toolName("work.task.show"), args: { task: taskRef.id } }] };
    }
    return reply;
  } }, (actor, request) => {
    if (actor && ["work.read", "show", "links"].includes(request.operation)) readers.push(actor.id);
    return authorize(actor, request);
  });
  try {
    const conversation = AssistantMain.parse(await (await f.ensure()).json()).conversation;
    const dependency = await f.task({ title: "Setup task", description: "Long next-hop detail that must stay out of the model request." });
    const task = await f.task({
      title: "Synthetic primary task", description: "Synthetic task body",
      dependencies: [dependency.id], references: [publicRef, { ...privateRef, label: "Untrusted private link label" }],
    });
    taskRef = ResourceRef.parse({ module: "work", id: task.id });
    const baseFocus = { section: "work", primary: { ...taskRef, label: "Client label must not become context" } };
    const grapheme = "e\u0301";
    for (const focus of [
      { ...baseFocus, selection_text: grapheme.repeat(513) },
      { ...baseFocus, primary: { ...taskRef, label: "界".repeat(3_000) } },
    ]) {
      const bad = await f.chat({ conversation, message: "Invalid focus", focus }, "application/x-ndjson");
      expect(bad.status).toBe(400);
      expect(ApiError.parse(await bad.json()).error.code).toBe("INVALID");
    }
    expect(inputs).toHaveLength(0);

    const selection = grapheme.repeat(512);
    const first = await events(await f.chat({
      conversation, message: "What should I do here?", focus: { ...baseFocus, selection_text: selection },
    }, "application/x-ndjson"));
    expect(first[0]).toMatchObject({ type: "topic", anchors: [taskRef] });
    expect(first.at(-1)?.type).toBe("result");
    expect(inputs).toHaveLength(2);
    const system = inputs[0]!.messages[0]!.content;
    expect(system).toContain(selection);
    expect(system).toContain("Synthetic task body");
    expect(system).toContain("Prerequisite: Setup task");
    expect(system).not.toContain("Client label must not become context");
    expect(system).not.toContain(privateRef.id);
    expect(readers).toContain(f.hub.store.assistantActor().id);
    expect(readers).not.toContain(f.owner.actor.id);

    const projected = JSON.parse(inputs[1]!.messages.at(-1)!.content);
    expect(projected).toMatchObject({
      item: { id: task.id, revision: task.revision },
      related: expect.arrayContaining([{ ref: { module: "work", id: dependency.id }, summary: "Prerequisite: Setup task" }]),
    });
    expect(JSON.stringify(projected)).not.toContain("Long next-hop detail");
    expect(JSON.stringify(projected)).not.toContain(privateRef.id);

    const rows = f.hub.store.db.query<{ request: string; tool_actor: string }, [string]>(
      "SELECT request, tool_actor FROM assistant_contexts WHERE turn=? ORDER BY step",
    ).all(first[0]!.turn);
    expect(rows.map(row => AssistantModelRequest.parse(JSON.parse(row.request)))).toEqual(inputs);
    expect(rows.every(row => row.tool_actor === f.hub.store.assistantActor().id)).toBe(true);

    await events(await f.chat({
      conversation, message: "Read the open item", focus: {
        section: "knowledge", primary: { ...privateRef, label: "Private focus label" }, selection_text: "Private selected content",
      },
    }, "application/x-ndjson"));
    const privateSystem = inputs.at(-1)!.messages[0]!.content;
    expect(privateSystem).toContain("clarifying question");
    expect(privateSystem).not.toContain("Private selected content");
    expect(privateSystem).not.toContain("Private focus label");
    expect(privateSystem).not.toContain(privateRef.id);
  } finally { await f.close(); }
});

test("main preflights native profiles and retains the AI note's current message source", async () => {
  let saved: KnowledgeAiNoteResult | undefined;
  const create = AI_NOTE_CAPABILITY_NAMES[0];
  const f = await fixture({ async complete(input) {
    const last = input.messages.at(-1)!;
    if (last.role === "user") return {
      content: "", tool_calls: [{ id: "synthetic-note", name: toolName(create), args: { title: "Conclusion", body: "Synthetic finding" } }],
    };
    saved = KnowledgeAiNoteResult.parse(JSON.parse(last.content));
    return reply;
  } });
  try {
    const conversation = AssistantMain.parse(await (await f.ensure()).json()).conversation;
    const native = f.hub.modules.ai.connection(f.owner.actor.id, { name: "Synthetic Codex", kind: "codex-account", host: "server" });
    const profile = f.hub.modules.ai.profile(f.owner.actor.id, {
      name: "Synthetic Codex", connection: native.id, engine: "codex", model: "default",
    });
    const denied = await f.chat({ conversation, profile: profile.id, message: "Native main" }, "application/x-ndjson");
    expect(denied.status).toBe(400);
    expect(ApiError.parse(await denied.json()).error.reason).toBe("ai-api-profile-required");

    const result = AssistantChatResult.parse(await (await f.chat({ conversation, message: "Save the synthetic conclusion" })).json());
    expect(result.turn.status).toBe("done");
    expect(saved).toBeDefined();
    const note = AiNote.parse(parseFrontmatter(await readFile(join(f.vault, saved!.note.path))).data);
    expect(note.derived_from).toEqual([result.messages.find(message => message.role === "user")!.id]);
  } finally { await f.close(); }
});

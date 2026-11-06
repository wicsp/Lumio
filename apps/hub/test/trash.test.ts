import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiError, AssistantChatResult, AssistantConversationDetail, Job, KnowledgeDocument, KnowledgeReferencesResult,
  LinksResult, SearchResult, TrashListResult, TrashPurgeResult, TrashRestoreResult, TrashResult, WorkCommandResult,
  WorkTask, WorkTaskDetail, type AssistantModelResponse,
} from "@lumio/schema";
import type { AssistantModel } from "@lumio/assistant";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";

async function fixture(withVault = false, assistantModel?: AssistantModel) {
  const root = await mkdtemp(join(tmpdir(), "lumio-trash-"));
  const vault = join(root, "vault");
  if (withVault) await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  let time = new Date("2026-11-06T12:00:00Z"), sequence = 0;
  const config = { ...readConfig({ LUMIO_STATE_DIR: join(root, "state"), ...(withVault ? { LUMIO_VAULT: vault } : {}) }), port: 0, localRuntime: "server" };
  const options = { now: () => time, assistantHome: join(root, "assistant"), log() {}, assistantModel };
  let hub = await startHub(config, options);
  const token = (name: string, role: "human" | "agent" | "runtime" = "human") => {
    const actor = hub.store.createActor(name, role);
    return { actor, token: hub.store.createToken(name, name) };
  };
  const human = token("owner");
  const request = (path: string, method = "GET", body?: unknown, credential = human.token) =>
    fetch(new URL(path, hub.server.url), { method, headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const requestId = () => `synthetic-trash-${++sequence}`;
  const rawCommand = (op: string, args: Record<string, unknown>, id = requestId(), credential?: string) =>
    request("/v2/work/commands", "POST", { request_id: id, operation: { op, args } }, credential);
  return { root, vault, get hub() { return hub; }, token, request, rawCommand, requestId, human, options,
    async restart() { await hub.stop(); hub = await startHub(config, options); },
    async command(op: string, args: Record<string, unknown>, id?: string) {
      const response = await rawCommand(op, args, id);
      expect(response.status).toBe(200);
      return WorkCommandResult.parse(await response.json());
    },
    advance(ms: number) { time = new Date(time.getTime() + ms); },
    async close() { await hub.stop(); await rm(root, { recursive: true, force: true }); },
  };
}

async function trashed(response: Response) {
  expect(response.status).toBe(404);
  expect(ApiError.parse(await response.json()).error).toMatchObject({ code: "NOT_FOUND", reason: "trashed" });
}

test("Work deletion cancels a round atomically and retains incoming references and execution history", async () => {
  const f = await fixture();
  try {
    const agent = f.token("reader", "agent"), runtime = f.token("server", "runtime");
    f.hub.store.registerRuntime(runtime.actor.id, { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "0.50.1", sandbox: "none" }], tags: [], max_concurrent: 1 }, f.options.now());
    const task = WorkTask.parse((await f.command("work.task.create", { title: "Synthetic parent", description: "Task to be deleted" }) as { task: unknown }).task);
    const child = WorkTask.parse((await f.command("work.task.create", { title: "Child", parent: task.id, dependencies: [task.id] }) as { task: unknown }).task);
    const run = await f.command("work.task.dispatch", { task: task.id, to: "pi@server" });
    if (run.kind !== "job") throw new Error("expected a round");
    const job = run.job.spec.id;
    expect((await f.request("/v1/runtime/ack", "POST", { accepted: [job] }, runtime.token)).status).toBe(200);
    const args = { task: task.id, expected_revision: task.revision + 1 };
    expect((await f.rawCommand("work.task.delete", args, undefined, agent.token)).status).toBe(403);
    expect((await f.rawCommand("work.task.delete", { ...args, expected_revision: task.revision })).status).toBe(409);

    const audit = f.hub.store.audit.bind(f.hub.store);
    f.hub.store.audit = (...args) => {
      if (args[1] === "work.task.delete") throw new Error("Synthetic audit failure");
      return audit(...args);
    };
    const deleteId = f.requestId();
    expect((await f.rawCommand("work.task.delete", args, deleteId)).status).toBe(500);
    expect(f.hub.store.executionStore.cancelRequested(job)).toBe(false);
    expect(f.hub.modules.work.task(task.id).turn.reason).toBe("working");
    f.hub.store.audit = audit;

    const deleted = await f.command("work.task.delete", args, deleteId);
    expect(deleted).toMatchObject({ kind: "trashed", item: { stopped_job: job, expires_at: "2026-12-06T12:00:00.000Z" } });
    expect(await f.command("work.task.delete", args, deleteId)).toEqual(deleted);
    expect(f.hub.store.executionStore.cancelRequested(job)).toBe(true);
    await trashed(await f.request(`/v2/work/tasks/${task.id}`, "GET", undefined, agent.token));
    expect(await (await f.request("/v2/work/tasks?q=Synthetic")).json()).toEqual([]);
    expect(await (await f.request("/v2/work/attention")).json()).toEqual([]);

    const restorePath = `/v2/trash/${task.id}/restore`, restore = { request_id: f.requestId() };
    const restored = TrashRestoreResult.parse(await (await f.request(restorePath, "POST", restore)).json());
    expect(TrashRestoreResult.parse(await (await f.request(restorePath, "POST", restore)).json())).toEqual(restored);
    const detail = WorkTaskDetail.parse(await (await f.request(`/v2/work/tasks/${task.id}`)).json());
    expect(detail.task).toMatchObject({ outcome: "open", turn: { reason: "todo" } });
    expect(detail.executions[0]?.job).toBe(job);
    await f.command("work.task.delete", { task: task.id, expected_revision: detail.task.revision });
    const purgePath = `/v2/trash/${task.id}`, purge = { request_id: f.requestId() };
    const purged = TrashPurgeResult.parse(await (await f.request(purgePath, "DELETE", purge)).json());
    expect(TrashPurgeResult.parse(await (await f.request(purgePath, "DELETE", purge)).json())).toEqual(purged);
    const absent = ApiError.parse(await (await f.request(`/v2/work/tasks/${task.id}`)).json());
    expect(absent.error.code).toBe("NOT_FOUND");
    expect(absent.error.reason).toBeUndefined();
    expect(Job.parse(await (await f.request(`/v2/execution/jobs/${job}`)).json()).spec.source?.task).toBe(task.id);
    expect((await f.command("work.task.update", { task: child.id, expected_revision: child.revision, patch: { title: "Renamed child" } })))
      .toMatchObject({ task: { parent: task.id, dependencies: [task.id] } });
    expect(await f.command("work.task.delete", args, deleteId)).toEqual(deleted);
  } finally { await f.close(); }
});

test("Project deletion detaches tasks and restoration reattaches only those still without a project", async () => {
  const f = await fixture();
  try {
    const project = async (title: string) => {
      const result = await f.command("work.project.create", { title });
      if (result.kind !== "project") throw new Error("expected a project");
      return result.project;
    };
    const original = await project("Original"), other = await project("Other");
    const task = async (title: string) => WorkTask.parse((await f.command("work.task.create", { title, project: original.id }) as { task: unknown }).task);
    const stay = await task("Stay"), move = await task("Move");
    const result = await f.command("work.project.delete", { project: original.id, expected_revision: original.revision });
    expect(result).toMatchObject({ kind: "trashed", item: { detached_tasks: expect.arrayContaining([stay.id, move.id]) } });
    await trashed(await f.request(`/v2/work/projects/${original.id}`));
    expect(f.hub.modules.work.projects().map(p => p.id)).toEqual([other.id]);
    expect(f.hub.modules.work.task(stay.id).project).toBeUndefined();
    expect(f.hub.modules.work.task(move.id).revision).toBe(2);
    await f.command("work.task.update", { task: move.id, expected_revision: 2, patch: { project: other.id } });
    const restored = TrashRestoreResult.parse(await (await f.request(`/v2/trash/${original.id}/restore`, "POST", { request_id: f.requestId() })).json());
    expect(restored.reattached_tasks).toEqual([stay.id]);
    expect(f.hub.modules.work.task(stay.id)).toMatchObject({ revision: 3, project: original.id });
    expect(f.hub.modules.work.task(move.id)).toMatchObject({ revision: 3, project: other.id });
  } finally { await f.close(); }
});

function git(vault: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", vault, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

test("Knowledge deletion hides notes and references, keeps bytes, and commits collisions and purge", async () => {
  const f = await fixture(true);
  try {
    const id = "idea_00000000000000000000000004", notePath = `/v2/knowledge/notes/${id}`;
    const doc = KnowledgeDocument.parse(await (await f.request(`${notePath}/document`)).json());
    const path = doc.document.note.path, trashedPath = path.replace(/\.md$/, "-2.md");
    const original = await readFile(join(f.vault, path));
    await mkdir(join(f.vault, ".trash", "research", "ideas"), { recursive: true });
    await writeFile(join(f.vault, ".trash", path), "Existing trash file");
    await writeFile(join(f.vault, ".gitignore"), ".trash/\n");
    git(f.vault, "init", "-q");
    git(f.vault, "config", "user.name", "Fixture");
    git(f.vault, "config", "user.email", "fixture@example.invalid");
    git(f.vault, "config", "commit.gpgsign", "false");
    git(f.vault, "add", ".");
    git(f.vault, "commit", "-qm", "Fixture");
    const agent = f.token("reader", "agent");
    const input = { request_id: f.requestId(), expected_revision: doc.revision };
    expect((await f.request(notePath, "DELETE", input, agent.token)).status).toBe(403);
    expect((await f.request(notePath, "DELETE", { ...input, expected_revision: "0".repeat(64) })).status).toBe(409);
    const deleted = TrashResult.parse(await (await f.request(notePath, "DELETE", input)).json());
    expect(deleted.item).toMatchObject({ kind: "note", path });
    expect(TrashResult.parse(await (await f.request(notePath, "DELETE", input)).json())).toEqual(deleted);
    expect(await readFile(join(f.vault, ".trash", trashedPath))).toEqual(original);
    expect(git(f.vault, "show", `HEAD:.trash/${trashedPath}`)).toBe(original.toString());
    await trashed(await f.request(`${notePath}/document`));
    await trashed(await f.request(`/v1/notes/${id}/links`, "GET", undefined, agent.token));
    expect(SearchResult.parse(await (await f.request("/v1/search?type=idea")).json()).hits.some(hit => hit.note.id === id)).toBe(false);
    expect(KnowledgeReferencesResult.parse(await (await f.request("/v2/knowledge/references", "POST", { source_kind: "idea", query: doc.document.note.title })).json()).hits.some(hit => hit.note.id === id)).toBe(false);

    await writeFile(join(f.vault, path), "Replacement note");
    const restored = TrashRestoreResult.parse(await (await f.request(`/v2/trash/${id}/restore`, "POST", { request_id: f.requestId() })).json());
    expect(restored).toMatchObject({ renamed: true, path: trashedPath });
    expect(await readFile(join(f.vault, path), "utf8")).toBe("Replacement note");
    expect(await readFile(join(f.vault, trashedPath))).toEqual(original);
    expect(LinksResult.parse(await (await f.request(`/v1/notes/${id}/links`)).json()).note.path).toBe(trashedPath);

    TrashResult.parse(await (await f.request(notePath, "DELETE", { ...input, request_id: f.requestId() })).json());
    const purge = { request_id: f.requestId() };
    const purged = TrashPurgeResult.parse(await (await f.request(`/v2/trash/${id}`, "DELETE", purge)).json());
    expect(TrashPurgeResult.parse(await (await f.request(`/v2/trash/${id}`, "DELETE", purge)).json())).toEqual(purged);
    expect(await readFile(join(f.vault, ".trash", path), "utf8")).toBe("Existing trash file");
    expect(git(f.vault, "ls-tree", "-r", "HEAD", "--", `.trash/${trashedPath}`)).toBe("");
  } finally { await f.close(); }
});

test("Conversation deletion cancels active generation, scopes trash to its owner and keeps memories through expiry", async () => {
  const begun = Promise.withResolvers<AbortSignal>(), late = Promise.withResolvers<AssistantModelResponse>();
  const f = await fixture(false, { async complete(input, options) {
    if (input.messages.at(-1)?.content === "Slow") {
      begun.resolve(options.signal!);
      return late.promise;
    }
    return { content: "Synthetic reply", tool_calls: [] };
  } });
  try {
    const stranger = f.token("stranger"), agent = f.token("agent", "agent");
    const chat = (message: string, conversation?: string) => f.request("/v2/assistant/chat", "POST", { request_id: f.requestId(), message, conversation });
    const { conversation } = AssistantChatResult.parse(await (await chat("First")).json());
    const id = conversation.id, path = `/v2/assistant/conversations/${id}`;
    const memory = await f.request("/v2/assistant/memory-commands", "POST", { request_id: f.requestId(),
      operation: { op: "assistant.memory.remember", args: { content: "Synthetic preference" } } });
    expect(memory.status).toBe(200);
    const active = chat("Slow", id);
    const signal = await begun.promise;
    const input = { request_id: f.requestId() };
    expect((await f.request(path, "DELETE", input, agent.token)).status).toBe(403);
    expect((await f.request(path, "DELETE", input, stranger.token)).status).toBe(404);
    const deleted = TrashResult.parse(await (await f.request(path, "DELETE", input)).json());
    expect(signal.aborted).toBe(true);
    late.resolve({ content: "Late synthetic reply", tool_calls: [] });
    await trashed(await active);
    await trashed(await f.request(path));
    expect(TrashListResult.parse(await (await f.request("/v2/trash", "GET", undefined, stranger.token)).json()).items).toEqual([]);
    expect((await f.request(`/v2/trash/${id}/restore`, "POST", { request_id: f.requestId() }, stranger.token)).status).toBe(404);
    expect((await f.request("/v2/trash", "GET", undefined, agent.token)).status).toBe(403);
    expect(TrashListResult.parse(await (await f.request("/v2/trash?kind=conversation")).json()).items).toEqual([deleted.item]);
    const restore = await f.request(`/v2/trash/${id}/restore`, "POST", { request_id: f.requestId() });
    expect(TrashRestoreResult.parse(await restore.json()).id).toBe(id);
    const restored = AssistantConversationDetail.parse(await (await f.request(path)).json());
    expect(restored.turns.at(-1)?.status).toBe("cancelled");
    expect(restored.messages.some(message => message.content === "Late synthetic reply")).toBe(false);
    expect(TrashResult.parse(await (await f.request(path, "DELETE", input)).json())).toEqual(deleted);
    expect((await chat("Still usable", id)).status).toBe(200);

    await f.request(path, "DELETE", { request_id: f.requestId() });
    f.advance(30 * 86_400_000 - 1);
    await f.hub.modules.trash.sweep();
    await trashed(await f.request(path));
    f.advance(1);
    await f.hub.modules.trash.sweep();
    expect(ApiError.parse(await (await f.request(path)).json()).error.reason).toBeUndefined();
    expect(f.hub.modules.assistantStore.turns(id)).toEqual([]);
    expect(await (await f.request("/v2/assistant/memories")).json()).toMatchObject([{ content: "Synthetic preference" }]);
  } finally { late.resolve({ content: "Teardown", tool_calls: [] }); await f.close(); }
});

test("Hub restart completes an interrupted note move and removes expired notes and projects", async () => {
  const f = await fixture(true);
  try {
    const id = "idea_00000000000000000000000004", notePath = `/v2/knowledge/notes/${id}`;
    const doc = KnowledgeDocument.parse(await (await f.request(`${notePath}/document`)).json());
    const path = doc.document.note.path;
    const request = { request_id: f.requestId(), expected_revision: doc.revision };
    const audit = f.hub.store.audit.bind(f.hub.store);
    f.hub.store.audit = (...args) => {
      if (args[1] === "knowledge.delete" && args[4] === "applied") throw new Error("Synthetic audit failure");
      return audit(...args);
    };
    expect((await f.request(notePath, "DELETE", request)).status).toBe(500);
    expect(await Bun.file(join(f.vault, path)).exists()).toBe(false);
    await trashed(await f.request(`${notePath}/document`));

    await f.restart();
    const replay = TrashResult.parse(await (await f.request(notePath, "DELETE", request)).json());
    expect(replay.item).toMatchObject({ id, path, expires_at: "2026-12-06T12:00:00.000Z" });
    const created = await f.command("work.project.create", { title: "Expiring project" });
    if (created.kind !== "project") throw new Error("expected a project");
    await f.command("work.project.delete", { project: created.project.id, expected_revision: created.project.revision });

    f.advance(30 * 86_400_000);
    await f.restart();
    expect(TrashListResult.parse(await (await f.request("/v2/trash")).json()).items).toEqual([]);
    expect(await Bun.file(join(f.vault, ".trash", path)).exists()).toBe(false);
    expect(ApiError.parse(await (await f.request(`/v2/work/projects/${created.project.id}`)).json()).error.reason).toBeUndefined();
    expect(TrashResult.parse(await (await f.request(notePath, "DELETE", request)).json())).toEqual(replay);
  } finally { await f.close(); }
});

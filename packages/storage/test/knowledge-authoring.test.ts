import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { newId } from "@lumio/foundation";
import { KnowledgeCreateRequest } from "@lumio/schema";
import { KnowledgeCreationStore } from "../src/knowledge/authoring.ts";
import fixtures from "../../../fixtures/knowledge-authoring/notes.json";
let root: string, vault: string, db: Database, store: KnowledgeCreationStore;
const ctx = { now: new Date("2026-11-06T00:00:00Z"), tz: "UTC", newId: (prefix: Parameters<typeof newId>[0]) => newId(prefix, new Date(), randomBytes) };
let audits = 0;
const hooks = { validate() {}, async finalize() {}, audit() { audits++; } };
const input = () => KnowledgeCreateRequest.parse(fixtures[0]);
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lumio-note-write-")); vault = join(root, "vault"); await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true }); db = new Database(join(root, "hub.sqlite")); store = new KnowledgeCreationStore(db, vault); audits = 0; });
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
test("same request replays one stable result, changed payload and same title conflict", async () => {
  const first = await store.create("human", input(), ctx, hooks);
  expect(await store.create("human", input(), ctx, hooks)).toEqual(first); expect(audits).toBe(1);
  await expect(store.create("human", { ...input(), body: "changed" }, ctx, hooks)).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  await expect(store.create("human", { ...input(), request_id: "another-request-id-01" }, ctx, hooks)).rejects.toMatchObject({ code: "FILE_EXISTS" });
});
test("restart resumes a published note; never overwrites changed or missing file", async () => {
  await expect(store.create("human", input(), ctx, { ...hooks, async published() { throw new Error("simulated crash"); } })).rejects.toMatchObject({ code: "NOTE_SAVE_UNCERTAIN" });
  const row = db.query<{ result: string }, []>("SELECT result FROM knowledge_creations").get()!;
  const result = JSON.parse(row.result);
  db.close(); db = new Database(join(root, "hub.sqlite")); store = new KnowledgeCreationStore(db, vault);
  const bytes = await readFile(join(vault, result.path));
  await writeFile(join(vault, result.path), "external edit");
  await expect(store.create("human", input(), ctx, hooks)).rejects.toMatchObject({ code: "NOTE_RECOVERY_CONFLICT" });
  expect(await readFile(join(vault, result.path), "utf8")).toBe("external edit");
  await writeFile(join(vault, result.path), bytes);
  expect(await store.create("human", input(), ctx, hooks)).toEqual(result); expect(audits).toBe(1);
});
test("directory and final file symlinks do not write outside vault", async () => {
  const outside = join(root, "outside"); await mkdir(outside);
  await rm(join(vault, "research/ideas"), { recursive: true, force: true }); await symlink(outside, join(vault, "research/ideas"));
  await expect(store.create("human", input(), ctx, hooks)).rejects.toMatchObject({ code: "UNSAFE_NOTE_PATH" });
  expect(await readdir(outside)).toEqual([]);
  await unlink(join(vault, "research/ideas")); await mkdir(join(vault, "research/ideas"));
  const target = join(outside, "target"); await writeFile(target, "keep"); await symlink(target, join(vault, "research/ideas/合成研究想法.md"));
  await expect(store.create("human", input(), ctx, hooks)).rejects.toMatchObject({ code: "UNSAFE_NOTE_PATH" });
  expect(await readFile(target, "utf8")).toBe("keep");
});
test("paper identity duplicates rejected; different paper citekey collision uses suffix", async () => {
  const paper = KnowledgeCreateRequest.parse(fixtures[3]);
  const first = await store.create("human", paper, ctx, hooks);
  await expect(store.create("human", { ...paper, request_id: "another-paper-request" }, ctx, hooks)).rejects.toMatchObject({ code: "DUPLICATE_PAPER" });
  if (paper.note.kind !== "paper") throw new Error();
  const second = await store.create("human", { ...paper, request_id: "different-paper-request", note: { ...paper.note, doi: "10.5555/another-fixture" } }, ctx, hooks);
  expect(second.path).toBe(first.path.replace(".md", "b.md"));
});

test("deleted interrupted publication releases its reservation without resurrecting the old request", async () => {
  await expect(store.create("human", input(), ctx, { ...hooks, async published() { throw new Error("crash"); } })).rejects.toMatchObject({ code: "NOTE_SAVE_UNCERTAIN" });
  const result = JSON.parse(db.query<{ result: string }, []>("SELECT result FROM knowledge_creations").get()!.result);
  await unlink(join(vault, result.path));
  const next = await store.create("human", { ...input(), request_id: "fresh-note-after-delete" }, ctx, hooks);
  expect(next.id).not.toBe(result.id); expect(next.path).toBe(result.path);
  await expect(store.create("human", input(), ctx, hooks)).rejects.toMatchObject({ code: "NOTE_RECOVERY_CONFLICT" });
});
test("prepared receipt with no file recovers the same allocated ID", async () => {
  let calls = 0;
  await expect(store.create("human", input(), ctx, { ...hooks, validate() { if (++calls === 2) throw new Error("stop before publication"); } })).rejects.toThrow();
  const allocated = JSON.parse(db.query<{ result: string }, []>("SELECT result FROM knowledge_creations").get()!.result);
  expect(await store.create("human", input(), ctx, hooks)).toEqual(allocated);
});
test("an unpublished interrupted reservation does not block the title for a later request", async () => {
  let calls = 0;
  await expect(store.create("human", input(), ctx, { ...hooks, validate() { if (++calls === 2) throw new Error("stop before publication"); } })).rejects.toThrow();
  const allocated = JSON.parse(db.query<{ result: string }, []>("SELECT result FROM knowledge_creations").get()!.result);
  const next = await store.create("human", { ...input(), request_id: "after-reload-request" }, ctx, hooks);
  expect(next.path).toBe(allocated.path); expect(next.id).not.toBe(allocated.id);
  await expect(store.create("human", input(), ctx, hooks)).rejects.toMatchObject({ code: "NOTE_RECOVERY_CONFLICT" });
});

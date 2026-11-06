import { beforeEach, afterEach, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, rm, readFile, writeFile, unlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEditingStore, readKnowledgeDocument, relatedKnowledge, knowledgeReferences } from "../src/knowledge/editing.ts";
import { updateIndex } from "../src/knowledge/index/store.ts";
let root: string, vault: string, db: Database, store: KnowledgeEditingStore;
const id = "idea_00000000000000000000000004";
const options = () => ({ stateDir: root });
let audits = 0;
const hooks = () => ({ now: new Date("2026-11-06T04:00:00Z"), validate() { }, async finalize() { await updateIndex(vault, options()); }, audit() { audits++; } });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lumio-edit-")); vault = join(root, "vault"); await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true }); db = new Database(join(root, "business.sqlite")); store = new KnowledgeEditingStore(db, vault, options()); await updateIndex(vault, options()); audits = 0; });
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
const input = async () => ({ request_id: "edit-fixture-0000001", expected_revision: (await readKnowledgeDocument(vault, id, options())).revision, title: "Changed title", body: "Changed body\n\n[[Alpha_2024_Paper]]" });
test("edit preserves identity and unknown fields, updates index, and replays once", async () => {
    const before = await readKnowledgeDocument(vault, id, options()), request = await input();
    const result = await store.update("human", id, request, hooks());
    expect(result.document.frontmatter.related).toEqual(before.document.frontmatter.related);
    expect(result.document.note.path).toBe(before.document.note.path);
    expect(result.document.body).toBe(request.body);
    expect(result.revision).not.toBe(before.revision);
    expect(await store.update("human", id, request, hooks())).toEqual(result);
    expect(audits).toBe(1);
    await expect(store.update("human", id, { ...request, body: "different" }, hooks())).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
});
test("external edit before publication is preserved and stale revision rejected", async () => {
    const request = await input(), path = join(vault, "research/ideas/Main.md"), original = await readFile(path, "utf8");
    await expect(store.update("human", id, request, { ...hooks(), beforeWrite: async () => { await writeFile(path, original + "external"); } })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe(original + "external");
    await expect(store.update("human", id, { ...request, request_id: "edit-fixture-0000002" }, hooks())).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
});
test("publication crash recovers after reopening without rewriting later external edits", async () => {
    const request = await input();
    await expect(store.update("human", id, request, { ...hooks(), async finalize() { throw new Error("crash"); } })).rejects.toThrow("crash");
    db.close();
    db = new Database(join(root, "business.sqlite"));
    store = new KnowledgeEditingStore(db, vault, options());
    expect((await store.update("human", id, request, hooks())).document.body).toBe(request.body);
    expect(audits).toBe(1);
    const path = join(vault, "research/ideas/Main.md");
    const bytes = await readFile(path, "utf8");
    await writeFile(path, bytes + "after");
    await store.update("human", id, request, hooks());
    expect(await readFile(path, "utf8")).toBe(bytes + "after");
});
test("deleted notes and symlinks are not recreated or followed", async () => {
    const request = await input(), path = join(vault, "research/ideas/Main.md"), outside = join(root, "outside");
    await writeFile(outside, "keep");
    await unlink(path);
    await symlink(outside, path);
    await expect(store.update("human", id, request, hooks())).rejects.toMatchObject({ code: "NOTE_NOT_EDITABLE" });
    expect(await readFile(outside, "utf8")).toBe("keep");
});
test("reference context matches related notes; explicit query searches body with real matching snippet", async () => {
    const context = { title: "", text: "", focus: "English index" };
    const related = await relatedKnowledge(vault, { ...context, exclude_id: id }, options());
    const refs = await knowledgeReferences(vault, { source_id: id, query: "", context }, options());
    expect(refs.hits.map(h => h.note.path)).toEqual(related.hits.map(h => h.note.path));
    const matches = await knowledgeReferences(vault, { source_id: id, query: "backlink" }, options());
    expect(matches.hits.length).toBeGreaterThan(0);
    expect(matches.hits[0]!.snippet).toContain("backlink");
    expect(matches.hits[0]!.note.title).not.toContain("backlink");
    expect(refs.hits.every(h => h.note.type !== "asset" && h.note.id !== id)).toBe(true);
});
test("an audit failure is recoverable, blocks competing requests and commits exactly once", async () => {
    const request = await input();
    await expect(store.update("human", id, request, { ...hooks(), audit() { throw new Error("audit unavailable"); } })).rejects.toThrow("audit unavailable");
    const latest = await readKnowledgeDocument(vault, id, options());
    await expect(store.update("human", id, { ...request, request_id: "other-request-0001", expected_revision: latest.revision, body: "next" }, hooks())).rejects.toMatchObject({ code: "SAVE_UNCERTAIN" });
    await store.update("human", id, request, hooks());
    expect(audits).toBe(1);
    expect((await store.update("human", id, { ...request, request_id: "other-request-0001", expected_revision: latest.revision, body: "next" }, hooks())).document.body).toBe("next");
});
test("deletion during interrupted save releases reservation without resurrecting the file", async () => {
    const request = await input();
    await expect(store.update("human", id, request, { ...hooks(), async finalize() { throw new Error("crash"); } })).rejects.toThrow("crash");
    const path = join(vault, "research/ideas/Main.md");
    await unlink(path);
    await expect(store.update("human", id, request, hooks())).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await Bun.file(path).exists()).toBe(false);
    expect(db.query<{
        n: number;
    }, [
    ]>("SELECT count(*) AS n FROM knowledge_edits WHERE ready=0").get()!.n).toBe(0);
});
test("no-op save does not publish or finalize another Git commit", async () => {
    const doc = await readKnowledgeDocument(vault, id, options());
    let finalized = false;
    const result = await store.update("human", id, { request_id: "no-op-request-0001", expected_revision: doc.revision, title: doc.document.note.title, body: doc.document.body }, { ...hooks(), async finalize() { finalized = true; }, async beforeWrite() { throw new Error("must not write"); } });
    expect(result.revision).toBe(doc.revision);
    expect(finalized).toBe(false);
    expect(audits).toBe(1);
});

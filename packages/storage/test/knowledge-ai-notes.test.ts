import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiNote, KnowledgeAiNoteResult, KnowledgeGraph } from "@lumio/schema";
import { parseFrontmatter, type FillContext } from "@lumio/knowledge";
import {
  collectCitations, countKnowledgeReferences, knowledgeGraph, knowledgeReferences, KnowledgeCreationStore,
  KnowledgeEditingStore, noteLinks, readKnowledgeDocument, searchNotes, syncFile, updateIndex,
} from "../src/index.ts";

const actor = "act_00000000000000000000000001";
const message = "amsg_00000000000000000000000001";
const job = "job_00000000000000000000000001";
const noReference = "job_00000000000000000000000002";
const digest = "ain_00000000000000000000000001";
const digestPath = "ai/notes/Digest.md";
const anchorPath = "research/ideas/Anchor.md";
const now = new Date("2026-11-10T12:00:00Z");
const ctx: FillContext = { now, tz: "UTC", newId: prefix => prefix + "_00000000000000000000000002" };
const revision = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let root: string, vault: string, options: { stateDir: string };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lumio-k4-index-"));
  vault = join(root, "vault");
  options = { stateDir: join(root, "state") };
  await cp(new URL("../../../fixtures/query-vault", import.meta.url), vault, { recursive: true });
  await cp(new URL("../../../fixtures/k4-ai-notes", import.meta.url), vault, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

test("AI notes are completed, searchable, editable and visible to the link picker", async () => {
  const path = "ai/notes/Incomplete.md";
  await writeFile(join(vault, path), "New synthetic AI note");
  expect(await syncFile(vault, path, { context: ctx })).toMatchObject({ filled: true, problem: false });
  expect(AiNote.parse(parseFrontmatter(await readFile(join(vault, path))).data)).toMatchObject({
    id: ctx.newId("ain"), type: "ai-note", title: "Incomplete",
  });
  expect((await searchNotes(vault, "synthetic AI digest", options)).hits[0]?.note.type).toBe("ai-note");
  expect((await readKnowledgeDocument(vault, digest, options)).document.note.path).toBe(digestPath);
  const hits = await knowledgeReferences(vault, { source_kind: "idea", query: "synthetic AI digest" }, options);
  expect(hits.hits[0]?.note).toMatchObject({ type: "ai-note", path: digestPath });
});

test("the human graph keeps incoming AI-note edges and excludes its outgoing links and citations", async () => {
  const links = await noteLinks(vault, digest, options);
  expect(links.outgoing).toEqual([]);
  expect(links.incoming).toHaveLength(1);
  expect(links.incoming[0]?.note?.path).toBe(anchorPath);
  expect(links.ai_incoming).toBeUndefined();
  // ADR 0053：AI 笔记的出链单独列出，被链接的笔记能看到"AI 笔记提到"。
  expect(links.ai_outgoing?.map(link => [link.target, link.dangling])).toEqual([
    ["Alpha_2024_Paper", false], ["../../research/ideas/Anchor.md", false], ["Missing.md", true],
  ]);
  const anchor = await noteLinks(vault, anchorPath, options);
  expect(anchor.incoming.some(link => link.note.path === digestPath)).toBe(false);
  expect(anchor.ai_incoming?.map(link => link.note.path)).toEqual([digestPath]);
  expect(anchor.ai_outgoing).toBeUndefined();
  const graph = KnowledgeGraph.parse(await knowledgeGraph(vault, options));
  expect(graph.nodes).toContainEqual(links.note);
  expect(graph.edges).toContainEqual({ from: anchorPath, to: digestPath, count: 1 });
  expect(graph.edges.some(edge => edge.from === digestPath)).toBe(false);
  expect(await collectCitations(vault, digest, options)).toEqual({ papers: [], warnings: [] });
});

test("both reference tables rebuild and track replacement/removal without leaking private notes", async () => {
  await updateIndex(vault, options);
  const db = new Database(join(options.stateDir, "index.sqlite"));
  db.exec("DROP TABLE derived_from; DROP TABLE resource_links; UPDATE metadata SET version=3");
  db.close();
  expect(await countKnowledgeReferences(vault, [message, job], options)).toBe(2);
  expect(await countKnowledgeReferences(vault, [message], { ...options, includePrivate: true })).toBe(3);
  expect(await countKnowledgeReferences(vault, ["https://example.com/source"], options)).toBe(1);
  expect(await countKnowledgeReferences(vault, [noReference], options)).toBe(0);

  await writeFile(join(vault, anchorPath), "A new version without sources or cross-module links");
  expect(await countKnowledgeReferences(vault, [job], options)).toBe(0);
  expect(await countKnowledgeReferences(vault, [message], options)).toBe(1);
  await rm(join(vault, digestPath));
  expect(await countKnowledgeReferences(vault, [message], options)).toBe(0);
  expect((await noteLinks(vault, "Alpha_2024_Paper", options)).ai_incoming).toBeUndefined();
  expect(await countKnowledgeReferences(vault, [message], { ...options, includePrivate: true })).toBe(1);
});

test("AI creation reuses its published receipt and returns the exact file revision", async () => {
  using db = new Database(":memory:");
  const store = new KnowledgeCreationStore(db, vault);
  const args = { title: "New synthetic note", body: "---\nMarkdown", derived_from: ["https://example.com/source"] };
  let failFinalize = true, audits = 0;
  const hooks = {
    validate() {},
    async finalize() { if (failFinalize) throw new Error("interrupted"); },
    audit() { audits++; },
  };
  const create = () => store.createAiNote(actor, "synthetic-create-01", args, ctx, hooks, job);
  await expect(create()).rejects.toMatchObject({ code: "NOTE_SAVE_UNCERTAIN" });
  failFinalize = false;
  const result = KnowledgeAiNoteResult.parse(await create());
  expect(await create()).toEqual(result);
  expect(audits).toBe(1);
  expect(result.note.path).toBe("ai/notes/New synthetic note " + ctx.newId("ain") + ".md");
  const bytes = await readFile(join(vault, result.note.path));
  expect(result.revision).toBe(revision(bytes));
  const parsed = parseFrontmatter(bytes);
  expect(AiNote.parse(parsed.data)).toMatchObject({ generated_by: actor, derived_from: ["https://example.com/source", job] });
  expect(parsed.body.toString()).toBe(args.body);
});

test("AI update preserves provenance and custom fields, checks sources, and conflicts after human edits", async () => {
  using db = new Database(":memory:");
  const store = new KnowledgeEditingStore(db, vault, options);
  const doc = await readKnowledgeDocument(vault, digest, options);
  const hooks = { now, validate() {}, async finalize() {}, audit() {} };
  const update = { note: digest, expected_revision: doc.revision, tags: ["synthetic"] };
  await expect(store.updateAiNote(actor, "synthetic-update-01", update, {
    ...hooks,
    async validateSources() { throw new Error("cannot read source"); },
  }, job)).rejects.toThrow("cannot read source");
  expect((await readKnowledgeDocument(vault, digest, options)).revision).toBe(doc.revision);

  const result = KnowledgeAiNoteResult.parse(await store.updateAiNote(actor, "synthetic-update-01", update, {
    ...hooks,
    async validateSources(sources) { expect(sources).toEqual([message, "https://example.com/source", job]); },
  }, job));
  const updated = await readKnowledgeDocument(vault, digest, options);
  expect(updated.revision).toBe(result.revision);
  expect(updated.document.frontmatter).toMatchObject({
    tags: ["synthetic"], generated_by: actor, model: "synthetic-model", custom: { retain: true },
    derived_from: [message, "https://example.com/source", job],
  });
  await store.update(actor, digest, { request_id: "synthetic-human-edit", title: "Human edit", body: updated.document.body, expected_revision: result.revision }, hooks);
  await expect(store.updateAiNote(actor, "synthetic-update-02", { ...update, expected_revision: result.revision }, hooks, job)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
});

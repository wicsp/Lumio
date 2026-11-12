import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchResult, KnowledgeRelatedResult, KnowledgeReferencesResult, KnowledgeGraph } from "@lumio/schema";
import { knowledgeGraph, knowledgeReferences, relatedKnowledge, noteById, noteLinks, searchNotes, showNote } from "../src/index.ts";
import { embeddedLinks } from "../src/knowledge/index/hosts.ts";

const paper = "pap_00000000000000000000000001", ai = "ain_00000000000000000000000001";
const paperPath = "library/papers/Alpha_2024_Paper.md", aiPath = "ai/notes/Digest.md";
let root: string, vault: string, options: { stateDir: string }, host: string, card: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lumio-i2-hosts-"));
  vault = join(root, "vault"); options = { stateDir: join(root, "state") };
  await cp(new URL("../../../fixtures/query-vault", import.meta.url), vault, { recursive: true });
  await cp(new URL("../../../fixtures/k4-ai-notes", import.meta.url), vault, { recursive: true });
  host = (await readFile(join(vault, paperPath), "utf8")) + "\n[[Digest]]\n\nsharedneedle\n";
  card = (await readFile(join(vault, aiPath), "utf8")).replace("derived_from:", `derived_from:\n  - ${paper}`) + "\nquasarneedle sharedneedle 稀有\n";
  await writeFile(join(vault, paperPath), host);
  await writeFile(join(vault, aiPath), card);
});
afterEach(() => rm(root, { recursive: true, force: true }));

test("hosted cards merge before type filtering, limits and totals; direct reads and links survive", async () => {
  const all = SearchResult.parse(await searchNotes(vault, "", options));
  expect(all.hits.some(h => h.note.id === ai)).toBe(false);
  for (const query of ["quasarneedle", "sharedneedle", "稀有"]) {
    const result = SearchResult.parse(await searchNotes(vault, query, { ...options, type: "paper", limit: 1 }));
    expect(result.total).toBe(1);
    expect(result.hits[0]).toMatchObject({ note: { id: paper }, matched_in: "body" });
    expect(result.hits[0]!.snippet).toContain(query);
    expect((await searchNotes(vault, query, { ...options, type: "ai-note" })).total).toBe(0);
  }
  expect((await showNote(vault, ai, options)).note.id).toBe(ai);
  expect((await noteById(vault, ai, options))?.id).toBe(ai);
  expect((await noteLinks(vault, paper, options)).outgoing.some(e => e.note?.id === ai)).toBe(true);
  const graph = KnowledgeGraph.parse(await knowledgeGraph(vault, options));
  expect(graph.nodes.some(n => n.id === ai)).toBe(false);
  expect(graph.edges.some(e => e.to === aiPath || e.from === aiPath)).toBe(false);
});

test("recommendations and both reference queries collapse cards and exclude the current host", async () => {
  const context = { title: "", text: "", focus: "quasarneedle" };
  const related = KnowledgeRelatedResult.parse(await relatedKnowledge(vault, context, options));
  expect(related.hits.map(h => h.note.id)).toEqual([paper]);
  for (const query of ["quasarneedle", ""]) {
    const result = KnowledgeReferencesResult.parse(await knowledgeReferences(vault, { source_kind: "idea", query, context }, options));
    expect(result.hits.map(h => h.note.id)).toEqual([paper]);
    expect(result.hits[0]!.snippet).toContain("quasarneedle");
    expect((await knowledgeReferences(vault, { source_id: paper, query, context }, options)).hits).toEqual([]);
  }
  expect((await relatedKnowledge(vault, { ...context, exclude_id: paper }, options)).hits).toEqual([]);
});

test("removing either proof or adding a second host restores the independent card", async () => {
  const visible = async () => (await searchNotes(vault, "quasarneedle", options)).hits.map(h => h.note.id);
  expect(await visible()).toEqual([paper]);
  await writeFile(join(vault, paperPath), host.replace("[[Digest]]", "no embed"));
  expect(await visible()).toEqual([ai]);
  await writeFile(join(vault, paperPath), host.replace("[[Digest]]", "[card](../../ai/notes/Digest.md)"));
  expect(await visible()).toEqual([paper]);
  await writeFile(join(vault, aiPath), card.replace(`  - ${paper}\n`, ""));
  expect(await visible()).toEqual([ai]);
  const second = "pap_00000000000000000000000099";
  await writeFile(join(vault, aiPath), card.replace("derived_from:", `derived_from:\n  - ${second}`));
  const secondPath = join(vault, "library/papers/Second.md");
  await writeFile(secondPath, host.replaceAll(paper, second).replaceAll("Alpha_2024_Paper", "Second"));
  expect(await visible()).toEqual([ai]);
  await rm(secondPath);
  expect(await visible()).toEqual([paper]);
  await rm(join(vault, paperPath));
  expect(await visible()).toEqual([ai]);
});

test("only standalone links outside code and legacy AI blocks establish ownership", () => {
  for (const body of ["inline [[Digest]]", "[[Digest]]\nmore prose", "- [[Digest]]", "    [[Digest]]", "\n    [[Digest]]\n", "```\n[[Digest]]\n```", "~~~\n[[Digest]]\n~~~", "`[[Digest]]`", "<!-- lumio:ai start -->\n\n[[Digest]]\n\n<!-- lumio:ai end -->", "[card](Digest.md) [web](https://example.com)"]) {
    expect(embeddedLinks(body, paperPath)).toEqual([]);
  }
  expect(embeddedLinks("[[Digest|Card]]", paperPath)).toHaveLength(1);
  expect(embeddedLinks('[card](../../ai/notes/Digest.md "Card")', paperPath)).toHaveLength(1);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeGraph } from "@lumio/schema";
import { knowledgeGraph, noteLinks, showNote, updateIndex } from "../src/index.ts";
let root: string, vault: string, stateDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lumio-k3-index-")); vault = join(root, "vault"); stateDir = join(root, "state");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url), vault, { recursive: true });
  await cp(new URL("../../../fixtures/knowledge-graph", import.meta.url), vault, { recursive: true });
  await updateIndex(vault, { stateDir });
});
afterEach(async () => rm(root, { recursive: true, force: true }));
test("indexed graph matches per-note public links, merges duplicates and includes ID-less islands", async () => {
  const graph = KnowledgeGraph.parse(await knowledgeGraph(vault, { stateDir }));
  const shown = new Set(graph.nodes.map(n => n.path));
  expect(graph.nodes.some(n => n.path.endsWith("GraphIsland.md") && !n.id)).toBe(true);
  expect(graph.nodes.every(n => !["task", "project", "routine", "asset"].includes(n.type) && !n.path.includes(".trash/"))).toBe(true);
  const expected = new Map<string, number>();
  for (const note of graph.nodes) {
    const links = await noteLinks(vault, note.path, { stateDir });
    for (const link of links.outgoing) if (link.note && shown.has(link.note.path) && note.path !== link.note.path) {
      const key = JSON.stringify([note.path, link.note.path]); expected.set(key, (expected.get(key) ?? 0) + 1);
    }
  }
  expect(new Map(graph.edges.map(e => [JSON.stringify([e.from, e.to]), e.count]))).toEqual(expected);
  expect(graph.edges.find(e => e.from.endsWith("GraphHub.md") && e.to.endsWith("Alpha_2024_Paper.md"))?.count).toBe(2);
  const db = new Database(join(stateDir, "index.sqlite"), { readonly: true });
  try {
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM links WHERE target IN ('GraphAIOnly','GraphCodeOnly')").get()!.n).toBe(0);
  } finally { db.close(); }
  expect((await showNote(vault, "research/ideas/GraphIsland.md", { stateDir })).note.id).toBeUndefined();
});
test("private and type filters affect both endpoints; legacy is opt-in; dangling counts real unresolved links", async () => {
  const publicGraph = await knowledgeGraph(vault, { stateDir }), all = await knowledgeGraph(vault, { stateDir, includePrivate: true, includeLegacy: true });
  expect(all.nodes.some(n => n.type === "asset")).toBe(true); expect(all.nodes.some(n => n.type === "task")).toBe(true);
  expect(publicGraph.nodes.some(n => n.type === "asset")).toBe(false);
  const privatePaths = new Set(all.nodes.filter(n => n.type === "asset").map(n => n.path));
  expect(publicGraph.edges.some(e => privatePaths.has(e.from) || privatePaths.has(e.to))).toBe(false);
  const ideas = await knowledgeGraph(vault, { stateDir, type: "idea" });
  const ids = new Set(ideas.nodes.map(n => n.path));
  expect(ideas.nodes.every(n => n.type === "idea")).toBe(true);
  expect(ideas.edges.every(e => ids.has(e.from) && ids.has(e.to))).toBe(true);
  expect(ideas.edges.some(e => e.from.endsWith("GraphHub.md") && e.to.endsWith("GraphLeaf.md"))).toBe(true);
  expect(ideas.dangling).toBeGreaterThan(0);
  expect((await knowledgeGraph(vault, { stateDir, type: "task" })).nodes).toEqual([]);
});
test("graph reads only the existing snapshot and preserves its generation time even without readable vault files", async () => {
  const first = await knowledgeGraph(vault, { stateDir });
  const moved = vault + "-offline"; await rename(vault, moved);
  expect(await knowledgeGraph(vault, { stateDir, parse: () => { throw Error("must not parse"); } })).toEqual(first);
  await rename(moved, vault);
  await writeFile(join(vault, "research/ideas/GraphIsland.md"), "---\ntype: idea\ntitle: Updated synthetic island\n---\n[[GraphHub]]\n");
  expect(await knowledgeGraph(vault, { stateDir })).toEqual(first);
  await updateIndex(vault, { stateDir });
  const next = await knowledgeGraph(vault, { stateDir });
  expect(next.nodes.some(n => n.title === "Updated synthetic island")).toBe(true);
  expect(Date.parse(next.generated_at)).toBeGreaterThanOrEqual(Date.parse(first.generated_at));
});
test("existing indexes gain timestamp metadata without rebuilding unchanged notes", async () => {
  const db = new Database(join(stateDir, "index.sqlite"));
  db.exec("ALTER TABLE metadata DROP COLUMN updated_at"); db.close();
  await updateIndex(vault, { stateDir, parse: () => { throw Error("unchanged note should not be reparsed"); } });
  expect(Number.isFinite(Date.parse((await knowledgeGraph(vault, { stateDir })).generated_at))).toBe(true);
});

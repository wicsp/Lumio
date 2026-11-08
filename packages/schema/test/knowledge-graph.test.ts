import { expect, test } from "bun:test";
import { KnowledgeGraph, KnowledgeGraphArgs, CAPABILITIES, CONTRACTS } from "../src/index.ts";
const a = { type: "idea" as const, path: "research/ideas/A.md", title: "Synthetic A" };
const b = { type: "paper" as const, path: "library/papers/B.md", title: "Synthetic B" };
const graph = { nodes: [a, b], edges: [{ from: a.path, to: b.path, count: 2 }], dangling: 1, generated_at: "2026-11-08T00:00:00Z" };
test("global graph is a strict human-only contract, independent of the agent catalog", () => {
  expect(KnowledgeGraph.parse(graph)).toEqual(graph);
  expect(KnowledgeGraph.parse({ ...graph, edges: [] }).nodes).toHaveLength(2);
  expect(CONTRACTS["knowledge-graph"]).toBe(KnowledgeGraph);
  expect(CAPABILITIES.some(c => c.name === ("knowledge.graph" as string))).toBe(false);
  expect(KnowledgeGraphArgs.parse({ include_private: true, include_legacy: false, type: "idea" })).toEqual({ include_private: true, include_legacy: false, type: "idea" });
  for (const value of [{ unknown: true }, { include_private: "true" }, { include_legacy: 1 }, { type: "unknown" }]) expect(KnowledgeGraphArgs.safeParse(value).success).toBe(false);
});
test("graph endpoints exist, pairs are unique, paths are unique and counts are positive", () => {
  for (const edges of [
    [{ from: a.path, to: "missing", count: 1 }], [{ from: a.path, to: a.path, count: 1 }], [...graph.edges, ...graph.edges],
    [{ from: a.path, to: b.path, count: 0 }], [{ from: a.path, to: b.path, count: 1.5 }],
  ]) expect(KnowledgeGraph.safeParse({ ...graph, edges }).success).toBe(false);
  expect(KnowledgeGraph.safeParse({ ...graph, nodes: [a, a] }).success).toBe(false);
  expect(KnowledgeGraph.safeParse({ ...graph, extra: 1 }).success).toBe(false);
});

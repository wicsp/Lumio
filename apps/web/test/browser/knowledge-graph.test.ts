import { expect, test } from "bun:test";
import { KnowledgeGraph } from "@lumio/schema";
import { knowledgeGraphData } from "../../src/client/graph/data.ts";
import { forceLayout, forceLayoutAsync } from "../../src/client/graph/layout.ts";
import { KnowledgeGraphView } from "../../src/client/graph/knowledge.ts";
const note = (n: number) => ({ path: `research/ideas/${String(n).padStart(3, "0")}.md`, type: "idea" as const, title: `Synthetic ${n}` });
const nodes = Array.from({ length: 350 }, (_, i) => note(i));
const graph = KnowledgeGraph.parse({ nodes, edges: [{ from: nodes[349]!.path, to: nodes[348]!.path, count: 20 }, { from: nodes[348]!.path, to: nodes[0]!.path, count: 2 }], dangling: 0, generated_at: "2026-11-08T00:00:00Z" });
test("global graph keeps weighted hubs first, caps to 300 nodes and drops clipped edges", () => {
  const result = knowledgeGraphData(graph);
  expect(result.nodes).toHaveLength(300); expect(result.total).toBe(350); expect(result.truncated).toBe(true);
  expect(result.nodes[0]).toMatchObject({ id: nodes[348]!.path, weight: 22 });
  expect(result.nodes[1]).toMatchObject({ id: nodes[349]!.path, weight: 20 });
  const known = new Set(result.nodes.map(n => n.id)); expect(result.edges.every(([a, b]) => known.has(a) && known.has(b))).toBe(true);
  const connected = knowledgeGraphData(graph, true); expect(connected.nodes).toHaveLength(3); expect(connected.truncated).toBe(false);
  expect(knowledgeGraphData({ ...graph, edges: [] }, true).nodes).toEqual([]);
});
test("batched layout matches synchronous layout, yields and discards outdated work", async () => {
  const ids = nodes.slice(0, 12).map(n => n.path), edges = [[ids[0]!, ids[1]!] as const]; let yields = 0;
  const options = { width: 960, height: 620, iterations: 20 };
  const batched = await forceLayoutAsync(ids, edges, { ...options, yieldFrame: async () => { yields++; } });
  expect(batched).toEqual(forceLayout(ids, edges, options)); expect(yields).toBeGreaterThan(1);
  let current = true;
  expect(await forceLayoutAsync(ids, edges, { ...options, isCurrent: () => current, yieldFrame: async () => { current = false; } })).toBeUndefined();
  expect(await forceLayoutAsync([], [], options)).toEqual(new Map());
  expect(await forceLayoutAsync(ids, edges, options)).toEqual(forceLayout(ids, edges, options));
});

test("unchanged background refresh preserves an ongoing layout; leaving cancels both request and layout", async () => {
  const state = { args: {}, source: graph, generation: 41, requestGeneration: 0, active: true,
    client: { knowledgeGraph: async () => structuredClone(graph) },
    draw: async () => { throw Error("unchanged graph must keep its existing layout"); } };
  const view = Object.assign(Object.create(KnowledgeGraphView.prototype) as object, state) as unknown as KnowledgeGraphView;
  await view.load({}, true); await view.load({}, true);
  expect((view as unknown as typeof state).generation).toBe(41);
  view.cancel();
  expect((view as unknown as typeof state).generation).toBe(42);
  expect((view as unknown as typeof state).requestGeneration).toBe(3);
});

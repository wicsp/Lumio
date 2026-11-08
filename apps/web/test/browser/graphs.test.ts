import { describe, expect, test } from "bun:test";
import type { LinksResult, NoteRef, WorkTask } from "@lumio/schema";
import { forceLayout, layeredLayout } from "../../src/client/graph/layout.ts";
import { noteGraph, taskGraph } from "../../src/client/graph/data.ts";
import { fitLabel } from "../../src/client/graph/view.ts";

const at = "2026-11-08T00:00:00Z";
const PRJ = "prj_01JABCDEFGHJKMNPQRSTVWXYZ0", OTHER = "prj_01JABCDEFGHJKMNPQRSTVWXYZ1";
const id = (n: number) => `task_01JABCDEFGHJKMNPQRSTVWXY${String(n).padStart(2, "0")}`;
const task = (n: number, extra: Partial<WorkTask> = {}): WorkTask => ({
  schema_version: 3, type: "task", id: id(n), title: `T${n}`, description: "", revision: 1, outcome: "open", project: PRJ,
  turn: { holder: "human", reason: "todo", since: at }, created: at, updated: at, tags: [], dependencies: [], references: [], ...extra,
});
const closed = { holder: "nobody", reason: "on_hold", since: at } as const;

describe("layered layout", () => {
  test("each node sits right of every prerequisite (longest path)", () => {
    const { position, layers } = layeredLayout(["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["a", "c"], ["a", "d"]]);
    expect(position.get("a")!.layer).toBe(0);
    expect(position.get("b")!.layer).toBe(1);
    expect(position.get("c")!.layer).toBe(2);
    expect(position.get("d")!.layer).toBe(1);
    expect(layers.flat().sort()).toEqual(["a", "b", "c", "d"]);
  });
  test("ignores unknown nodes and self-loops, and terminates on a cycle", () => {
    const { position } = layeredLayout(["a", "b"], [["a", "a"], ["x", "a"], ["a", "b"], ["b", "a"]]);
    expect(position.size).toBe(2);
    expect(Math.max(...[...position.values()].map(p => p.layer))).toBeLessThan(2);
  });
  test("barycenter ordering untangles a simple crossing", () => {
    // a1→b2, a2→b1: after sweeps, b's order should follow a's order.
    const { position } = layeredLayout(["a1", "a2", "b1", "b2"], [["a1", "b2"], ["a2", "b1"]]);
    expect(position.get("b2")!.order).toBeLessThan(position.get("b1")!.order);
  });
});

describe("force layout", () => {
  test("is deterministic, keeps the center node centred and every node inside the canvas", () => {
    const nodes = ["c", ...Array.from({ length: 12 }, (_, i) => `n${i}`)];
    const edges = nodes.slice(1).map(n => ["c", n] as const);
    const a = forceLayout(nodes, edges, { width: 600, height: 400, center: "c", iterations: 120 });
    const b = forceLayout(nodes, edges, { width: 600, height: 400, center: "c", iterations: 120 });
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(a.get("c")).toEqual({ x: 300, y: 200 });
    for (const p of a.values()) { expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(600); expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(400); }
    // Distinct positions: nodes do not collapse onto one point.
    expect(new Set([...a.values()].map(p => `${Math.round(p.x)},${Math.round(p.y)}`)).size).toBe(nodes.length);
  });
});

describe("task graph data", () => {
  test("draws open project tasks and open outside prerequisites; done prerequisites and finished tasks are left out", () => {
    const tasks = [
      task(1),
      task(2, { dependencies: [id(1), id(5), id(6)], blocked_by: [id(1), id(5)] }),
      task(3, { outcome: "done", turn: closed, dependencies: [id(1)] }),
    ];
    const all = [...tasks, task(5, { project: OTHER, title: "Outside" }), task(6, { project: OTHER, outcome: "done", turn: closed })];
    const graph = taskGraph(tasks, all, value => ({ state: value.blocked_by?.length ? "blocked" : "todo" }));
    expect(graph.nodes.map(n => [n.id, n.external, n.ready])).toEqual([[id(1), false, true], [id(2), false, false], [id(5), true, false]]);
    expect(graph.edges).toEqual([[id(1), id(2)], [id(5), id(2)]]);
  });
});

describe("note graph data", () => {
  const ref = (n: string, type: NoteRef["type"] = "idea"): NoteRef => ({ id: `ide_01JABCDEFGHJKMNPQRSTVWXY${n}`, type, title: `N${n}`, path: `ideas/${n}.md` });
  const out = (note: NoteRef) => ({ source: "wikilink" as const, note, target: note.title, dangling: false });
  const graph: Record<string, LinksResult> = {};
  const A = ref("0A"), B = ref("0B", "paper"), C = ref("0C"), D = ref("0D");
  graph[A.id!] = { note: A, outgoing: [out(B), { source: "wikilink", target: "Missing", dangling: true }], incoming: [{ ...out(C), note: C }] };
  graph[B.id!] = { note: B, outgoing: [out(D)], incoming: [{ ...out(A), note: A }] };
  graph[C.id!] = { note: C, outgoing: [out(A)], incoming: [] };
  graph[D.id!] = { note: D, outgoing: [], incoming: [{ ...out(B), note: B }] };
  const links = async (reference: string) => { const value = graph[reference]; if (!value) throw new Error("missing"); return value; };

  test("depth 1 has the center and its direct neighbours; dangling links are skipped", async () => {
    const result = await noteGraph(A.id!, 1, links);
    expect(result.nodes.map(n => [n.label, n.center ?? false])).toEqual([["N0A", true], ["N0B", false], ["N0C", false]]);
    expect(result.edges).toEqual([[A.id!, B.id!], [C.id!, A.id!]]);
  });
  test("depth 2 expands neighbours without duplicating edges, and respects the node cap", async () => {
    const result = await noteGraph(A.id!, 2, links);
    expect(result.nodes.find(n => n.label === "N0D")?.distance).toBe(2);
    expect(result.edges.length).toBe(new Set(result.edges.map(e => e.join(">"))).size);
    expect(result.edges).toContainEqual([B.id!, D.id!]);
    const capped = await noteGraph(A.id!, 2, links, { maxNodes: 3 });
    expect(capped.nodes.length).toBe(3);
    expect(capped.truncated).toBe(true);
  });
});

test("labels are shortened by visual width, counting CJK as full width", () => {
  expect(fitLabel("short", 100)).toBe("short");
  expect(fitLabel("一二三四五六七八九十", 60, 12)).toBe("一二三四五…");
  expect(fitLabel("a".repeat(100), 70, 12).endsWith("…")).toBe(true);
});

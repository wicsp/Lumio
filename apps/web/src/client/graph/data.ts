/**
 * 图的数据：把任务或笔记链接整理成节点与边。只读现有接口（任务列表、单篇笔记的链接），不新增契约。
 */
import type { KnowledgeGraph, LinksResult, NoteRef, WorkTask } from "@lumio/schema";
import type { Edge } from "./layout.ts";
import type { DagNode, NetNode } from "./view.ts";

/** 依赖图最多画这么多个节点；再多就该看列表了。 */
export const MAX_TASK_NODES = 50;

/**
 * 项目依赖图：项目里未完成的任务，加上它们还没完成的项目外前置（标为外部）。
 * 已完成的前置不再阻塞，不画；边 from → to 表示 to 等 from。
 */
export function taskGraph(projectTasks: readonly WorkTask[], allTasks: readonly WorkTask[], describe: (task: WorkTask) => { state: string; sub?: string }): { nodes: DagNode[]; edges: Edge[] } {
  const open = projectTasks.filter(task => task.outcome === "open");
  const inProject = new Set(open.map(task => task.id));
  const byId = new Map(allTasks.map(task => [task.id, task]));
  const external = new Map<string, WorkTask>();
  for (const task of open) for (const id of task.dependencies) {
    const other = byId.get(id);
    if (other && other.outcome === "open" && !inProject.has(id)) external.set(id, other);
  }
  const node = (task: WorkTask, isExternal: boolean): DagNode => {
    const { state, sub } = describe(task);
    return { id: task.id, label: task.title, state, sub, external: isExternal,
      ready: !isExternal && task.outcome === "open" && !(task.blocked_by?.length) };
  };
  const nodes = [...open.map(task => node(task, false)), ...[...external.values()].map(task => node(task, true))];
  const shown = new Set(nodes.map(n => n.id));
  const edges: Edge[] = [];
  for (const task of open) for (const id of task.dependencies) if (shown.has(id)) edges.push([id, task.id]);
  return { nodes, edges };
}

const key = (note: NoteRef) => note.id ?? note.path;

/**
 * 笔记关系图：从一篇笔记出发，沿出链与反链走 depth 层（1 或 2）。
 * 第二层最多展开 expandLimit 个邻居、总节点不超过 maxNodes；悬空链接不画。读取失败的邻居只是不展开。
 */
export async function noteGraph(start: string, depth: 1 | 2, links: (reference: string) => Promise<LinksResult>,
  options: { expandLimit?: number; maxNodes?: number; concurrency?: number } = {}): Promise<{ nodes: NetNode[]; edges: Edge[]; truncated: boolean }> {
  const expandLimit = options.expandLimit ?? 24, maxNodes = options.maxNodes ?? 80, concurrency = options.concurrency ?? 6;
  const nodes = new Map<string, NetNode>(), edges = new Map<string, Edge>();
  let truncated = false;
  const add = (note: NoteRef, distance: number): boolean => {
    const id = key(note);
    if (nodes.has(id)) return true;
    if (nodes.size >= maxNodes) { truncated = true; return false; }
    nodes.set(id, { id, label: note.title, kind: note.type, distance });
    return true;
  };
  const absorb = (result: LinksResult, distance: number): string[] => {
    const self = key(result.note), found: string[] = [];
    for (const link of result.outgoing) if (link.note && !link.dangling && add(link.note, distance)) { edges.set(`${self}>${key(link.note)}`, [self, key(link.note)]); found.push(key(link.note)); }
    for (const link of result.incoming) if (add(link.note, distance)) { edges.set(`${key(link.note)}>${self}`, [key(link.note), self]); found.push(key(link.note)); }
    return found;
  };
  const first = await links(start);
  nodes.set(key(first.note), { id: key(first.note), label: first.note.title, kind: first.note.type, center: true, distance: 0 });
  const neighbours = [...new Set(absorb(first, 1))].filter(id => id !== key(first.note));
  if (depth === 2) {
    const queue = neighbours.slice(0, expandLimit);
    if (neighbours.length > expandLimit) truncated = true;
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const id = queue[next++]!;
        try { absorb(await links(id), 2); } catch { /* A note that cannot be read is simply not expanded. */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()].filter(([a, b]) => a !== b), truncated };
}

export const MAX_KNOWLEDGE_NODES = 300;
/** Rank before clipping, so hubs win over islands; edge counts also determine node size. */
export function knowledgeGraphData(graph: KnowledgeGraph, hideIsolated = false, limit = MAX_KNOWLEDGE_NODES): { nodes: NetNode[]; edges: Edge[]; total: number; truncated: boolean } {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + edge.count);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + edge.count);
  }
  const candidates = graph.nodes.filter(note => !hideIsolated || (degree.get(note.path) ?? 0) > 0)
    .sort((a, b) => (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0) || a.path.localeCompare(b.path));
  const nodes = candidates.slice(0, limit).map(note => ({ id: note.path, label: note.title, kind: note.type, weight: degree.get(note.path) ?? 0 }));
  const shown = new Set(nodes.map(note => note.id));
  return { nodes, edges: graph.edges.filter(edge => shown.has(edge.from) && shown.has(edge.to)).map(edge => [edge.from, edge.to]),
    total: candidates.length, truncated: candidates.length > limit };
}

/**
 * 任务结构（ADR 0039，T1-4）：前置、父任务、标签与子任务的界面规则。
 * 被阻塞是 Hub 推导的事实（blocked_by）；这里只负责展示与挑选候选，成环等校验以 Hub 为准。
 */
import type { WorkTask } from "@lumio/schema";

export type PrerequisiteState = "open" | "done" | "cancelled" | "deleted";

/** 前置任务的状态；列表里找不到（在回收站或已彻底删除）即为已删除。 */
export function prerequisiteState(id: string, byId: ReadonlyMap<string, WorkTask>): PrerequisiteState {
  return byId.get(id)?.outcome ?? "deleted";
}

/** 还在阻塞这个任务的前置标题（悬停说明用）；标题未知时用 ID。 */
export function blockingTitles(task: WorkTask, byId: ReadonlyMap<string, WorkTask>): string[] {
  return (task.blocked_by ?? []).map(id => byId.get(id)?.title ?? id);
}

/** 所有任务里出现过的标签，按字母排序去重。 */
export function allTags(tasks: readonly WorkTask[]): string[] {
  return [...new Set(tasks.flatMap(task => task.tags))].sort((a, b) => a.localeCompare(b));
}

/** 直接或间接依赖 `id` 的任务（把它们设为 `id` 的前置会成环）。 */
function dependentsClosure(id: string, tasks: readonly WorkTask[]): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const task of tasks) for (const dep of task.dependencies) reverse.set(dep, [...(reverse.get(dep) ?? []), task.id]);
  const seen = new Set<string>(), stack = [id];
  while (stack.length) for (const next of reverse.get(stack.pop()!) ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
  return seen;
}

/** 可以加为前置的同项目任务（无项目只匹配无项目）：排除自己、已有前置和会成环的任务；未完成的排前面。 */
export function prerequisiteCandidates(task: WorkTask, tasks: readonly WorkTask[]): WorkTask[] {
  const blocked = dependentsClosure(task.id, tasks);
  return tasks.filter(other => other.project === task.project && other.id !== task.id && !task.dependencies.includes(other.id) && !blocked.has(other.id) && other.outcome !== "cancelled")
    .sort((a, b) => Number(a.outcome !== "open") - Number(b.outcome !== "open") || a.title.localeCompare(b.title));
}

/** 可以作为父任务的任务：排除自己与自己的各级子任务；已取消的不列出。 */
export function parentCandidates(task: WorkTask, tasks: readonly WorkTask[]): WorkTask[] {
  const children = new Map<string, string[]>();
  for (const other of tasks) if (other.parent) children.set(other.parent, [...(children.get(other.parent) ?? []), other.id]);
  const below = new Set<string>(), stack = [task.id];
  while (stack.length) for (const next of children.get(stack.pop()!) ?? []) if (!below.has(next)) { below.add(next); stack.push(next); }
  return tasks.filter(other => other.id !== task.id && !below.has(other.id) && (other.outcome !== "cancelled" || other.id === task.parent))
    .sort((a, b) => Number(a.outcome !== "open") - Number(b.outcome !== "open") || a.title.localeCompare(b.title));
}

/** 子任务进度：已取消的不计入。 */
export function childProgress(ids: readonly string[], byId: ReadonlyMap<string, WorkTask>): { done: number; total: number } {
  const counted = ids.map(id => byId.get(id)).filter((task): task is WorkTask => !!task && task.outcome !== "cancelled");
  return { done: counted.filter(task => task.outcome === "done").length, total: counted.length };
}

/** 规范化一个新标签：去掉首尾空白与开头的 #；空的返回 undefined。 */
export function normalizeTag(raw: string): string | undefined {
  const tag = raw.trim().replace(/^#+/, "").trim();
  return tag || undefined;
}

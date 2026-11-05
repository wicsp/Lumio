/** Execution results are history; task attention follows the current human turn (ADR 0032). */
import type { Job, WorkAttention, WorkTask } from "@lumio/schema";
import { needsYou } from "./turn.ts";

const LIVE = ["queued", "assigned", "running"];
const PROBLEMS = ["waiting_for_human", "failed", "unknown"];
export type ExecutionGroup = "needs" | "live" | "history";

/** Classify before applying a status filter, so a hidden newer round still supersedes old questions. */
export function executionGroups(jobs: Job[], tasks?: WorkTask[], attention?: WorkAttention[], status?: Job["status"]): Record<ExecutionGroup, Job[]> {
  const groups: Record<ExecutionGroup, Job[]> = { needs: [], live: [], history: [] };
  const taskById = new Map(tasks?.map(task => [task.id, task]));
  const currentJobs = new Map(attention?.map(item => [item.task, item.job]));
  const latest = new Map<string, Job>();
  for (const job of jobs) {
    const source = job.spec.source;
    if (!source?.task) continue;
    const previous = latest.get(source.task);
    if (!previous || source.round > previous.spec.source!.round ||
      (source.round === previous.spec.source!.round && job.spec.created > previous.spec.created)) latest.set(source.task, job);
  }
  for (const job of jobs) {
    if (status && job.status !== status) continue;
    let group: ExecutionGroup = "history";
    const taskId = job.spec.source?.task;
    if (LIVE.includes(job.status)) group = "live";
    else if (taskId) {
      const task = taskById.get(taskId);
      // An available attention response, including [], is authoritative. Old Hubs fall back to task turns.
      const needs = attention !== undefined ? currentJobs.get(taskId) === job.spec.id
        : task ? needsYou(task) && task.turn.job === job.spec.id
        : PROBLEMS.includes(job.status) && latest.get(taskId) === job;
      if (needs) group = "needs";
    } else if (PROBLEMS.includes(job.status)) group = "needs"; // Standalone and routine runs have no Work turn.
    groups[group].push(job);
  }
  return groups;
}

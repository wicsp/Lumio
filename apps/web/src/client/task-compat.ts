import type { TaskStatus, WorkTask, WorkProject } from "@lumio/schema";

/** R4-2 keeps the existing presentation; R4-5 replaces these legacy display categories. */
export function taskStatus(task: WorkTask): TaskStatus {
  return task.outcome !== "open" ? task.outcome : task.turn.holder === "nobody" ? "paused" : task.turn.holder === "external" ? "waiting" : task.turn.reason === "todo" ? "todo" : "active";
}
export function workStatus(record: WorkTask | WorkProject) { return record.type === "task" ? taskStatus(record) : record.status; }
export function taskHolder(task: WorkTask): string { return task.turn.holder; }

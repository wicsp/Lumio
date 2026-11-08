import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WorkTask, WorkTaskDetail, WorkTaskListArgs, WorkTaskCreate, WorkTaskPatch, capability } from "../src/index.ts";
const task = JSON.parse(readFileSync(new URL("../../../fixtures/work/readiness.json", import.meta.url), "utf8"));
test("readiness is optional read data and forbidden in create and patch", () => {
  expect(WorkTask.parse(task).blocked_by).toBeUndefined();
  expect(WorkTask.parse({ ...task, blocked_by: [] }).blocked_by).toEqual([]);
  expect(WorkTask.parse({ ...task, blocked_by: [task.id] }).blocked_by).toEqual([task.id]);
  expect(WorkTaskCreate.safeParse({ op: "work.task.create", args: { title: task.title, blocked_by: [] } }).success).toBe(false);
  expect(WorkTaskPatch.safeParse({ title: "Changed", blocked_by: [] }).success).toBe(false);
  expect(WorkTask.safeParse({ ...task, blocked_by: ["invalid"] }).success).toBe(false);
});
test("detail relationships and composable list filters are strict contracts", () => {
  const detail = { task, dependents: [task.id], children: [], comments: [], executions: [], turns: [] };
  expect(WorkTaskDetail.parse(detail).dependents).toEqual([task.id]);
  expect(WorkTaskListArgs.parse({ readiness: "ready", tag: "infra", parent: task.id, query: "Synthetic" }).parent).toBe(task.id);
  for (const args of [{ readiness: "other" }, { tag: "" }, { parent: "bad" }, { blocked_by: [] }]) expect(WorkTaskListArgs.safeParse(args).success).toBe(false);
  for (const name of ["work.task.list", "work.task.show"]) for (const lang of ["en", "zh"] as const) expect(capability(name)!.summary[lang]).toContain("blocked_by");
});

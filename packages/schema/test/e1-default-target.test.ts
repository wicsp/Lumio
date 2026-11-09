import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  WorkCommandResult, WorkProject, WorkProjectCreate, WorkProjectPatch, WorkTask, WorkTaskCreate, WorkTaskPatch, capability,
} from "../src/index.ts";

const task = JSON.parse(readFileSync(new URL("../../../fixtures/work/readiness.json", import.meta.url), "utf8"));
const now = "2026-11-09T00:00:00Z";
const project = {
  schema_version: 2, type: "project", id: "prj_00000000000000000000000001", title: "Synthetic project",
  description: "", revision: 1, status: "active", created: now, updated: now, tags: [],
};

test("project default_target is optional, validated, and settable on create and patch", () => {
  expect(WorkProject.parse(project).default_target).toBeUndefined();
  expect(WorkProject.parse({ ...project, default_target: "codex@macsp" }).default_target).toBe("codex@macsp");
  expect(WorkProject.safeParse({ ...project, default_target: "" }).success).toBe(false);
  expect(WorkProjectCreate.safeParse({ op: "work.project.create", args: { title: "P", default_target: "codex" } }).success).toBe(true);
  expect(WorkProjectPatch.safeParse({ default_target: "claude-code@macsp" }).success).toBe(true);
  expect(WorkProjectPatch.parse({ default_target: null }).default_target).toBeNull();
});

test("task next_target is derived read data, forbidden in create and patch, and tasks have no own target", () => {
  expect(WorkTask.parse(task).next_target).toBeUndefined();
  for (const source of ["plan", "last_round", "project"] as const) {
    expect(WorkTask.parse({ ...task, next_target: { target: "codex@macsp", source } }).next_target?.source).toBe(source);
  }
  expect(WorkTask.safeParse({ ...task, next_target: { target: "codex@macsp", source: "explicit" } }).success).toBe(false);
  expect(WorkTask.safeParse({ ...task, target: "codex@macsp" }).success).toBe(false);
  const next_target = { target: "codex@macsp", source: "project" };
  expect(WorkTaskCreate.safeParse({ op: "work.task.create", args: { title: "T", next_target } }).success).toBe(false);
  expect(WorkTaskPatch.safeParse({ title: "T", next_target }).success).toBe(false);
  expect(WorkTaskPatch.safeParse({ target: "codex@macsp" }).success).toBe(false);
});

test("dispatch result may report the resolved target and its source", () => {
  const U = "01J00000000000000000000000";
  const spec = {
    protocol_version: 2, id: `job_${U}`, runtime: `act_${U}`, lease: "lease-0123456789abcdef",
    source: { task: `task_${U}`, round: 1 },
    run: { kind: "agent", engine: "codex", prompt: "Synthetic round" }, workdir: "~", timeout_seconds: 3600, created: now,
  };
  const parse = (extra: object) => WorkCommandResult.safeParse({ kind: "job", job: { spec, status: "queued" }, ...extra });
  expect(parse({}).success).toBe(true);
  expect(parse({ target: "codex@macsp", target_source: "explicit" }).success).toBe(true);
  expect(parse({ target: "codex@macsp", target_source: "session" }).success).toBe(false);
  expect(parse({ target: "", target_source: "project" }).success).toBe(false);
});

test("capability summaries mention the new fields", () => {
  for (const lang of ["en", "zh"] as const) {
    for (const name of ["work.task.list", "work.task.show"]) expect(capability(name)!.summary[lang]).toContain("next_target");
    for (const name of ["work.project.create", "work.project.update"]) expect(capability(name)!.summary[lang]).toContain("default_target");
  }
});

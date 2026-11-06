import { test, expect } from "bun:test";
import {
  CONTRACTS, KnowledgeDeleteRequest, TRASH_RETENTION_DAYS, TrashItem, TrashRestoreResult, WorkCommandRequest, WorkCommandResult, WORK_COMMAND_NAMES,
} from "../src/index.ts";

const ulid = "01JC0000000000000000000000";
const item = {
  kind: "task", id: `task_${ulid}`, title: "Old experiment", deleted_at: "2026-11-06T22:00:00+08:00", deleted_by: `act_${ulid}`,
  expires_at: "2026-12-06T22:00:00+08:00", project: `prj_${ulid}`, stopped_job: `job_${ulid}`,
} as const;

test("task and project deletion are Work commands with an expected revision", () => {
  expect(WORK_COMMAND_NAMES).toContain("work.task.delete");
  expect(WORK_COMMAND_NAMES).toContain("work.project.delete");
  const request = { request_id: "delete-test-0000001", operation: { op: "work.task.delete", args: { task: `task_${ulid}`, expected_revision: 3 } } } as const;
  expect(WorkCommandRequest.parse(request)).toEqual(request);
  expect(WorkCommandRequest.safeParse({ ...request, operation: { op: "work.task.delete", args: { task: `task_${ulid}` } } }).success).toBe(false);
  expect(WorkCommandRequest.safeParse({ ...request, operation: { op: "work.project.delete", args: { project: `task_${ulid}`, expected_revision: 1 } } }).success).toBe(false);
  expect(WorkCommandResult.parse({ kind: "trashed", item })).toEqual({ kind: "trashed", item });
});

test("trash items carry only a summary and reject unknown kinds or fields", () => {
  expect(TrashItem.parse(item)).toEqual(item);
  expect(TrashItem.safeParse({ ...item, kind: "routine" }).success).toBe(false);
  expect(TrashItem.safeParse({ ...item, body: "full text" }).success).toBe(false);
  expect(TrashItem.safeParse({ ...item, deleted_at: "2026-11-06T22:00:00" }).success).toBe(false);
  expect(TRASH_RETENTION_DAYS).toBe(30);
});

test("note deletion is versioned and restore reports where a note went back", () => {
  expect(KnowledgeDeleteRequest.safeParse({ request_id: "delete-note-000001" }).success).toBe(false);
  expect(KnowledgeDeleteRequest.parse({ request_id: "delete-note-000001", expected_revision: "a".repeat(64) }).expected_revision).toHaveLength(64);
  const restored = { request_id: "restore-note-00001", kind: "note", id: `idea_${ulid}`, path: "ideas/x (restored).md", renamed: true } as const;
  expect(TrashRestoreResult.parse(restored)).toEqual(restored);
});

test("trash contracts are exported as JSON Schema", () => {
  for (const name of ["trash-item", "trash-list-result", "knowledge-delete-request", "assistant-conversation-delete-request", "trash-result", "trash-restore-request", "trash-restore-result", "trash-purge-request", "trash-purge-result"])
    expect(Object.keys(CONTRACTS)).toContain(name);
});

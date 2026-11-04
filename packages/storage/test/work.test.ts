import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { WorkService } from "@lumio/work";
import { SqliteWorkStore } from "../src/work.ts";

const actor = "act_00000000000000000000000001";
function fixture(db: Database) {
  let n = 0;
  const service = new WorkService(new SqliteWorkStore(db), { now: () => new Date("2026-10-31T00:00:00Z"),
    id: (prefix) => `${prefix}_${String(++n).padStart(26, "0")}` });
  let request = 0;
  return { service, command(op: string, args: Record<string, unknown>) {
    return service.command({ request_id: `synthetic-request-${++request}`, operation: { op, args } }, actor);
  } };
}
test("normalized Work tables preserve descriptions, relations, clearable fields and Unicode without Knowledge tables", () => {
  const db = new Database(":memory:");
  try {
    const f = fixture(db), project = f.command("work.project.create", { title: "合成项目", description: "# 目标\n原文", goal: "验收" });
    if (project.kind !== "project") throw new Error("project expected");
    const a = f.command("work.task.create", { title: "前置", project: project.project.id, due: "2026-11-01T00:00:00Z" });
    if (a.kind !== "task") throw new Error("task expected");
    const b = f.command("work.task.create", { title: "后续", project: project.project.id, parent: a.task.id, dependencies: [a.task.id] });
    if (b.kind !== "task") throw new Error("task expected");
    expect(f.service.task(b.task.id)).toMatchObject({ parent: a.task.id, dependencies: [a.task.id], project: project.project.id });
    f.command("work.task.update", { task: a.task.id, expected_revision: 1, patch: { due: null } });
    expect(f.service.task(a.task.id).due).toBeUndefined();
    f.command("work.task.update", { task: a.task.id, expected_revision: 2, patch: { description: "外部编辑正文" } });
    expect(f.service.task(a.task.id).description).toBe("外部编辑正文");
    f.command("work.task.comment", { task: b.task.id, body: "合成讨论" });
    expect(f.service.detail(b.task.id).comments[0]!.body).toBe("合成讨论");
    expect(db.query("SELECT name FROM sqlite_master WHERE name='notes'").get()).toBeNull();
    expect(db.query("SELECT status FROM work_tasks WHERE id=?").get(a.task.id)).toEqual({ status: "todo" });
  } finally { db.close(); }
});

test("shared transaction rollback restores task, execution and request receipt together", () => {
  const db = new Database(":memory:");
  try {
    const f = fixture(db);
    expect(() => db.transaction(() => { f.command("work.task.create", { title: "应回滚" }); throw new Error("injected fault"); })()).toThrow("injected fault");
    expect(f.service.tasks()).toEqual([]); expect(db.query("SELECT * FROM work_requests").all()).toEqual([]);
    expect(f.command("work.task.create", { title: "可继续" }).kind).toBe("task");
  } finally { db.close(); }
});

test("R3 migration preserves old Work rows, is repeatable, and persists actors and acknowledged rounds", () => {
  const db = new Database(":memory:");
  try {
    const f = fixture(db), created = f.command("work.task.create", { title: "Synthetic pre-R3 task" });
    if (created.kind !== "task") throw new Error("task expected");
    // Reconstruct the previous column layout with populated Work data.
    for (const table of ["work_projects", "work_tasks"]) db.exec(`ALTER TABLE ${table} DROP COLUMN created_by; ALTER TABLE ${table} DROP COLUMN updated_by;`);
    db.exec("ALTER TABLE work_executions DROP COLUMN acknowledged; DELETE FROM platform_migrations WHERE name='work-2'");
    const store = new SqliteWorkStore(db), old = store.task(created.task.id)!;
    expect(old.title).toBe("Synthetic pre-R3 task"); expect(old.created_by).toBeUndefined();
    store.putTask({ ...old, revision: 2, updated_by: actor });
    const execution = { task: old.id, job: "job_00000000000000000000000001", round: 1, input_revision: 1,
      input_snapshot: "Synthetic snapshot", created: old.created, applied: true, acknowledged: { at: old.updated, by: actor } };
    store.putExecution(execution);
    const reopened = new SqliteWorkStore(db);
    expect(reopened.task(old.id)?.updated_by).toBe(actor); expect(reopened.executions(old.id)).toEqual([execution]);
    expect(db.query("SELECT * FROM platform_migrations WHERE name='work-2'").all()).toHaveLength(1);
  } finally { db.close(); }
});

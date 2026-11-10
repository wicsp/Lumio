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
    expect(db.query("SELECT outcome FROM work_tasks WHERE id=?").get(a.task.id)).toEqual({ outcome: "open" });
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

test("v3 store persists actors and append-only turns across reopen", () => {
  const db = new Database(":memory:");
  try {
    const f = fixture(db), created = f.command("work.task.create", { title: "Synthetic task" });
    if (created.kind !== "task") throw new Error("task expected");
    f.command("work.task.hand", { task: created.task.id, expected_revision: 1, to: "external", note: "Synthetic wait" });
    const store = new SqliteWorkStore(db);
    expect(store.task(created.task.id)?.turn.holder).toBe("external");
    expect(store.turns(created.task.id)).toHaveLength(2);
    expect(store.turns(created.task.id)[1]!.by).toBe(actor);
    expect(db.query("SELECT * FROM platform_migrations WHERE name='work-3'").all()).toHaveLength(1);
  } finally { db.close(); }
});

test("plan templates survive adapter reopen, overwrite in place, delete and transaction rollback", () => {
  const db = new Database(":memory:");
  try {
    const f = fixture(db), plan = { stages: [{ kind: "agent", id: "implement", agent: "codex@mac", instruction: "Synthetic implementation" }] };
    const saved = f.command("work.plan_template.save", { name: "Synthetic template", plan });
    if (saved.kind !== "template") throw new Error("template expected");
    let store = new SqliteWorkStore(db);
    expect(store.planTemplates()).toEqual([saved.template]);
    f.command("work.plan_template.save", { template: saved.template.id, name: "Updated", plan });
    expect(store.planTemplates()).toMatchObject([{ id: saved.template.id, name: "Updated", created: saved.template.created }]);
    expect(() => db.transaction(() => { f.command("work.plan_template.delete", { template: saved.template.id }); throw new Error("synthetic rollback"); })()).toThrow("synthetic rollback");
    expect(store.planTemplates()).toHaveLength(1);
    f.command("work.plan_template.delete", { template: saved.template.id });
    store = new SqliteWorkStore(db); expect(store.planTemplates()).toEqual([]);
  } finally { db.close(); }
});

test("derived readiness is never persisted; SQLite purge preserves dangling dependencies and readable details", async () => {
  const seed = await Bun.file(new URL("../../../fixtures/work/readiness.json", import.meta.url)).json();
  const db = new Database(":memory:");
  try {
    const f = fixture(db), store = new SqliteWorkStore(db);
    const a = f.command("work.task.create", { title: seed.title });
    if (a.kind !== "task") throw new Error("task expected");
    const b = f.command("work.task.create", { title: "Synthetic dependent", dependencies: [a.task.id], parent: a.task.id });
    if (b.kind !== "task") throw new Error("task expected");
    expect(b.task.blocked_by).toEqual([a.task.id]);
    store.putTask(b.task);
    store.putReceipt(actor, "synthetic-derived-receipt", "{}", b);
    expect(store.task(b.task.id)?.blocked_by).toBeUndefined();
    expect(JSON.stringify(db.query("SELECT * FROM work_requests").all())).not.toContain("blocked_by");
    expect(JSON.stringify(db.query("SELECT * FROM work_tasks").all())).not.toContain("blocked_by");
    const deleted = f.command("work.task.delete", { task: a.task.id, expected_revision: 1 });
    if (deleted.kind !== "trashed") throw new Error("trash expected");
    expect(f.service.detail(b.task.id).task.blocked_by).toEqual([]);
    f.service.restore(deleted.item, actor);
    expect(f.service.task(b.task.id).blocked_by).toEqual([a.task.id]);
    const again = f.command("work.task.delete", { task: a.task.id, expected_revision: 2 });
    if (again.kind !== "trashed") throw new Error("trash expected");
    store.purge(again.item);
    expect(store.task(a.task.id)).toBeUndefined();
    expect(f.service.detail(b.task.id).task).toMatchObject({ dependencies: [a.task.id], parent: a.task.id, blocked_by: [] });
    f.command("work.task.finish", { task: b.task.id, expected_revision: 1, outcome: "done" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("existing projects gain a nullable default and derived targets stay out of tasks and receipts", () => {
  const db = new Database(":memory:");
  try {
    const f = fixture(db);
    const project = f.command("work.project.create", { title: "Synthetic existing project" });
    if (project.kind !== "project") throw Error("Expected a project");
    db.exec("ALTER TABLE work_projects DROP COLUMN default_target");
    const store = new SqliteWorkStore(db);
    expect(store.project(project.project.id)).toEqual(project.project);
    store.putProject({ ...project.project, default_target: "codex@mac" });
    expect(new SqliteWorkStore(db).project(project.project.id)?.default_target).toBe("codex@mac");
    const created = f.command("work.task.create", { title: "Synthetic inheriting task", project: project.project.id });
    if (created.kind !== "task") throw Error("Expected a task");
    expect(created.task.next_target).toEqual({ target: "codex@mac", source: "project" });
    store.putTask(created.task);
    store.putReceipt(actor, "synthetic-target-receipt", "{}", created);
    expect(store.task(created.task.id)?.next_target).toBeUndefined();
    expect(store.receipt(actor, "synthetic-target-receipt")?.result).not.toHaveProperty("task.next_target");
  } finally { db.close(); }
});

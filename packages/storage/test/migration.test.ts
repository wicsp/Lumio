import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Job, MigrationPlan, WorkProject } from "@lumio/schema";
import { WorkService } from "@lumio/work";
import { SqliteWorkStore } from "../src/work.ts";
import { SqliteRoutineStore } from "../src/routines.ts";
import { LegacyMigration, isMigratedSource } from "../src/migration.ts";
import { backupBusiness, restoreBusiness } from "../src/backup.ts";

const project = "prj_00000000000000000000000001", task = "task_00000000000000000000000002", routine = "rtn_00000000000000000000000003", actor = "act_00000000000000000000000004";
const p = "plan/projects/合成项目.md", t = "plan/tasks/合成任务.md", r = "plan/routines/合成例行.md";
const time = "2026-10-31T00:00:00Z";
function note(id: string, type: string, title: string, fields: string, body = "原始正文\n") {
  return Buffer.from(`\uFEFF---\r\nid: ${id}\r\ntype: ${type}\r\ntitle: ${title}\r\ncreated: ${time}\r\nupdated: ${time}\r\n${fields}\r\ncustom_field: {keep: "unknown"}\r\n---\r\n${body}`);
}
async function fixture(action: (f: { root: string; state: string; vault: string; db: Database; migration: LegacyMigration; backup: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lumio-migration-")), state = join(root, "state"), vault = join(root, "vault"); await mkdir(state);
  const db = new Database(join(state, "hub.sqlite"), { strict: true });
  try {
    for (const path of [p, t, r]) await mkdir(join(vault, path, ".."), { recursive: true });
    await writeFile(join(vault, p), note(project, "project", "合成项目", "status: active"));
    await writeFile(join(vault, t), note(task, "task", "合成任务", `status: active\r\nassignee: {agent: pi, device: server}\r\nturn: human\r\nproject: ${project}`, "人写的正文与 [[旧链接]]\n<!-- lumio:ai start name=round-5 -->\n旧汇报\n<!-- lumio:ai end name=round-5 -->\n"));
    await writeFile(join(vault, r), note(routine, "routine", "合成例行", 'status: paused\r\nschedule: "*/10 * * * *"\r\ntimezone: UTC\r\nassignee: pi@server'));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE jobs(id TEXT PRIMARY KEY,record TEXT NOT NULL,cancel INTEGER NOT NULL DEFAULT 0); CREATE TABLE task_state(task TEXT PRIMARY KEY,rounds INTEGER,pending_since INTEGER,session TEXT); CREATE TABLE task_rounds(job TEXT PRIMARY KEY,task TEXT,round INTEGER,written INTEGER); CREATE TABLE routine_plans(routine TEXT PRIMARY KEY,spec TEXT)");
    for (const round of [2, 5]) {
      const job = Job.parse({ spec: { protocol_version: 2, id: `job_${String(round).padStart(26, "0")}`, runtime: actor, lease: "synthetic-lease-0123456789", created: time,
        source: { task, round }, run: { kind: "agent", engine: "pi", prompt: `第 ${round} 轮的真实历史输入` }, workdir: "~", timeout_seconds: 60 }, status: "done", assigned: time,
        result: { job: `job_${String(round).padStart(26, "0")}`, lease: "synthetic-lease-0123456789", status: "done", finished: time, report: `旧结果 ${round}`, session_id: `session-${round}` } });
      db.query("INSERT INTO jobs VALUES(?,?,0)").run(job.spec.id, JSON.stringify(job));
      db.query("INSERT INTO task_rounds VALUES(?,?,?,1)").run(job.spec.id, task, round);
    }
    db.query("INSERT INTO task_state VALUES(?,5,NULL,'historical-session')").run(task); db.query("INSERT INTO routine_plans VALUES(?,'old-plan')").run(routine);
    await action({ root, state, vault, db, migration: new LegacyMigration(db, vault, { timezone: "UTC" }), backup: join(root, "backup") });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test("legacy import preserves IDs, exact bytes, unknown fields, body, source mapping, Job input, sessions and round gaps; replay never dispatches", async () => fixture(async (f) => {
  const original = await readFile(join(f.vault, t)), jobs = f.db.query("SELECT * FROM jobs ORDER BY id").all();
  const plan = await f.migration.plan(); expect(MigrationPlan.safeParse(plan).success).toBe(true); expect(plan.entries).toHaveLength(3); expect(plan.problems).toEqual([]);
  await backupBusiness(f.state, f.backup); await f.migration.apply(plan, f.backup, true); await f.migration.apply(plan, f.backup, true);
  const store = new SqliteWorkStore(f.db), current = store.task(task)!;
  expect(current.id).toBe(task); expect(current.assignee).toBe("pi@server"); expect(current.description).toContain("人写的正文与 [[旧链接]]"); expect(current.description).toContain("旧汇报");
  expect(f.migration.source(task).bytes).toEqual(original); expect(await readFile(join(f.vault, t))).toEqual(original);
  expect(isMigratedSource(f.db, t)).toBe(true); expect(f.migration.sources()).toHaveLength(3); expect((await f.migration.plan()).entries).toEqual([]);
  expect(store.executions(task).map((execution) => [execution.round, execution.applied, execution.input_snapshot])).toEqual([[2, true, "第 2 轮的真实历史输入"], [5, true, "第 5 轮的真实历史输入"]]);
  expect(f.db.query("SELECT * FROM jobs ORDER BY id").all()).toEqual(jobs);
  expect(f.db.query("SELECT spec FROM routine_plans").all()).toEqual([]); expect(new SqliteRoutineStore(f.db).get(routine)!.status).toBe("paused");
  let nextRound = 0;
  const work = new WorkService(store, { now: () => new Date(time), id: (prefix) => `${prefix}_${"9".padStart(26, "0")}`, dispatch: (_task, _input, round) => {
    nextRound = round; return Job.parse({ spec: { protocol_version: 2, id: "job_00000000000000000000000009", runtime: actor, lease: "synthetic-lease-0123456789", created: time, source: { task, round }, run: { kind: "agent", engine: "pi", prompt: "new input" }, workdir: "~", timeout_seconds: 60 }, status: "queued" });
  } });
  work.command({ request_id: "synthetic-after-import", operation: { op: "work.task.dispatch", args: { task } } }, actor); expect(nextRound).toBe(6);
  const restored = join(f.root, "restored"); await restoreBusiness(f.backup, restored);
  const old = new Database(join(restored, "hub.sqlite"), { readonly: true });
  try { expect(old.query("SELECT name FROM sqlite_master WHERE name='migration_sources'").get()).toBeNull(); expect(old.query("SELECT * FROM jobs ORDER BY id").all()).toEqual(jobs); } finally { old.close(); }
}));

test("dry-run refuses active schedules, pending switches, duplicate IDs, missing projects and active executions", async () => fixture(async (f) => {
  await writeFile(join(f.vault, r), note(routine, "routine", "合成例行", 'status: active\r\nschedule: "*/10 * * * *"\r\nassignee: pi@server'));
  await writeFile(join(f.vault, "plan/tasks/重复.md"), note(task, "task", "重复", `assignee: pi@server\r\nproject: prj_00000000000000000000000099`));
  const row = f.db.query<{ record: string }, []>("SELECT record FROM jobs LIMIT 1").get()!, job = Job.parse(JSON.parse(row.record));
  const { result: _result, ...active } = job; f.db.query("UPDATE jobs SET record=? WHERE id=?").run(JSON.stringify({ ...active, status: "running" }), job.spec.id);
  f.db.query("UPDATE task_state SET pending_since=1 WHERE task=?").run(task);
  const plan = await f.migration.plan();
  for (const text of ["暂停", "ID 重复", "待派活", "项目不存在", "执行或等待", "等待派出"]) expect(plan.problems.some((problem) => problem.includes(text))).toBe(true);
  await expect(f.migration.apply(plan, f.backup, true)).rejects.toMatchObject({ code: "CONFLICT" });
}));

test("apply rejects changed source, incomplete preparation, stale backups and ID collisions without changing source or business data", async () => fixture(async (f) => {
  const plan = await f.migration.plan(); await backupBusiness(f.state, f.backup);
  await expect(f.migration.apply(plan, f.backup, false)).rejects.toMatchObject({ code: "CONFLICT" });
  const original = await readFile(join(f.vault, t)); await writeFile(join(f.vault, t), Buffer.concat([original, Buffer.from("changed")]));
  await expect(f.migration.apply(plan, f.backup, true)).rejects.toThrow("源文件已变化"); await writeFile(join(f.vault, t), original);
  f.db.exec("CREATE TABLE new_business(id TEXT)"); await expect(f.migration.apply(plan, f.backup, true)).rejects.toThrow("当前业务状态");
  const work = new SqliteWorkStore(f.db); work.putProject(WorkProject.parse({ schema_version: 2, type: "project", id: project, title: "existing", description: "", revision: 1, status: "planning", tags: [], created: time, updated: time }));
  expect((await f.migration.plan()).problems.some((problem) => problem.includes("相同 ID"))).toBe(true);
  expect(await readFile(join(f.vault, t))).toEqual(original); expect(f.db.query("SELECT name FROM sqlite_master WHERE name='migration_receipts'").get()).toBeNull();
}));

test("a mid-import failure rolls back source archives, objects, histories and receipt as one transaction", async () => fixture(async (f) => {
  const work = new SqliteWorkStore(f.db);
  f.db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON work_tasks BEGIN SELECT RAISE(ABORT,'synthetic import failure'); END");
  const plan = await f.migration.plan(); await backupBusiness(f.state, f.backup);
  await expect(f.migration.apply(plan, f.backup, true)).rejects.toThrow("synthetic import failure");
  expect(work.projects()).toEqual([]); expect(work.tasks()).toEqual([]); expect(work.executions()).toEqual([]);
  expect(f.db.query("SELECT name FROM sqlite_master WHERE name='migration_sources'").get()).toBeNull(); expect(f.db.query("SELECT * FROM jobs").all()).toHaveLength(2);
}));

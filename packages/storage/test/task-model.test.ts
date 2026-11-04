import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Job, WorkTaskDetail, TaskTurnChange } from "@lumio/schema";
import { migrateTaskModel } from "../src/task-model.ts";
import { SqliteWorkStore } from "../src/work.ts";
import { SqliteArtifacts } from "../src/artifacts.ts";
import { verifyBusinessBackup } from "../src/backup.ts";

const by = "act_00000000000000000000000001", at = "2026-11-04T00:00:00Z";
const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(26, "0")}`;
async function fixture(run: (state: string, db: Database) => Promise<void>) {
  const state = await mkdtemp(join(tmpdir(), "lumio-task-v3-")), db = new Database(join(state, "hub.sqlite"));
  try {
    // Original v2 layout; all rows and reports below are synthetic.
    db.exec(`CREATE TABLE platform_migrations(name TEXT PRIMARY KEY,applied TEXT NOT NULL);
      INSERT INTO platform_migrations VALUES('work-1','${at}'),('work-2','${at}');
      CREATE TABLE work_projects(id TEXT PRIMARY KEY,title TEXT,description TEXT,revision INTEGER,status TEXT,created TEXT,updated TEXT,tags TEXT,goal TEXT,repo TEXT,deadline TEXT,created_by TEXT,updated_by TEXT);
      CREATE TABLE work_tasks(id TEXT PRIMARY KEY,title TEXT,description TEXT,revision INTEGER,status TEXT,assignee TEXT,project TEXT,parent TEXT,due TEXT,created TEXT,updated TEXT,tags TEXT,refs TEXT,workdir TEXT,model TEXT,gpus TEXT,timeout_minutes INTEGER,created_by TEXT,updated_by TEXT);
      CREATE TABLE work_executions(job TEXT PRIMARY KEY,task TEXT,round INTEGER,input_revision INTEGER,input_snapshot TEXT,created TEXT,applied INTEGER,acknowledged TEXT);
      CREATE TABLE work_dependencies(task TEXT,dependency TEXT,PRIMARY KEY(task,dependency));
      CREATE TABLE work_comments(id TEXT PRIMARY KEY,task TEXT,author TEXT,body TEXT,created TEXT);
      CREATE TABLE work_requests(actor TEXT,request TEXT,operation TEXT,result TEXT,PRIMARY KEY(actor,request));
      CREATE TABLE jobs(id TEXT PRIMARY KEY,record TEXT);
      CREATE TABLE runtimes(actor TEXT,registration TEXT);
      INSERT INTO runtimes VALUES('${by}','{"name":"mac"}');`);
    await run(state, db);
  } finally { db.close(); await rm(state, { recursive: true, force: true }); }
}
function seed(db: Database, n: number, status: string, result?: Job["status"], pending = false, acknowledged = false) {
  db.query("INSERT INTO work_tasks(id,title,description,revision,status,assignee,created,updated,tags,refs) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id("task", n), `Synthetic ${n}`, "Synthetic description", 4, status, "pi@discarded", at, at, "[]", "[]");
  if (result) {
    const job = Job.parse({ spec: { protocol_version: 2, id: id("job", n), runtime: by, lease: "synthetic-lease-0000", created: at,
      run: { kind: "agent", engine: "codex", prompt: "Synthetic input" }, workdir: "~", timeout_seconds: 60 }, status: result,
      ...(!pending && result !== "cancelled" ? { result: { job: id("job", n), lease: "synthetic-lease-0000", status: result, finished: at, report: "Synthetic report" } } : {}) });
    db.query("INSERT INTO jobs VALUES(?,?)").run(job.spec.id, JSON.stringify(job));
    db.query("INSERT INTO work_executions VALUES(?,?,?,?,?,?,?,?)").run(job.spec.id, id("task", n), 3, 4, "Synthetic input", at, Number(!pending), acknowledged ? JSON.stringify({ at, by }) : null);
  }
}

test("ADR 0032 §8 migration covers every row and latest-round case, backs up database/files, and reruns without changes", async () => fixture(async (state, db) => {
  const cases: Array<[string, Job["status"] | undefined, boolean, boolean, string, string, string]> = [
    ["todo", undefined, false, false, "open", "human", "todo"],
    ["active", undefined, false, false, "open", "human", "todo"],
    ["active", "running", true, false, "open", "codex@mac", "working"],
    ["active", "waiting_for_human", false, false, "open", "human", "answer"],
    ["active", "done", false, false, "open", "human", "review"],
    ["active", "failed", false, false, "open", "human", "failed"],
    ["active", "unknown", false, false, "open", "human", "failed"],
    ["active", "cancelled", false, false, "open", "human", "todo"],
    ["active", "done", false, true, "open", "human", "todo"],
    ["waiting", undefined, false, false, "open", "external", "waiting"],
    ["paused", undefined, false, false, "open", "nobody", "on_hold"],
    ["done", undefined, false, false, "done", "nobody", "on_hold"],
    ["cancelled", undefined, false, false, "cancelled", "nobody", "on_hold"],
  ];
  cases.forEach(([status, result, pending, acknowledged], n) => seed(db, n + 1, status, result, pending, acknowledged));
  const files = new SqliteArtifacts(db, join(state, "files"));
  const bytes = Buffer.from("Synthetic managed file"), artifact = id("art", 1);
  files.stage({ id: artifact, owner: { module: "execution", id: id("job", 3) }, key: `${artifact}.bin`, size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), media_type: "text/plain", status: "staged", private: false, created: at });
  await files.publish(artifact, (async function* () { yield bytes; })());
  const migrated = await migrateTaskModel(db, state, by, new Date(at));
  expect(migrated.migrated).toBe(cases.length);
  const manifest = await verifyBusinessBackup(migrated.backup!);
  const backup = new Database(join(migrated.backup!, "hub.sqlite"), { readonly: true });
  try { expect(backup.query("SELECT status,assignee FROM work_tasks").all()).toHaveLength(cases.length); } finally { backup.close(); }
  expect(manifest.database.sha256).toHaveLength(64); expect(manifest.files).toHaveLength(1);
  const store = new SqliteWorkStore(db);
  cases.forEach(([, , , , outcome, holder, reason], n) => {
    const task = store.task(id("task", n + 1))!;
    expect(task).toMatchObject({ schema_version: 3, outcome, turn: { holder, reason }, revision: 5 });
    expect("status" in task || "assignee" in task).toBe(false);
    const detail = WorkTaskDetail.parse({ task, comments: store.comments(task.id), executions: store.executions(task.id), turns: store.turns(task.id) });
    expect(detail.turns).toHaveLength(1); expect(TaskTurnChange.parse(detail.turns[0]).by).toBe(by);
  });
  const before = db.serialize();
  expect(await migrateTaskModel(db, state, by)).toEqual({ migrated: 0 });
  expect(db.serialize()).toEqual(before); expect(await readdir(join(state, "backups"))).toHaveLength(1);
}));

test("backup failure and invalid history leave v2 rows and migration markers intact", async () => fixture(async (state, db) => {
  seed(db, 1, "active");
  await writeFile(join(state, "backups"), "Synthetic obstruction");
  await expect(migrateTaskModel(db, state, by)).rejects.toThrow();
  expect(db.query("SELECT status FROM work_tasks").get()).toEqual({ status: "active" });
  expect(db.query("SELECT * FROM platform_migrations WHERE name='work-3'").get()).toBeNull();
  await rm(join(state, "backups"));
  db.query("INSERT INTO work_executions VALUES(?,?,?,?,?,?,?,?)").run(id("job", 1), id("task", 1), 1, 4, "Synthetic input", at, 0, null);
  await expect(migrateTaskModel(db, state, by)).rejects.toMatchObject({ code: "CORRUPT" });
  expect(db.query("SELECT status FROM work_tasks").get()).toEqual({ status: "active" });
  expect(db.query("SELECT * FROM platform_migrations WHERE name='work-3'").get()).toBeNull();
  expect(await readdir(join(state, "backups"))).toHaveLength(1);
}));

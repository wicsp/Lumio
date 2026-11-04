import { randomBytes } from "node:crypto";
import { newId } from "@lumio/foundation";
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Actor, TaskTurnChange, type Job } from "@lumio/schema";
import { migrateTurn, type LegacyTurnFacts } from "@lumio/work";
import { backupBusiness, verifyBusinessBackup } from "./backup.ts";
import { upgradeWorkTables } from "./work.ts";
import { StorageError } from "./errors.ts";

/** Caller holds the state lease. No task is rewritten before a complete, verified business backup. */
export async function migrateTaskModel(db: Database, stateDir: string, by: string, now = new Date()): Promise<{ migrated: number; backup?: string }> {
  const exists = (name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!exists("work_tasks") || exists("platform_migrations") && db.query("SELECT 1 FROM platform_migrations WHERE name='work-3'").get()) return { migrated: 0 };
  const tasks = db.query<Record<string, unknown>, []>("SELECT * FROM work_tasks").all();
  // Even an empty legacy store has receipts and other business data worth preserving.
  await mkdir(join(stateDir, "backups"), { recursive: true, mode: 0o700 });
  const backup = join(stateDir, "backups", `task-v3-${crypto.randomUUID()}`);
  await backupBusiness(stateDir, backup, now); await verifyBusinessBackup(backup);
  db.transaction(() => {
    const executions = exists("work_executions") ? db.query<Record<string, unknown>, []>("SELECT * FROM work_executions ORDER BY round").all() : [];
    const jobs: Job[] = exists("jobs") ? db.query<{ record: string }, []>("SELECT record FROM jobs").all().map(row => JSON.parse(row.record) as Job) : [];
    const runtimes = exists("runtimes") ? db.query<Record<string, unknown>, []>("SELECT * FROM runtimes").all() : [];
    const converted = new Map<string, ReturnType<typeof migrateTurn>>();
    for (const task of tasks) {
      const runs = executions.filter(run => run.task === task.id);
      const pending = runs.filter(run => !run.applied);
      const run = pending.at(-1) ?? runs.at(-1);
      let latest: LegacyTurnFacts["latest"];
      if (run) {
        const job = jobs.find(job => job.spec.id === run.job);
        if (!job) throw new StorageError("CORRUPT", { key: "work.migration_missing_job", args: [run.job] });
        const runtime = runtimes.find(runtime => runtime.actor === job.spec.runtime);
        // Runtime registry persists its complete registration as JSON.
        const registration = runtime?.registration ? JSON.parse(String(runtime.registration)) as { name: string } : undefined;
        const agent = job.spec.run.kind === "agent" ? `${job.spec.run.engine}${registration ? `@${registration.name}` : ""}` : undefined;
        if (!run.applied && !agent) throw new StorageError("CORRUPT", { key: "work.migration_missing_agent", args: [run.job] });
        latest = { job: String(run.job), round: Number(run.round), status: job.status, pending: !run.applied,
          acknowledged: Boolean(run.acknowledged), agent };
      }
      converted.set(String(task.id), migrateTurn({ status: String(task.status), latest }, now.toISOString()));
    }
    // Bring pre-R3 databases up to the previous layout within this same transaction.
    if (!db.query("PRAGMA table_info(work_tasks)").all().some(row => (row as { name: string }).name === "created_by")) {
      for (const table of ["work_tasks", "work_projects"]) db.exec(`ALTER TABLE ${table} ADD COLUMN created_by TEXT; ALTER TABLE ${table} ADD COLUMN updated_by TEXT;`);
    }
    if (!db.query("PRAGMA table_info(work_executions)").all().some(row => (row as { name: string }).name === "acknowledged")) db.exec("ALTER TABLE work_executions ADD COLUMN acknowledged TEXT");
    db.exec("INSERT OR IGNORE INTO platform_migrations VALUES('work-2',strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
    upgradeWorkTables(db);
    for (const [id, value] of converted) {
      db.query("UPDATE work_tasks SET outcome=?,turn=?,revision=revision+1,updated=?,updated_by=? WHERE id=?").run(value.outcome, JSON.stringify(value.turn), now.toISOString(), by, id);
      const change = TaskTurnChange.parse({ task: id, at: now.toISOString(), by, from: value.turn, to: value.turn, outcome: value.outcome });
      db.query("INSERT INTO work_turns(task,record) VALUES (?,?)").run(id, JSON.stringify(change));
    }
    // Preserve request deduplication without serving obsolete v2 objects or acknowledgements.
    for (const row of db.query<{ actor: string; request: string; result: string }, []>("SELECT actor,request,result FROM work_requests").all()) {
      const result = JSON.parse(row.result);
      if (result.kind === "task" && result.task.schema_version === 2) {
        const { status, assignee: _assignee, ...task } = result.task;
        result.task = { ...task, schema_version: 3, ...migrateTurn({ status }, task.updated) };
        db.query("UPDATE work_requests SET result=? WHERE actor=? AND request=?").run(JSON.stringify(result), row.actor, row.request);
      }
    }
  })();
  return { migrated: tasks.length, backup };
}

/** A stable, tokenless identity shared by migration and automatic Work transitions. */
export function workSystemActor(db: Database): Actor {
  return db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS actors(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,role TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS internal_actors(purpose TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES actors(id));`);
    const binding = db.query<{ actor: string }, []>("SELECT actor FROM internal_actors WHERE purpose='work-system'").get();
    if (binding) return Actor.parse(db.query("SELECT * FROM actors WHERE id=?").get(binding.actor));
    const now = new Date(), actor = Actor.parse({ id: newId("act", now, randomBytes), name: `work-system-${randomBytes(6).toString("hex")}`, role: "agent", created: now.toISOString() });
    db.query("INSERT INTO actors VALUES(?,?,?,?)").run(actor.id, actor.name, actor.role, actor.created);
    db.query("INSERT INTO internal_actors(purpose,actor) VALUES('work-system',?)").run(actor.id);
    return actor;
  })();
}

import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MigrationPlan, MigrationEntry, Project, Task, Routine, WorkProject, WorkTask, WorkExecution, ExecutionRoutine,
  Job, parseAssignee, textContainsCardNumber } from "@lumio/schema";
import { newId } from "@lumio/foundation";
import { parseFrontmatter } from "@lumio/knowledge";
import { WorkService } from "@lumio/work";
import { ExecutionRoutines, parseCron, validTimeZone, nextFire } from "@lumio/execution";
import { scanVault } from "./knowledge/vault.ts";
import { SqliteWorkStore } from "./work.ts";
import { SqliteRoutineStore } from "./routines.ts";
import { verifyBusinessBackup } from "./backup.ts";
import { safeStoredFile } from "./artifacts.ts";
import { StorageError } from "./errors.ts";
import { Database as Sqlite } from "bun:sqlite";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function table(db: Database, name: string): boolean { return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
const targetTable = { project: "work_projects", task: "work_tasks", routine: "execution_routines" } as const;
export function isMigratedSource(db: Database, path: string): boolean {
  return table(db, "migration_sources") && !!db.query("SELECT 1 FROM migration_sources WHERE path=?").get(path);
}
export function legacyControlDisabled(db: Database): boolean {
  return table(db, "migration_receipts") && !!db.query("SELECT 1 FROM migration_receipts LIMIT 1").get();
}
function rows(db: Database, name: string): Record<string, unknown>[] { return table(db, name) ? db.query(`SELECT * FROM ${name} ORDER BY rowid`).all() as Record<string, unknown>[] : []; }
/** Logical contents avoid comparing SQLite page layouts or missing WAL commits when validating the required pre-migration backup. */
export function businessContentHash(db: Database): string {
  const names = db.query<{ name: string; sql: string }, []>("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const hash = createHash("sha256");
  hash.update(JSON.stringify(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()));
  for (const item of names) {
    const quoted = '"' + item.name.replaceAll('"', '""') + '"';
    hash.update(JSON.stringify({ name: item.name, sql: item.sql }));
    const data = db.query(`SELECT * FROM ${quoted}`).all().map((row) => JSON.stringify(row, (_key, value) => value instanceof Uint8Array ? { binary: Buffer.from(value).toString("base64") } : typeof value === "bigint" ? { integer: value.toString() } : value)).sort();
    for (const row of data) hash.update(row + "\n");
  }
  return hash.digest("hex");
}
function targetExists(db: Database, entry: MigrationEntry): boolean {
  return table(db, targetTable[entry.type]) && !!db.query(`SELECT 1 FROM ${targetTable[entry.type]} WHERE id=?`).get(entry.id);
}
function histories(db: Database): Job[] { return rows(db, "jobs").map((row) => Job.parse(JSON.parse(String(row.record)))); }
function owner(value: unknown): string {
  const target = parseAssignee(value); return target === "human" ? target : `${target.agent}${target.device ? `@${target.device}` : ""}`;
}
interface Input { entry: MigrationEntry; bytes: Buffer; project?: WorkProject; task?: WorkTask; routine?: ExecutionRoutine }
function convert(entry: MigrationEntry, bytes: Buffer, timezone: string): Input {
  const parsed = parseFrontmatter(bytes), fields = parsed.data, description = parsed.body.toString("utf8");
  if (entry.type === "project") {
    const value = Project.parse(fields);
    return { entry, bytes, project: WorkProject.parse({ schema_version: 2, type: "project", id: value.id, title: value.title,
      description, revision: 1, status: value.status, created: value.created, updated: value.updated, tags: value.tags,
      goal: value.goal, repo: value.repo, deadline: value.deadline }) };
  }
  if (entry.type === "task") {
    const value = Task.parse(fields);
    return { entry, bytes, task: WorkTask.parse({ schema_version: 2, type: "task", id: value.id, title: value.title,
      description, revision: 1, status: value.status, assignee: owner(value.assignee), created: value.created, updated: value.updated,
      tags: value.tags, dependencies: [], references: value.routine ? [{ module: "execution", id: value.routine }] : [],
      project: value.project, due: value.due, workdir: value.workdir, model: value.model, gpus: value.gpus, timeout_minutes: value.timeout_minutes }) };
  }
  const value = Routine.parse(fields), zone = value.timezone ?? timezone;
  if (!validTimeZone(zone) || !nextFire(parseCron(value.schedule), zone, new Date(value.updated))) throw new StorageError("INVALID", "例行任务的时区或 cron 不合法");
  return { entry, bytes, routine: ExecutionRoutine.parse({ schema_version: 2, id: value.id, title: value.title, description, revision: 1,
    status: value.status, schedule: value.schedule, timezone: zone, assignee: owner(value.assignee), context: value.context,
    created: value.created, updated: value.updated, workdir: value.workdir, model: value.model, gpus: value.gpus, timeout_minutes: value.timeout_minutes }) };
}

/** Offline import preserves facts and source bytes; it never invokes a dispatch, executes a job or rewrites a knowledge file. */
export class LegacyMigration {
  constructor(private readonly db: Database, private readonly vault: string, private readonly options: { timezone?: string; now?: () => Date } = {}) {}
  private zone() { return this.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone; }
  sources(): MigrationEntry[] { return rows(this.db, "migration_sources").map((row) => MigrationEntry.parse(JSON.parse(String(row.entry)))); }
  source(id: string): { entry: MigrationEntry; bytes: Buffer } {
    const row = table(this.db, "migration_sources") ? this.db.query<{ entry: string; bytes: Uint8Array }, [string]>("SELECT entry,bytes FROM migration_sources WHERE id=?").get(id) : undefined;
    if (!row) throw new StorageError("NOT_FOUND", "找不到迁移来源");
    return { entry: MigrationEntry.parse(JSON.parse(row.entry)), bytes: Buffer.from(row.bytes) };
  }
  async plan(): Promise<MigrationPlan> {
    const entries: MigrationEntry[] = [], problems: string[] = [], inputs: Input[] = [], ids = new Set<string>();
    for (const file of await scanVault(this.vault, ["project", "task", "routine"])) {
      if (isMigratedSource(this.db, file.relativePath)) continue;
      try {
        const bytes = await readFile(await safeStoredFile(this.vault, file.relativePath)), fields = parseFrontmatter(bytes).data;
        const entry = MigrationEntry.parse({ id: fields.id, type: file.type, path: file.relativePath, sha256: sha(bytes), title: fields.title });
        if (ids.has(entry.id)) problems.push(`${entry.path}：ID 重复`); ids.add(entry.id);
        if (targetExists(this.db, entry)) problems.push(`${entry.path}：数据库已存在相同 ID`);
        if (textContainsCardNumber(bytes.toString("utf8")) || /\b(?:sk-|gh[pousr]_|github_pat_|AKIA|xox[abprs]-|lumio_)[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(bytes.toString("utf8"))) problems.push(`${entry.path}：疑似包含敏感信息，请先处理`);
        const input = convert(entry, bytes, this.zone());
        if (input.routine?.status === "active") problems.push(`${entry.path}：请先暂停旧例行任务并清空执行器计划缓存`);
        if (input.task && !["done", "cancelled", "paused"].includes(input.task.status) && (Object.hasOwn(fields, "turn") ? fields.turn === "agent" : input.task.assignee !== "human")) problems.push(`${entry.path}：旧文件仍有待派活开关，请先交回 human 或暂停`);
        entries.push(entry); inputs.push(input);
      } catch { problems.push(`${file.relativePath}：元数据、路径或目标格式不合法，未导入`); }
    }
    const projects = new Set(inputs.flatMap((input) => input.project ? [input.project.id] : []));
    for (const input of inputs) if (input.task?.project && !projects.has(input.task.project) && !targetExists(this.db, { ...input.entry, id: input.task.project, type: "project" })) problems.push(`${input.entry.path}：关联的项目不存在`);
    const imported = new Set(entries.map((entry) => entry.id)), jobs = histories(this.db);
    for (const job of jobs) {
      if (!job.result && (job.status !== "cancelled" || job.assigned)) problems.push(`${job.spec.id}：仍在排队、执行或等待结果交回`);
    }
    for (const row of rows(this.db, "task_rounds")) if (imported.has(String(row.task)) && !jobs.some((job) => job.spec.id === row.job)) problems.push(`${row.task}：历史轮次缺少 Job 记录`);
    for (const row of rows(this.db, "task_state")) if (imported.has(String(row.task))) {
      const maximum = Math.max(0, ...jobs.filter((job) => job.spec.source?.task === row.task).map((job) => job.spec.source!.round));
      if (Number(row.rounds) > maximum) problems.push(`${row.task}：轮次计数与历史记录不完整`);
      if (row.pending_since !== null && row.pending_since !== undefined) problems.push(`${row.task}：仍有等待派出的旧请求`);
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return MigrationPlan.parse({ schema_version: 1, id: newId("mig", this.options.now?.() ?? new Date(), randomBytes), created: (this.options.now?.() ?? new Date()).toISOString(), source_hash: sha(JSON.stringify(entries)), entries, problems: [...new Set(problems)].sort() });
  }
  async apply(input: unknown, backup: string, runtimesPrepared: boolean): Promise<MigrationPlan> {
    const parsed = MigrationPlan.safeParse(input);
    if (!parsed.success) throw new StorageError("INVALID", "迁移清单不合法");
    const plan = parsed.data;
    if (plan.problems.length || !runtimesPrepared) throw new StorageError("CONFLICT", "先解决 dry-run 问题，并确认执行器已停止、结果交回和旧计划缓存清理完成");
    const receipt = table(this.db, "migration_receipts") ? this.db.query<{ plan: string }, [string]>("SELECT plan FROM migration_receipts WHERE id=?").get(plan.id) : undefined;
    const inputs: Input[] = [];
    for (const entry of plan.entries) {
      let bytes: Buffer;
      try { bytes = await readFile(await safeStoredFile(this.vault, entry.path)); } catch { throw new StorageError("CONFLICT", "迁移源文件缺失或路径变化，请重新 dry-run"); }
      if (sha(bytes) !== entry.sha256) throw new StorageError("CONFLICT", "迁移源文件已变化，请重新 dry-run");
      inputs.push(convert(entry, bytes, this.zone()));
    }
    if (receipt) { if (receipt.plan !== JSON.stringify(plan)) throw new StorageError("CONFLICT", "迁移编号已用于不同清单"); return plan; }
    const manifest = await verifyBusinessBackup(backup), snapshot = new Sqlite(join(backup, manifest.database.path), { readonly: true });
    let expected: string; try { expected = businessContentHash(snapshot); } finally { snapshot.close(); }
    if (expected !== businessContentHash(this.db)) throw new StorageError("CONFLICT", "备份不是当前业务状态，请先重新完整备份");
    const current = await this.plan();
    if (current.problems.length || current.source_hash !== plan.source_hash || JSON.stringify(current.entries) !== JSON.stringify(plan.entries)) throw new StorageError("CONFLICT", "源文件或业务状态已变化，请重新 dry-run");
    const jobs = histories(this.db), executions = inputs.flatMap((record) => record.task ? jobs.filter((job) => job.spec.source?.task === record.task!.id).map((job) => WorkExecution.parse({ task: record.task!.id, job: job.spec.id, round: job.spec.source!.round, input_revision: 1,
      input_snapshot: job.spec.run.kind === "agent" ? job.spec.run.prompt : JSON.stringify(job.spec.run.argv), created: job.spec.created, applied: true })) : []);
    this.db.transaction(() => {
      if (businessContentHash(this.db) !== expected) throw new StorageError("CONFLICT", "备份之后业务库已变化");
      this.db.exec(`CREATE TABLE IF NOT EXISTS migration_sources (id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,migration TEXT NOT NULL,entry TEXT NOT NULL,bytes BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS migration_receipts (id TEXT PRIMARY KEY,plan TEXT NOT NULL,backup TEXT NOT NULL,applied TEXT NOT NULL);`);
      for (const record of inputs) this.db.query("INSERT INTO migration_sources(id,path,migration,entry,bytes) VALUES(?,?,?,?,?)").run(record.entry.id, record.entry.path, plan.id, JSON.stringify(record.entry), record.bytes);
      const work = new WorkService(new SqliteWorkStore(this.db), { now: () => new Date(), id: () => { throw new StorageError("INTERNAL", "历史导入不生成业务 ID"); } });
      work.importSettled({ projects: inputs.flatMap((record) => record.project ? [record.project] : []), tasks: inputs.flatMap((record) => record.task ? [record.task] : []), executions });
      const routineStore = new SqliteRoutineStore(this.db);
      const routines = new ExecutionRoutines(routineStore, { get: () => { throw new Error(); }, list: () => jobs, record: () => { throw new Error(); } }, {
        now: () => new Date(), id: () => { throw new Error(); }, lease: () => { throw new Error(); }, fingerprint: sha,
        runtimes: () => [], timezone: this.zone(),
      });
      routines.importPaused(inputs.flatMap((record) => record.routine ? [record.routine] : []));
      const ids = new Set(plan.entries.map((entry) => entry.id));
      if (table(this.db, "task_state")) for (const id of ids) this.db.query("UPDATE task_state SET pending_since=NULL WHERE task=?").run(id);
      if (table(this.db, "routine_plans")) for (const id of ids) this.db.query("DELETE FROM routine_plans WHERE routine=?").run(id);
      this.db.query("INSERT INTO migration_receipts(id,plan,backup,applied) VALUES(?,?,?,?)").run(plan.id, JSON.stringify(plan), backup, new Date().toISOString());
    }).immediate();
    return plan;
  }
}

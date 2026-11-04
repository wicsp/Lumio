import { workSystemActor } from "./task-model.ts";
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MigrationPlan, MigrationEntry, Project, Task, Routine, WorkProject, WorkTask, WorkExecution, ExecutionRoutine,
  Job, parseAssignee, textContainsCardNumber } from "@lumio/schema";
import { newId } from "@lumio/foundation";
import { parseFrontmatter } from "@lumio/knowledge";
import { migrateTurn, WorkService } from "@lumio/work";
import { ExecutionRoutines, parseCron, validTimeZone, nextFire } from "@lumio/execution";
import { scanVault } from "./knowledge/vault.ts";
import { SqliteWorkStore } from "./work.ts";
import { SqliteRoutineStore } from "./routines.ts";
import { backupBusiness, verifyBusinessBackup } from "./backup.ts";
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
export interface MigrationReceipt { id: string; kind: "apply" | "retire"; applied: string; backup: string }
export function migrationReceipt(db: Database): MigrationReceipt | undefined {
  if (!table(db, "migration_receipts")) return;
  const row = db.query("SELECT * FROM migration_receipts ORDER BY applied LIMIT 1").get() as Record<string, unknown> | null;
  return row ? { id: String(row.id), kind: row.kind === "retire" ? "retire" : "apply", applied: String(row.applied), backup: String(row.backup) } : undefined;
}
function refuseReceipt(db: Database): void {
  const receipt = migrationReceipt(db);
  if (receipt) throw new StorageError("CONFLICT", { key: "migration.workspace_switched_at_via_cannot_apply_or_retire_again_receipt", args: [receipt.applied, receipt.kind, receipt.id] });
}
function receiptTable(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS migration_receipts (id TEXT PRIMARY KEY,plan TEXT NOT NULL,backup TEXT NOT NULL,applied TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'apply')");
  if (!(db.query("PRAGMA table_info(migration_receipts)").all() as { name: string }[]).some(column => column.name === "kind")) db.exec("ALTER TABLE migration_receipts ADD COLUMN kind TEXT NOT NULL DEFAULT 'apply'");
}
export interface RetirementReceipt extends MigrationReceipt { kind: "retire"; count: number; paths: string[]; path_hash: string }
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
    return { entry, bytes, task: WorkTask.parse({ schema_version: 3, type: "task", id: value.id, title: value.title,
      description, revision: 1, ...migrateTurn({ status: value.status }, value.updated), created: value.created, updated: value.updated,
      tags: value.tags, dependencies: [], references: value.routine ? [{ module: "execution", id: value.routine }] : [],
      project: value.project, due: value.due, workdir: value.workdir, model: value.model, gpus: value.gpus, timeout_minutes: value.timeout_minutes }) };
  }
  const value = Routine.parse(fields), zone = value.timezone ?? timezone;
  if (!validTimeZone(zone) || !nextFire(parseCron(value.schedule), zone, new Date(value.updated))) throw new StorageError("INVALID", { key: "migration.invalid_routine_time_zone_or_cron", args: [] });
  return { entry, bytes, routine: ExecutionRoutine.parse({ schema_version: 2, id: value.id, title: value.title, description, revision: 1,
    status: value.status, schedule: value.schedule, timezone: zone, assignee: owner(value.assignee), context: value.context,
    created: value.created, updated: value.updated, workdir: value.workdir, model: value.model, gpus: value.gpus, timeout_minutes: value.timeout_minutes }) };
}

/** Offline import preserves facts and source bytes; it never invokes a dispatch, executes a job or rewrites a knowledge file. */
export class LegacyMigration {
  private msg(key: string, ...args: unknown[]): string { return this.options.text?.(key, ...args) ?? key.replace(/\$\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])); }
  constructor(private readonly db: Database, private readonly vault: string, private readonly options: { text?: (key: string, ...args: unknown[]) => string; timezone?: string; now?: () => Date } = {}) {}
  private zone() { return this.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone; }
  sources(): MigrationEntry[] { return rows(this.db, "migration_sources").map((row) => MigrationEntry.parse(JSON.parse(String(row.entry)))); }
  source(id: string): { entry: MigrationEntry; bytes: Buffer } {
    const row = table(this.db, "migration_sources") ? this.db.query<{ entry: string; bytes: Uint8Array }, [string]>("SELECT entry,bytes FROM migration_sources WHERE id=?").get(id) : undefined;
    if (!row) throw new StorageError("NOT_FOUND", { key: "migration.migration_source_not_found", args: [] });
    return { entry: MigrationEntry.parse(JSON.parse(row.entry)), bytes: Buffer.from(row.bytes) };
  }
  async plan(): Promise<MigrationPlan> {
    const entries: MigrationEntry[] = [], problems: string[] = [], inputs: Input[] = [], ids = new Set<string>();
    for (const file of await scanVault(this.vault, ["project", "task", "routine"])) {
      if (isMigratedSource(this.db, file.relativePath)) continue;
      try {
        const bytes = await readFile(await safeStoredFile(this.vault, file.relativePath)), fields = parseFrontmatter(bytes).data;
        const entry = MigrationEntry.parse({ id: fields.id, type: file.type, path: file.relativePath, sha256: sha(bytes), title: fields.title });
        if (ids.has(entry.id)) problems.push(this.msg("${0}: duplicate ID", entry.path)); ids.add(entry.id);
        if (targetExists(this.db, entry)) problems.push(this.msg("${0}: ID already exists in database", entry.path));
        if (textContainsCardNumber(bytes.toString("utf8")) || /\b(?:sk-|gh[pousr]_|github_pat_|AKIA|xox[abprs]-|lumio_)[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(bytes.toString("utf8"))) problems.push(this.msg("${0}: possible sensitive information; resolve first", entry.path));
        const input = convert(entry, bytes, this.zone());
        if (input.routine?.status === "active") problems.push(this.msg("${0}: pause legacy routine and clear runtime plan cache first", entry.path));
        if (input.task && !["done", "cancelled", "paused"].includes(String(fields.status ?? "todo")) && (Object.hasOwn(fields, "turn") ? fields.turn === "agent" : owner(Task.parse(fields).assignee) !== "human")) problems.push(this.msg("${0}: legacy file still requests dispatch; return to human or pause first", entry.path));
        entries.push(entry); inputs.push(input);
      } catch { problems.push(this.msg("${0}: invalid metadata, path or target format; not imported", file.relativePath)); }
    }
    const projects = new Set(inputs.flatMap((input) => input.project ? [input.project.id] : []));
    for (const input of inputs) if (input.task?.project && !projects.has(input.task.project) && !targetExists(this.db, { ...input.entry, id: input.task.project, type: "project" })) problems.push(this.msg("${0}: associated project does not exist", input.entry.path));
    const imported = new Set(entries.map((entry) => entry.id)), jobs = histories(this.db);
    for (const job of jobs) {
      if (!job.result && (job.status !== "cancelled" || job.assigned)) problems.push(this.msg("${0}: still queued, running or awaiting result delivery", job.spec.id));
    }
    for (const row of rows(this.db, "task_rounds")) if (imported.has(String(row.task)) && !jobs.some((job) => job.spec.id === row.job)) problems.push(this.msg("${0}: historical round is missing a Job record", row.task));
    for (const row of rows(this.db, "task_state")) if (imported.has(String(row.task))) {
      const maximum = Math.max(0, ...jobs.filter((job) => job.spec.source?.task === row.task).map((job) => job.spec.source!.round));
      if (Number(row.rounds) > maximum) problems.push(this.msg("${0}: round counter and history are incomplete", row.task));
      if (row.pending_since !== null && row.pending_since !== undefined) problems.push(this.msg("${0}: a legacy request is still awaiting dispatch", row.task));
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return MigrationPlan.parse({ schema_version: 1, id: newId("mig", this.options.now?.() ?? new Date(), randomBytes), created: (this.options.now?.() ?? new Date()).toISOString(), source_hash: sha(JSON.stringify(entries)), entries, problems: [...new Set(problems)].sort() });
  }
  /** Caller holds the same exclusive state lease as Hub; backup completes before any receipt is written. */
  async retire(stateDir: string, backup: string): Promise<RetirementReceipt> {
    refuseReceipt(this.db);
    const blocking = () => histories(this.db).filter(job => {
      if (!["queued", "assigned", "running", "waiting_for_human"].includes(job.status)) return false;
      const source = job.spec.source;
      return Boolean((source?.task && (!table(this.db, "work_tasks") || !this.db.query("SELECT 1 FROM work_tasks WHERE id=?").get(source.task)))
        || (source?.routine && (!table(this.db, "execution_routines") || !this.db.query("SELECT 1 FROM execution_routines WHERE id=?").get(source.routine))));
    });
    const active = blocking();
    if (active.length) throw new StorageError("CONFLICT", { key: "migration.unfinished_legacy_note_jobs_remain", args: [active.map(job => `${job.spec.id} (${job.status})`).join(", ")] });
    // Retirement deliberately does not validate import-only metadata, active schedules, or dispatch switches.
    const paths = (await scanVault(this.vault, ["project", "task", "routine"])).map(file => file.relativePath).sort();
    await backupBusiness(stateDir, backup);
    const manifest = await verifyBusinessBackup(backup), snapshot = new Sqlite(join(backup, manifest.database.path), { readonly: true });
    let expected: string; try { expected = businessContentHash(snapshot); } finally { snapshot.close(); }
    const applied = (this.options.now?.() ?? new Date()).toISOString();
    const receipt: RetirementReceipt = { id: newId("mig", new Date(applied), randomBytes), kind: "retire", applied, backup, count: paths.length, paths, path_hash: sha(JSON.stringify(paths)) };
    this.db.transaction(() => {
      refuseReceipt(this.db);
      if (blocking().length || businessContentHash(this.db) !== expected) throw new StorageError("CONFLICT", { key: "migration.business_state_changed_after_backup_not_retired", args: [] });
      receiptTable(this.db);
      this.db.query("INSERT INTO migration_receipts(id,plan,backup,applied,kind) VALUES(?,?,?,?,?)").run(receipt.id, JSON.stringify(receipt), backup, applied, "retire");
    }).immediate();
    return receipt;
  }
  async apply(input: unknown, backup: string, runtimesPrepared: boolean): Promise<MigrationPlan> {
    refuseReceipt(this.db);
    const parsed = MigrationPlan.safeParse(input);
    if (!parsed.success) throw new StorageError("INVALID", { key: "migration.invalid_migration_manifest", args: [] });
    const plan = parsed.data;
    if (plan.problems.length || !runtimesPrepared) throw new StorageError("CONFLICT", { key: "migration.resolve_dry_run_issues_and_confirm_runtimes_stopped_results_delivere", args: [] });
    const inputs: Input[] = [];
    for (const entry of plan.entries) {
      let bytes: Buffer;
      try { bytes = await readFile(await safeStoredFile(this.vault, entry.path)); } catch { throw new StorageError("CONFLICT", { key: "migration.migration_source_missing_or_path_changed_run_dry_run_again", args: [] }); }
      if (sha(bytes) !== entry.sha256) throw new StorageError("CONFLICT", { key: "migration.migration_source_changed_run_dry_run_again", args: [] });
      inputs.push(convert(entry, bytes, this.zone()));
    }
    const manifest = await verifyBusinessBackup(backup), snapshot = new Sqlite(join(backup, manifest.database.path), { readonly: true });
    let expected: string; try { expected = businessContentHash(snapshot); } finally { snapshot.close(); }
    if (expected !== businessContentHash(this.db)) throw new StorageError("CONFLICT", { key: "migration.backup_is_not_the_current_business_state_create_a_new_full_backup", args: [] });
    const current = await this.plan();
    if (current.problems.length || current.source_hash !== plan.source_hash || JSON.stringify(current.entries) !== JSON.stringify(plan.entries)) throw new StorageError("CONFLICT", { key: "migration.source_files_or_business_state_changed_run_dry_run_again", args: [] });
    const jobs = histories(this.db), executions = inputs.flatMap((record) => record.task ? jobs.filter((job) => job.spec.source?.task === record.task!.id).map((job) => WorkExecution.parse({ task: record.task!.id, job: job.spec.id, round: job.spec.source!.round, input_revision: 1,
      input_snapshot: job.spec.run.kind === "agent" ? job.spec.run.prompt : JSON.stringify(job.spec.run.argv), created: job.spec.created, applied: true })) : []);
    this.db.transaction(() => {
      if (businessContentHash(this.db) !== expected) throw new StorageError("CONFLICT", { key: "migration.business_database_changed_after_backup", args: [] });
      refuseReceipt(this.db);
      receiptTable(this.db);
      this.db.exec("CREATE TABLE IF NOT EXISTS migration_sources (id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,migration TEXT NOT NULL,entry TEXT NOT NULL,bytes BLOB NOT NULL)");
      for (const record of inputs) this.db.query("INSERT INTO migration_sources(id,path,migration,entry,bytes) VALUES(?,?,?,?,?)").run(record.entry.id, record.entry.path, plan.id, JSON.stringify(record.entry), record.bytes);
      const work = new WorkService(new SqliteWorkStore(this.db), { systemActor: workSystemActor(this.db).id, now: () => new Date(), id: () => { throw new StorageError("INTERNAL", { key: "migration.historical_import_does_not_generate_business_ids", args: [] }); } });
      for (const record of inputs) if (record.task) {
        const latest = jobs.filter(job => job.spec.source?.task === record.task!.id).sort((a, b) => b.spec.source!.round - a.spec.source!.round)[0];
        const status = Task.parse(parseFrontmatter(record.bytes).data).status;
        record.task = WorkTask.parse({ ...record.task, ...migrateTurn({ status, ...(latest ? { latest: { job: latest.spec.id, round: latest.spec.source!.round, status: latest.status, pending: false } } : {}) }, record.task.updated) });
      }
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

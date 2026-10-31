import type { Database, SQLQueryBindings } from "bun:sqlite";
import { Job, type RuntimeInfo } from "@lumio/schema";
import type { ExecutionStore } from "@lumio/execution";

export class SqliteExecutionStore implements ExecutionStore {
  constructor(private readonly db: Database, private readonly registry: {
    runtimes(now: Date): RuntimeInfo[]; syncRuntime(actor: string, now: Date): void;
  }) {
    db.exec("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,record TEXT NOT NULL,cancel INTEGER NOT NULL DEFAULT 0)");
  }
  transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
  get(id: string): Job | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM jobs WHERE id=?").get(id);
    return row ? Job.parse(JSON.parse(row.record)) : undefined;
  }
  list(filter: { task?: string; routine?: string; status?: string; runtime?: string; open?: boolean } = {}): Job[] {
    const where: string[] = [], parameters: SQLQueryBindings[] = [];
    for (const [field, value] of [["spec.source.task", filter.task], ["spec.source.routine", filter.routine], ["status", filter.status], ["spec.runtime", filter.runtime]] as const) {
      if (value !== undefined) { where.push(`json_extract(record,'$.${field}')=?`); parameters.push(value); }
    }
    if (filter.open) where.push("json_extract(record,'$.result') IS NULL AND NOT(json_extract(record,'$.status')='cancelled' AND json_extract(record,'$.assigned') IS NULL)");
    const order = filter.routine ? "json_extract(record,'$.spec.source.fired_at')" : "rowid";
    return this.db.query<{ record: string }, SQLQueryBindings[]>(`SELECT record FROM jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order}`)
      .all(...parameters).map((row) => Job.parse(JSON.parse(row.record)));
  }
  save(input: Job): void { const job = Job.parse(input); this.db.query("INSERT INTO jobs(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record").run(job.spec.id, JSON.stringify(job)); }
  record(input: Job): void { const job = Job.parse(input); this.db.query("INSERT OR IGNORE INTO jobs(id,record) VALUES(?,?)").run(job.spec.id, JSON.stringify(job)); }
  requestCancel(id: string): void { this.db.query("UPDATE jobs SET cancel=1 WHERE id=?").run(id); }
  cancellations(): string[] { return this.db.query<{ id: string }, []>("SELECT id FROM jobs WHERE cancel=1").all().map((row) => row.id); }
  cancelRequested(id: string): boolean { return !!this.db.query<{ cancel: number }, [string]>("SELECT cancel FROM jobs WHERE id=?").get(id)?.cancel; }
  runtimes(now: Date): RuntimeInfo[] { return this.registry.runtimes(now); }
  syncRuntime(actor: string, now: Date): void { this.registry.syncRuntime(actor, now); }
}

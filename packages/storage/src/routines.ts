import type { Database } from "bun:sqlite";
import { ExecutionRoutine, RoutineSpec } from "@lumio/schema";
import type { ExecutionRoutineStore, RoutinePlanRecord } from "@lumio/execution";

/** Execution owns both current schedules and immutable inputs previously delivered to devices. */
export class SqliteRoutineStore implements ExecutionRoutineStore {
  constructor(private readonly db: Database) {
    db.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS execution_routines (
        id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('active','paused')), schedule TEXT NOT NULL,
        assignee TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE INDEX IF NOT EXISTS execution_routines_status ON execution_routines(status);
      CREATE TABLE IF NOT EXISTS execution_routine_history (
        lease TEXT PRIMARY KEY, routine TEXT NOT NULL REFERENCES execution_routines(id), actor TEXT NOT NULL,
        fingerprint TEXT NOT NULL, spec TEXT NOT NULL CHECK(json_valid(spec)));
      CREATE INDEX IF NOT EXISTS execution_routine_history_routine ON execution_routine_history(routine);
      CREATE TABLE IF NOT EXISTS execution_routine_current (routine TEXT PRIMARY KEY REFERENCES execution_routines(id),
        lease TEXT NOT NULL REFERENCES execution_routine_history(lease));
      CREATE TABLE IF NOT EXISTS execution_routine_requests (actor TEXT NOT NULL, request TEXT NOT NULL, operation TEXT NOT NULL,
        record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(actor,request));
    `))();
  }
  transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
  get(id: string): ExecutionRoutine | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM execution_routines WHERE id=?").get(id);
    return row ? ExecutionRoutine.parse(JSON.parse(row.record)) : undefined;
  }
  list(): ExecutionRoutine[] {
    return this.db.query<{ record: string }, []>("SELECT record FROM execution_routines ORDER BY rowid").all().map((row) => ExecutionRoutine.parse(JSON.parse(row.record)));
  }
  save(input: ExecutionRoutine): void {
    const value = ExecutionRoutine.parse(input);
    this.db.query(`INSERT INTO execution_routines(id,status,schedule,assignee,revision,record) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,schedule=excluded.schedule,assignee=excluded.assignee,revision=excluded.revision,record=excluded.record`)
      .run(value.id, value.status, value.schedule, value.assignee, value.revision, JSON.stringify(value));
  }
  private read(row: { routine: string; actor: string; fingerprint: string; spec: string }): RoutinePlanRecord {
    return { ...row, spec: RoutineSpec.parse(JSON.parse(row.spec)) };
  }
  currentPlan(routine: string): RoutinePlanRecord | undefined {
    const row = this.db.query<{ routine: string; actor: string; fingerprint: string; spec: string }, [string]>(
      `SELECT h.routine,h.actor,h.fingerprint,h.spec FROM execution_routine_history h JOIN execution_routine_current c ON c.lease=h.lease WHERE c.routine=?`).get(routine);
    return row ? this.read(row) : undefined;
  }
  setCurrent(routine: string, plan?: RoutinePlanRecord): void {
    if (!plan) { this.db.query("DELETE FROM execution_routine_current WHERE routine=?").run(routine); return; }
    this.db.query("INSERT INTO execution_routine_current(routine,lease) VALUES(?,?) ON CONFLICT(routine) DO UPDATE SET lease=excluded.lease").run(routine, plan.spec.lease);
  }
  planHistory(routine?: string): RoutinePlanRecord[] {
    const rows = routine === undefined
      ? this.db.query<{ routine: string; actor: string; fingerprint: string; spec: string }, []>("SELECT routine,actor,fingerprint,spec FROM execution_routine_history ORDER BY rowid").all()
      : this.db.query<{ routine: string; actor: string; fingerprint: string; spec: string }, [string]>("SELECT routine,actor,fingerprint,spec FROM execution_routine_history WHERE routine=? ORDER BY rowid").all(routine);
    return rows.map((row) => this.read(row));
  }
  savePlan(plan: RoutinePlanRecord): void {
    const spec = RoutineSpec.parse(plan.spec);
    this.db.query("INSERT INTO execution_routine_history(lease,routine,actor,fingerprint,spec) VALUES(?,?,?,?,?)").run(spec.lease, plan.routine, plan.actor, plan.fingerprint, JSON.stringify(spec));
  }
  receipt(actor: string, request: string): { operation: string; routine: ExecutionRoutine } | undefined {
    const row = this.db.query<{ operation: string; record: string }, [string, string]>("SELECT operation,record FROM execution_routine_requests WHERE actor=? AND request=?").get(actor, request);
    return row ? { operation: row.operation, routine: ExecutionRoutine.parse(JSON.parse(row.record)) } : undefined;
  }
  putReceipt(actor: string, request: string, operation: string, routine: ExecutionRoutine): void {
    this.db.query("INSERT INTO execution_routine_requests(actor,request,operation,record) VALUES(?,?,?,?)").run(actor, request, operation, JSON.stringify(ExecutionRoutine.parse(routine)));
  }
}

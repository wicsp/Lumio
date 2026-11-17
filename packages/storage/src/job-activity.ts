import type { Database } from "bun:sqlite";
import {
  JobAction, JobActionReceipt, JobActivityRecord, JobControlTarget, JobEngineActivityCapability, JobHumanRequest,
  type JobActivitySync,
} from "@lumio/schema";

type ActivityState = {
  sequence: number;
  first: number | null;
  target: JobControlTarget | null;
  pending: JobHumanRequest | null;
};
type ActionRow = { action: JobAction; receipt: JobActionReceipt; owner: string; expires: string };
export class SqliteJobActivity {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_activity_engines(runtime TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_activity_state(job TEXT PRIMARY KEY, sequence INTEGER NOT NULL, first INTEGER, target TEXT, pending TEXT);
      CREATE TABLE IF NOT EXISTS job_activity_events(job TEXT NOT NULL, sequence INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(job,sequence));
      CREATE TABLE IF NOT EXISTS job_activity_actions(job TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, action TEXT NOT NULL,
        receipt TEXT NOT NULL, expires TEXT NOT NULL, PRIMARY KEY(job,id));
    `);
  }
  engines(runtime: string) {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM job_activity_engines WHERE runtime=?").get(runtime);
    return row ? JobEngineActivityCapability.array().parse(JSON.parse(row.record)) : [];
  }
  register(runtime: string, input: Extract<JobActivitySync, { type: "register" }>) {
    this.db.query("INSERT OR REPLACE INTO job_activity_engines VALUES (?,?)").run(runtime, JSON.stringify(input.engines));
  }
  forget(runtime: string) {
    this.db.query("DELETE FROM job_activity_engines WHERE runtime=?").run(runtime);
  }
  state(job: string): ActivityState {
    const row = this.db.query<{ sequence: number; first: number | null; target: string | null; pending: string | null }, [string]>(
      "SELECT sequence,first,target,pending FROM job_activity_state WHERE job=?",
    ).get(job);
    return row
      ? { sequence: row.sequence, first: row.first, target: row.target ? JobControlTarget.parse(JSON.parse(row.target)) : null,
          pending: row.pending ? JobHumanRequest.parse(JSON.parse(row.pending)) : null }
      : { sequence: 0, first: null, target: null, pending: null };
  }
  save(job: string, state: ActivityState) {
    this.db.query("INSERT OR REPLACE INTO job_activity_state VALUES (?,?,?,?,?)").run(
      job, state.sequence, state.first, state.target ? JSON.stringify(state.target) : null, state.pending ? JSON.stringify(state.pending) : null,
    );
  }
  events(job: string, after = 0, limit = 4096) {
    return this.db.query<{ record: string }, [string, number, number]>(
      "SELECT record FROM job_activity_events WHERE job=? AND sequence>? ORDER BY sequence LIMIT ?",
    ).all(job, after, limit).map(row => JobActivityRecord.parse(JSON.parse(row.record)));
  }
  event(job: string, sequence: number) {
    return this.db.query<{ record: string }, [string, number]>(
      "SELECT record FROM job_activity_events WHERE job=? AND sequence=?",
    ).get(job, sequence)?.record;
  }
  append(job: string, record: JobActivityRecord) {
    this.db.query("INSERT INTO job_activity_events VALUES (?,?,?)").run(job, record.sequence, JSON.stringify(record));
  }
  seal(job: string) {
    this.db.query("UPDATE job_activity_state SET target=NULL, pending=NULL WHERE job=?").run(job);
  }
  pendingJobs() {
    return this.db.query<{ job: string }, []>("SELECT job FROM job_activity_state WHERE pending IS NOT NULL LIMIT 100").all().map(row => row.job);
  }
  actions(job: string, limit = 256): ActionRow[] {
    return this.db.query<{ owner: string; action: string; receipt: string; expires: string }, [string, number]>(
      "SELECT owner,action,receipt,expires FROM job_activity_actions WHERE job=? ORDER BY rowid DESC LIMIT ?",
    ).all(job, limit).map(row => this.decode(row));
  }
  action(job: string, id: string): ActionRow | undefined {
    const row = this.db.query<{ owner: string; action: string; receipt: string; expires: string }, [string, string]>(
      "SELECT owner,action,receipt,expires FROM job_activity_actions WHERE job=? AND id=?",
    ).get(job, id);
    return row ? this.decode(row) : undefined;
  }
  private decode(row: { owner: string; action: string; receipt: string; expires: string }): ActionRow {
    return { ...row, action: JobAction.parse(JSON.parse(row.action)), receipt: JobActionReceipt.parse(JSON.parse(row.receipt)) };
  }
  addAction(job: string, row: ActionRow) {
    this.db.query("INSERT INTO job_activity_actions VALUES (?,?,?,?,?,?)").run(
      job, row.action.request_id, row.owner, JSON.stringify(row.action), JSON.stringify(row.receipt), row.expires,
    );
  }
  updateAction(job: string, receipt: JobActionReceipt) {
    this.db.query("UPDATE job_activity_actions SET receipt=? WHERE job=? AND id=?").run(JSON.stringify(receipt), job, receipt.request_id);
  }
  prune(before: string) {
    this.db.transaction(() => {
      this.db.query(`
        UPDATE job_activity_state SET first=NULL, target=NULL, pending=NULL WHERE first IS NOT NULL
        AND job IN (SELECT id FROM jobs WHERE json_extract(record,'$.result.finished')<?)
      `).run(before);
      this.db.query("DELETE FROM job_activity_events WHERE job IN (SELECT job FROM job_activity_state WHERE first IS NULL)").run();
      this.db.query("DELETE FROM job_activity_actions WHERE expires<?").run(before);
    })();
  }
}

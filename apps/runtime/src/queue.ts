import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { JobResult, JobSpec, RuntimeHeartbeat } from "@lumio/schema";
import { RuntimeError } from "./config.ts";

export type LocalJob = { spec: JobSpec; state: "queued" | "running" | "finished"; acked: number; pid: number | null; started: string | null };
export class Queue {
  readonly db: Database;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "runtime.sqlite");
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, spec TEXT NOT NULL, state TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, pid INTEGER, started TEXT);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY REFERENCES queue(id), result TEXT NOT NULL);`);
  }
  jobs(): LocalJob[] {
    return this.db.query<{ spec: string; state: LocalJob["state"]; acked: number; pid: number | null; started: string | null }, []>("SELECT * FROM queue ORDER BY rowid").all()
      .map((r) => ({ ...r, spec: JobSpec.parse(JSON.parse(r.spec)) }));
  }
  receive(specs: JobSpec[]) {
    this.db.transaction(() => {
      for (const spec of specs) {
        const existing = this.jobs().find((j) => j.spec.id === spec.id);
        if (existing && JSON.stringify(existing.spec) !== JSON.stringify(spec)) throw new RuntimeError("Hub 重发了不同的 Job");
        this.db.query("INSERT OR IGNORE INTO queue(id,spec,state) VALUES (?,?,'queued')").run(spec.id, JSON.stringify(spec));
      }
    })();
  }
  ack(ids: string[]) { this.db.transaction(() => { for (const id of ids) this.db.query("UPDATE queue SET acked=1 WHERE id=?").run(id); })(); }
  start(id: string, started: string) { this.db.query("UPDATE queue SET state='running', started=? WHERE id=?").run(started, id); }
  pid(id: string, pid: number) { this.db.query("UPDATE queue SET pid=? WHERE id=?").run(pid, id); }
  finish(result: JobResult) {
    const parsed = JobResult.parse(result);
    this.db.transaction(() => {
      this.db.query("INSERT INTO outbox VALUES (?,?)").run(parsed.job, JSON.stringify(parsed));
      this.db.query("UPDATE queue SET state='finished',pid=NULL WHERE id=?").run(parsed.job);
    })();
  }
  outbox(): JobResult[] { return this.db.query<{ result: string }, []>("SELECT result FROM outbox ORDER BY rowid").all().map((r) => JobResult.parse(JSON.parse(r.result))); }
  delivered(id: string) { this.db.query("DELETE FROM outbox WHERE id=?").run(id); }
  heartbeat() { const jobs = this.jobs(); return RuntimeHeartbeat.parse({ running: jobs.filter((j) => j.state === "running").map((j) => j.spec.id), queued: jobs.filter((j) => j.state === "queued").map((j) => j.spec.id), outbox: this.outbox().length }); }
  close() { this.db.close(); }
}

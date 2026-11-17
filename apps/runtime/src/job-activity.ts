import { JOB_ACTIVITY_BATCH, JOB_ACTIVITY_MAX_BODY, JobActivityAck, JobActivityRecord, JobActionReceipt,
  type JobAction, type JobHumanRequest, type JobControlTarget, type JobEngineActivityCapability, type JobActivitySync, type JobSpec } from "@lumio/schema";
import type { LocalJob, Queue } from "./queue.ts";
import type { JobActivityPayload } from "./job-output.ts";

const PATH = "/v1/runtime/job-activity/sync";
const ordinaryLimit = 2048, eventLimit = 4096;
type Control = { target: JobControlTarget | null; pending: JobHumanRequest | null; apply: (action: JobAction) => Promise<JobActionReceipt["state"]>; cancel: () => void };
export class RuntimeJobActivity {
  private enabled = false;
  private readonly controls = new Map<string, Control>();
  private readonly active = new Set<string>();
  private readonly retry = new Map<string, number>();
  constructor(private readonly queue: Queue, private readonly send: (path: string, body: unknown) => Promise<Response>) {
    queue.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_local_meta(job TEXT PRIMARY KEY, sequence INTEGER NOT NULL, ordinary INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_local_events(job TEXT NOT NULL, sequence INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(job,sequence));
      CREATE TABLE IF NOT EXISTS activity_local_receipts(job TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job,id));
    `);
  }
  async register(engines: JobEngineActivityCapability[]) {
    this.enabled = false;
    const reply = await this.send(PATH, { type: "register", platform: process.platform, engines });
    if (!reply.ok || JobActivityAck.parse(await reply.json()).type !== "registered") return;
    this.enabled = true;
  }
  disable() { this.enabled = false; }
  supported() { return this.enabled; }
  async authorized(spec: JobSpec): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const response = await this.send(PATH, { type: "job", job: spec.id, lease: spec.lease, events: [], receipts: [], authorization_check: true });
      if (!response.ok) return false;
      const ack = JobActivityAck.parse(await response.json());
      return ack.type === "job" && !ack.conflict && !ack.cancel;
    } catch { return false; }
  }
  begin(job: string) { this.active.add(job); }
  end(job: string) { this.active.delete(job); this.controls.delete(job); }
  control(job: string, state: Control) { this.controls.set(job, state); }
  record(job: string, payload: JobActivityPayload) {
    if (!this.enabled && !this.active.has(job)) return;
    try {
      this.queue.db.transaction(() => {
        const row = this.queue.db.query<{ sequence: number; ordinary: number }, [string]>(
          "SELECT sequence,ordinary FROM activity_local_meta WHERE job=?",
        ).get(job) ?? { sequence: 0, ordinary: 0 };
        const ordinary = !["phase", "request_opened", "request_closed"].includes(payload.type);
        if ((ordinary && row.ordinary > ordinaryLimit) || row.sequence >= eventLimit) return;
        const record = JobActivityRecord.safeParse({ sequence: row.sequence + 1, event: {
          ...(ordinary && row.ordinary === ordinaryLimit ? { type: "omitted" } : payload), at: new Date().toISOString(),
        } });
        if (!record.success) return;
        this.queue.db.query("INSERT OR REPLACE INTO activity_local_meta VALUES (?,?,?)")
          .run(job, record.data.sequence, row.ordinary + Number(ordinary));
        this.queue.db.query("INSERT INTO activity_local_events VALUES (?,?,?)").run(job, record.data.sequence, JSON.stringify(record.data));
      })();
    } catch { /* Telemetry must not stop the job. */ }
  }
  private receipt(job: string, id: string) {
    const row = this.queue.db.query<{ record: string }, [string, string]>("SELECT record FROM activity_local_receipts WHERE job=? AND id=?").get(job, id);
    return row && JobActionReceipt.parse(JSON.parse(row.record));
  }
  private putReceipt(job: string, request_id: string, state: JobActionReceipt["state"]) {
    this.queue.db.query("INSERT OR REPLACE INTO activity_local_receipts VALUES (?,?,?,0)")
      .run(job, request_id, JSON.stringify(JobActionReceipt.parse({ request_id, state, at: new Date().toISOString() })));
  }
  private async apply(job: string, control: Control, action: JobAction) {
    const prior = this.receipt(job, action.request_id);
    if (prior) return;
    // Commit a conservative receipt before attempting an external action.
    this.putReceipt(job, action.request_id, "unknown");
    const target = control.target, prompt = control.pending;
    const bound = target && target.instance === action.target.instance && target.session === action.target.session && target.turn === action.target.turn;
    let state: JobActionReceipt["state"] = "rejected";
    if (bound) {
      if ("prompt_id" in action && (!prompt || prompt.id !== action.prompt_id)) state = "rejected";
      else if ("prompt_id" in action && Date.parse(prompt!.expires) <= Date.now()) state = "expired";
      else {
        try { state = await control.apply(action); } catch { state = "unknown"; }
      }
    }
    this.putReceipt(job, action.request_id, state);
  }
  private async sync(job: LocalJob) {
    const id = job.spec.id, db = this.queue.db;
    if (!job.acked || (this.retry.get(id) ?? 0) > Date.now()) return;
    const cap = this.controls.get(id);
    const events = db.query<{ record: string }, [string, number]>(
      "SELECT record FROM activity_local_events WHERE job=? ORDER BY sequence LIMIT ?",
    ).all(id, JOB_ACTIVITY_BATCH).map(row => JobActivityRecord.parse(JSON.parse(row.record)));
    const receipts = db.query<{ record: string }, [string, number]>(
      "SELECT record FROM activity_local_receipts WHERE job=? AND confirmed=0 LIMIT ?",
    ).all(id, JOB_ACTIVITY_BATCH).map(row => JobActionReceipt.parse(JSON.parse(row.record)));
    if (!cap && !events.length && !receipts.length) return;
    const input: Extract<JobActivitySync, { type: "job" }> = { type: "job", job: id, lease: job.spec.lease, events, receipts,
      ...(cap ? { target: cap.target, pending: cap.pending } : {}) };
    while (Buffer.byteLength(JSON.stringify(input)) > JOB_ACTIVITY_MAX_BODY && input.events.length > 1) input.events.pop();
    try {
      const response = await this.send(PATH, input);
      if (!response.ok) { this.retry.set(id, Date.now() + 5000); return; }
      const ack = JobActivityAck.parse(await response.json());
      if (ack.type !== "job" || ack.conflict) return;
      this.retry.delete(id);
      db.transaction(() => {
        db.query("DELETE FROM activity_local_events WHERE job=? AND sequence<=?").run(id, ack.acknowledged);
        for (const receipt of ack.receipts) db.query("UPDATE activity_local_receipts SET confirmed=1 WHERE job=? AND id=?").run(id, receipt.request_id);
      })();
      if (cap && this.controls.get(id) === cap) {
        if (ack.cancel) cap.cancel();
        else for (const action of ack.actions) await this.apply(id, cap, action);
      }
    } catch { this.retry.set(id, Date.now() + 2000); }
  }
  async run(signal: AbortSignal, wait: (ms: number, signal: AbortSignal) => Promise<void>) {
    while (!signal.aborted) {
      if (this.enabled) {
        const ids = new Set(this.queue.db.query<{ job: string }, []>(`
          SELECT DISTINCT job FROM activity_local_events
          UNION SELECT DISTINCT job FROM activity_local_receipts WHERE confirmed=0
        `).all().map(row => row.job));
        for (const id of this.active) ids.add(id);
        const batches = this.queue.jobs().filter(job => ids.has(job.spec.id));
        for (let i = 0; i < batches.length; i += 8) {
          if (signal.aborted) break;
          await Promise.all(batches.slice(i, i + 8).map(job => this.sync(job)));
        }
      }
      await wait(750, signal);
    }
  }
}

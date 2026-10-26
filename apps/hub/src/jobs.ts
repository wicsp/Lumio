import { randomBytes } from "node:crypto";
import { newId } from "@lumio/core";
import { JOB_PROTOCOL_VERSION, CommandRun, Job, JobResult, JobSpec, JobStatus, RuntimeName, RuntimeSync, type RuntimeHeartbeat } from "@lumio/schema";
import type { HubStore, Identity } from "./store.ts";
import type { authorize } from "./authorize.ts";
import { HubError } from "./errors.ts";

// Request fields are derived from the approved JobSpec, with the human-facing runtime name.
export const SubmitJob = JobSpec.omit({ protocol_version: true, id: true, source: true, lease: true, created: true }).extend({
  runtime: RuntimeName, run: CommandRun, workdir: JobSpec.shape.workdir.default("~"),
  timeout_seconds: JobSpec.shape.timeout_seconds.default(7200),
});
const active = (job: Job) => job.status === "assigned" || job.status === "running";
export class Jobs {
  constructor(private store: HubStore) {}
  get(id: string): Job {
    const row = this.store.db.query<{ record: string }, [string]>("SELECT record FROM jobs WHERE id=?").get(id);
    if (!row) throw new HubError("NOT_FOUND", "Job 不存在");
    return Job.parse(JSON.parse(row.record));
  }
  list(status?: string): Job[] {
    return this.store.db.query<{ record: string }, []>("SELECT record FROM jobs ORDER BY rowid").all()
      .map((row) => Job.parse(JSON.parse(row.record))).filter((job) => status === undefined || job.status === status);
  }
  private save(job: Job) {
    this.store.db.query("INSERT INTO jobs(id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record")
      .run(job.spec.id, JSON.stringify(Job.parse(job)));
  }
  submit(body: unknown, now: Date): Job {
    const input = SubmitJob.safeParse(body);
    if (!input.success) throw new HubError("INVALID", "Job 提交内容不合法");
    const runtime = this.store.runtimes(now).find((r) => r.registration.name === input.data.runtime);
    if (!runtime) throw new HubError("INVALID", "指定的执行器不存在");
    const job = Job.parse({ spec: { ...input.data, runtime: runtime.actor, protocol_version: JOB_PROTOCOL_VERSION,
      id: newId("job", now, randomBytes), lease: randomBytes(32).toString("base64url"), created: now.toISOString() }, status: "queued" });
    this.save(job); return job;
  }
  cancel(id: string): Job {
    return this.store.db.transaction(() => {
      const job = this.get(id);
      if (job.status === "queued") { job.status = "cancelled"; this.save(job); }
      else if (active(job)) this.store.db.query("UPDATE jobs SET cancel=1 WHERE id=?").run(id);
      return job;
    })();
  }
  ack(actor: string, ids: string[], now: Date): void {
    this.store.db.transaction(() => {
      const jobs = ids.map((id) => this.owned(actor, id));
      for (const job of jobs) if (!job.result && !job.assigned) {
        job.assigned = now.toISOString();
        if (job.status === "queued") job.status = "assigned";
        this.save(job);
      }
    })();
  }
  private owned(actor: string, id: string): Job {
    let job: Job;
    try { job = this.get(id); } catch { throw new HubError("CONFLICT", "Job 与执行器不匹配"); }
    if (job.spec.runtime !== actor) throw new HubError("CONFLICT", "Job 与执行器不匹配");
    return job;
  }
  result(actor: string, result: JobResult): void {
    this.store.db.transaction(() => {
      const job = this.owned(actor, result.job);
      if (job.spec.lease !== result.lease || !job.assigned || (job.status === "cancelled" && result.status !== "cancelled")) throw new HubError("CONFLICT", "Job lease 或指派状态不匹配");
      if (job.result) {
        if (JSON.stringify(job.result) !== JSON.stringify(result)) throw new HubError("CONFLICT", "Job 已有不同的结果");
        return;
      }
      job.result = result; job.status = result.status; this.save(job);
    })();
  }
  /** 这个执行器名下还没有结果的 Job。只查需要的行，不随历史 Job 增多而变慢（P2-2 review）。 */
  private open(actor: string): Job[] {
    return this.store.db.query<{ record: string }, [string]>(
      `SELECT record FROM jobs WHERE json_extract(record, '$.spec.runtime') = ? AND json_extract(record, '$.result') IS NULL
       AND NOT (json_extract(record, '$.status') = 'cancelled' AND json_extract(record, '$.assigned') IS NULL) ORDER BY rowid`,
    ).all(actor).map((row) => Job.parse(JSON.parse(row.record)));
  }
  sync(actor: string, heartbeat: RuntimeHeartbeat, now: Date): RuntimeSync {
    return this.store.db.transaction(() => {
      this.store.syncRuntime(actor, now);
      const running = new Set(heartbeat.running);
      for (const job of this.open(actor)) {
        if (running.has(job.spec.id) && active(job)) { job.status = "running"; job.last_seen = now.toISOString(); this.save(job); }
      }
      const jobs = this.open(actor);
      const cancelled = new Set(this.store.db.query<{ id: string }, []>("SELECT id FROM jobs WHERE cancel=1").all().map((r) => r.id));
      return RuntimeSync.parse({ jobs: jobs.filter((j) => j.status === "queued").map((j) => j.spec),
        cancel: jobs.filter((j) => !j.result && j.assigned && (cancelled.has(j.spec.id) || j.status === "cancelled")).map((j) => j.spec.id), routines: [] });
    })();
  }
}

export async function handleJobs(request: Request, operation: "job.submit" | "jobs" | "job.show" | "job.cancel",
  id: string | undefined, identity: Identity, store: HubStore, decide: typeof authorize, now: Date): Promise<Response> {
  const decision = decide(identity.actor, { operation });
  let execution = "applied";
  try {
    if (decision.result !== "allow") throw new HubError("FORBIDDEN", "请求未获授权", { reason: decision.result === "deny" ? decision.reason : "Approval required" });
    const jobs = new Jobs(store);
    if (operation === "job.submit") {
      let body: unknown; try { body = await request.json(); } catch { throw new HubError("INVALID", "请求体必须是 JSON"); }
      return Response.json(jobs.submit(body, now));
    }
    if (operation === "jobs") {
      const status = new URL(request.url).searchParams.get("status");
      if (status !== null && !JobStatus.safeParse(status).success) throw new HubError("INVALID", "Job 状态不合法");
      return Response.json(jobs.list(status ?? undefined));
    }
    return Response.json(operation === "job.cancel" ? jobs.cancel(id!) : jobs.get(id!));
  } catch (cause) { execution = cause instanceof HubError ? cause.code : "INTERNAL"; throw cause; }
  finally {
    if (operation === "job.submit" || operation === "job.cancel" || decision.result !== "allow" || execution !== "applied")
      store.audit(identity, operation, decision.result, undefined, execution);
  }
}

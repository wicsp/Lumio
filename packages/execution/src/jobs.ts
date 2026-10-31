import { JOB_PROTOCOL_VERSION, Job, JobResult, JobRun, JobSpec, RuntimeName, RuntimeSync,
  type RoutineSpec, type RuntimeInfo, type RuntimeHeartbeat, type ApiErrorCode, type ApiError } from "@lumio/schema";

export class ExecutionError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string, public readonly details: Omit<ApiError["error"], "code" | "message"> = {}) {
    super(message); this.name = "ExecutionError";
  }
}
export interface ExecutionStore {
  get(id: string): Job | undefined;
  list(filter?: { task?: string; routine?: string; status?: string; runtime?: string; open?: boolean }): Job[];
  save(job: Job): void;
  record(job: Job): void;
  requestCancel(id: string): void;
  cancellations(): string[];
  cancelRequested(id: string): boolean;
  runtimes(now: Date): RuntimeInfo[];
  syncRuntime(actor: string, now: Date): void;
  transaction<T>(action: () => T): T;
}
export interface RoutineHooks { plans(actor: string): RoutineSpec[]; adopt(actor: string, id: string, now: Date, lease?: string): Job | undefined }
export interface ExecutionContext { id(now: Date): string; lease(): string; now(): Date }
export const SubmitJob = JobSpec.omit({ protocol_version: true, id: true, source: true, lease: true, created: true }).extend({
  runtime: RuntimeName, run: JobRun, workdir: JobSpec.shape.workdir.default("~"), timeout_seconds: JobSpec.shape.timeout_seconds.default(7200),
});
const active = (job: Job) => job.status === "assigned" || job.status === "running";

/** Job lifecycle is independent of Task, Markdown and SQLite; storage and runtime capabilities are injected. */
export class ExecutionJobs {
  constructor(private readonly store: ExecutionStore, private readonly context: ExecutionContext, private readonly routines?: RoutineHooks) {}
  get(id: string): Job {
    const value = this.store.get(id);
    if (!value) throw new ExecutionError("NOT_FOUND", "Job 不存在");
    return Job.parse(value);
  }
  list(status?: string, task?: string, routine?: string): Job[] { return Job.array().parse(this.store.list({ status, task, routine: task ? undefined : routine })); }
  activeForTask(task: string): Job | undefined { return this.list(undefined, task).find((job) => !job.result && job.status !== "cancelled"); }
  create(fields: { runtime: string; run: JobSpec["run"]; workdir: string; gpus?: number[]; timeout_seconds: number; source?: JobSpec["source"] }, now: Date): Job {
    const job = Job.parse({ spec: { ...fields, protocol_version: JOB_PROTOCOL_VERSION, id: this.context.id(now), lease: this.context.lease(), created: now.toISOString() }, status: "queued" });
    this.store.save(job); return job;
  }
  record(job: Job): void { this.store.record(Job.parse(job)); }
  /** A fact query for approval adapters; requesting cancellation already invalidates permission to start privileged work. */
  live(actor: string, id: string): boolean {
    const job = this.store.get(id);
    return !!job && job.spec.runtime === actor && !!job.assigned && !job.result && active(job) && !this.store.cancelRequested(id);
  }
  submit(body: unknown, now: Date): Job {
    const parsed = SubmitJob.safeParse(body);
    if (!parsed.success) throw new ExecutionError("INVALID", "Job 提交内容不合法");
    const runtime = this.store.runtimes(now).find((value) => value.registration.name === parsed.data.runtime);
    if (!runtime) throw new ExecutionError("INVALID", "指定的执行器不存在");
    const run = parsed.data.run;
    if (run.kind === "agent" && !runtime.registration.engines.some((engine) => engine.name === run.engine)) throw new ExecutionError("INVALID", `执行器 ${parsed.data.runtime} 上没有登记 ${run.engine}`);
    return this.create({ ...parsed.data, runtime: runtime.actor }, now);
  }
  cancel(id: string): Job {
    return this.store.transaction(() => {
      const job = this.get(id);
      if (job.status === "queued") this.store.save({ ...job, status: "cancelled" });
      else if (active(job)) this.store.requestCancel(id);
      return this.get(id);
    });
  }
  private owned(actor: string, id: string, now = this.context.now(), lease?: string): Job {
    let job = this.store.get(id);
    if (!job) job = this.routines?.adopt(actor, id, now, lease);
    if (!job || job.spec.runtime !== actor) throw new ExecutionError("CONFLICT", "Job 与执行器不匹配");
    return Job.parse(job);
  }
  ack(actor: string, ids: string[], now: Date): void {
    this.store.transaction(() => {
      const jobs = ids.map((id) => this.owned(actor, id, now));
      for (const job of jobs) if (!job.result && !job.assigned) this.store.save({ ...job, assigned: now.toISOString(), status: job.status === "queued" ? "assigned" : job.status });
    });
  }
  result(actor: string, input: JobResult): void {
    const result = JobResult.parse(input);
    this.store.transaction(() => {
      const job = this.owned(actor, result.job, this.context.now(), result.lease);
      if (job.spec.lease !== result.lease || !job.assigned || (job.status === "cancelled" && result.status !== "cancelled")) throw new ExecutionError("CONFLICT", "Job lease 或指派状态不匹配");
      if (job.result) {
        if (JSON.stringify(job.result) !== JSON.stringify(result)) throw new ExecutionError("CONFLICT", "Job 已有不同的结果");
        return;
      }
      this.store.save({ ...job, result, status: result.status });
    });
  }
  sync(actor: string, heartbeat: RuntimeHeartbeat, now: Date): RuntimeSync {
    return this.store.transaction(() => {
      this.store.syncRuntime(actor, now);
      for (const id of [...heartbeat.running, ...heartbeat.queued]) if (!this.store.get(id)) this.routines?.adopt(actor, id, now);
      const running = new Set(heartbeat.running);
      for (const job of this.store.list({ runtime: actor, open: true })) if (running.has(job.spec.id) && active(job)) this.store.save({ ...job, status: "running", last_seen: now.toISOString() });
      const jobs = this.store.list({ runtime: actor, open: true }), cancellations = new Set(this.store.cancellations());
      return RuntimeSync.parse({ jobs: jobs.filter((job) => job.status === "queued").map((job) => job.spec),
        cancel: jobs.filter((job) => !job.result && job.assigned && (cancellations.has(job.spec.id) || job.status === "cancelled")).map((job) => job.spec.id),
        routines: this.routines?.plans(actor) ?? [] });
    });
  }
}

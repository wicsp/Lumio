import { JOB_PROTOCOL_VERSION, Job, JobResult, JobSpec, RuntimeSync, SubmitJob,
  type RoutineSpec, type RuntimeInfo, type RuntimeHeartbeat } from "@lumio/schema";
import { ExecutionError } from "./errors.ts";
export { ExecutionError } from "./errors.ts";

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
export interface RoutineHooks { plans(actor: string): RoutineSpec[]; adopt(actor: string, id: string, now: Date, lease?: string, offer?: boolean): Job | undefined }
export interface ExecutionContext { id(now: Date): string; lease(): string; now(): Date }
export { SubmitJob };
export interface JobAdmission {
  eligible(job: Job): boolean;
  project(job: Job): string | undefined;
  limit(project: string): number;
  quota?(job: Job): boolean;
  managedRoutines?: boolean;
}
const active = (job: Job) => job.status === "assigned" || job.status === "running";

/** Job lifecycle is independent of Task, Markdown and SQLite; storage and runtime capabilities are injected. */
export class ExecutionJobs {
  constructor(private readonly store: ExecutionStore, private readonly context: ExecutionContext, private readonly routines?: RoutineHooks) {}
  get(id: string): Job {
    const value = this.store.get(id);
    if (!value) throw new ExecutionError("NOT_FOUND", { key: "jobs.job_not_found", args: [] });
    return Job.parse(value);
  }
  list(status?: string, task?: string, routine?: string): Job[] { return Job.array().parse(this.store.list({ status, task, routine: task ? undefined : routine })); }
  activeForTask(task: string): Job | undefined { return this.list(undefined, task).find((job) => !job.result && job.status !== "cancelled"); }
  create(fields: { runtime: string; run: JobSpec["run"]; workdir: string; gpus?: number[]; timeout_seconds: number; source?: JobSpec["source"]; worktree?: JobSpec["worktree"]; project?: string | null }, now: Date): Job {
    const { project, ...spec } = fields;
    const job = Job.parse({ project, spec: { ...spec, protocol_version: JOB_PROTOCOL_VERSION, id: this.context.id(now), lease: this.context.lease(), created: now.toISOString() }, status: "queued" });
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
    if (!parsed.success) throw new ExecutionError("INVALID", { key: "jobs.invalid_job_submission", args: [] });
    const runtime = this.store.runtimes(now).find((value) => value.registration.name === parsed.data.runtime);
    if (!runtime) throw new ExecutionError("INVALID", { key: "jobs.specified_runtime_does_not_exist", args: [] });
    const run = parsed.data.run;
    if (run.kind === "agent" && !runtime.registration.engines.some((engine) => engine.name === run.engine)) throw new ExecutionError("INVALID", { key: "tasks.is_not_registered_on_runtime", args: [parsed.data.runtime, run.engine] });
    const { connection: _connection, ...fields } = parsed.data;
    return this.create({ ...fields, runtime: runtime.actor }, now);
  }
  cancel(id: string): Job {
    return this.store.transaction(() => {
      const job = this.get(id);
      if (job.status === "queued" && !job.admitted) this.store.save({ ...job, status: "cancelled" });
      else if (active(job) || job.admitted && !job.result) this.store.requestCancel(id);
      return this.get(id);
    });
  }
  private owned(actor: string, id: string, now = this.context.now(), lease?: string): Job {
    let job = this.store.get(id);
    if (!job) job = this.routines?.adopt(actor, id, now, lease);
    if (!job || job.spec.runtime !== actor) throw new ExecutionError("CONFLICT", { key: "jobs.job_does_not_match_runtime", args: [] });
    return Job.parse(job);
  }
  ack(actor: string, ids: string[], now: Date): void {
    this.store.transaction(() => {
      const jobs = ids.map((id) => this.owned(actor, id, now));
      if (jobs.some(job => job.project && job.status === "queued" && !job.admitted)) {
        throw new ExecutionError("CONFLICT", { key: "jobs.job_does_not_match_runtime", args: [] });
      }
      for (const job of jobs) if (!job.result && !job.assigned) this.store.save({ ...job, assigned: now.toISOString(), status: job.status === "queued" ? "assigned" : job.status });
    });
  }
  result(actor: string, input: JobResult): void {
    const result = JobResult.parse(input);
    this.store.transaction(() => {
      const job = this.owned(actor, result.job, this.context.now(), result.lease);
      if (job.spec.lease !== result.lease || !job.assigned || (job.status === "cancelled" && result.status !== "cancelled")) throw new ExecutionError("CONFLICT", { key: "jobs.job_lease_or_assignment_status_does_not_match", args: [] });
      if (job.result) {
        if (JSON.stringify(job.result) !== JSON.stringify(result)) throw new ExecutionError("CONFLICT", { key: "jobs.job_already_has_a_different_result", args: [] });
        return;
      }
      this.store.save({ ...job, result, status: result.status });
    });
  }
  sync(actor: string, heartbeat: RuntimeHeartbeat, now: Date, admission?: JobAdmission): RuntimeSync {
    return this.store.transaction(() => {
      this.store.syncRuntime(actor, now);
      if (admission?.managedRoutines) {
        for (const offer of heartbeat.routine_offers ?? []) {
          if (!this.store.get(offer.job)) this.routines?.adopt(actor, offer.job, now, offer.lease, true);
        }
      } else {
        for (const id of [...heartbeat.running, ...heartbeat.queued]) if (!this.store.get(id)) this.routines?.adopt(actor, id, now);
      }
      const running = new Set(heartbeat.running);
      for (const job of this.store.list({ runtime: actor, open: true })) if (running.has(job.spec.id) && active(job)) this.store.save({ ...job, status: "running", last_seen: now.toISOString() });
      const jobs = this.store.list({ runtime: actor, open: true }), cancellations = new Set(this.store.cancellations());
      const runtime = this.store.runtimes(now).find(value => value.actor === actor);
      const counts = new Map<string, number>();
      if (admission) for (const item of this.store.list({ open: true })) {
        if (!item.admitted && !active(item)) continue;
        const project = admission.project(item);
        if (project) counts.set(project, (counts.get(project) ?? 0) + 1);
      }
      const deliver = jobs.filter(job => {
        if (job.status !== "queued" || admission && !admission.eligible(job)) return false;
        if (job.admitted) return true;
        if (runtime && runtimeDraining(runtime)) return false;
        const project = admission?.project(job);
        const count = project ? counts.get(project) ?? 0 : 0;
        if (admission && project && count >= admission.limit(project)) return false;
        const limited = job.spec.run.kind === "agent" && admission?.quota;
        if (limited && !limited(job)) return false;
        if (project || limited) this.store.save({ ...job, ...(project ? { project } : {}), admitted: now.toISOString() });
        if (project) counts.set(project, count + 1);
        return true;
      });
      return RuntimeSync.parse({ jobs: deliver.map(job => job.spec),
        cancel: jobs.filter((job) => !job.result && (job.assigned || job.admitted) && (cancellations.has(job.spec.id) || job.status === "cancelled")).map((job) => job.spec.id),
        routines: this.routines?.plans(actor) ?? [] });
    });
  }
}
import { runtimeDraining } from "./runtime-updates.ts";

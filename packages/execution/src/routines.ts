import { ExecutionRoutine, ExecutionRoutineCommandRequest, ExecutionRoutineInfo, RoutineSpec, Job,
  JOB_PROTOCOL_VERSION, parseAssignee, textContainsCardNumber, type RuntimeInfo } from "@lumio/schema";
import { idTime } from "@lumio/foundation";
import { parseCron, nextFire, validTimeZone } from "./cron.ts";
import { routineJobId } from "./ids.ts";
import { ExecutionError, type ExecutionJobs } from "./jobs.ts";

export interface RoutinePlanRecord { routine: string; actor: string; spec: RoutineSpec; fingerprint: string }
export interface ExecutionRoutineStore {
  get(id: string): ExecutionRoutine | undefined;
  list(): ExecutionRoutine[];
  save(routine: ExecutionRoutine): void;
  currentPlan(routine: string): RoutinePlanRecord | undefined;
  setCurrent(routine: string, plan?: RoutinePlanRecord): void;
  planHistory(routine?: string): RoutinePlanRecord[];
  savePlan(plan: RoutinePlanRecord): void;
  receipt(actor: string, request: string): { operation: string; routine: ExecutionRoutine } | undefined;
  putReceipt(actor: string, request: string, operation: string, routine: ExecutionRoutine): void;
  transaction<T>(action: () => T): T;
}
export interface RoutineEnvironment {
  text?: (key: string, ...args: unknown[]) => string;
  now(): Date; id(): string; lease(): string; fingerprint(value: string): string;
  runtimes(now: Date): RuntimeInfo[]; localRuntime?: string; timezone: string;
  validateWorkdir?(runtime: RuntimeInfo, workdir: string): void;
}
export class ExecutionRoutines {
  private msg(key: string, ...args: unknown[]): string { return this.context.text?.(key, ...args) ?? key.replace(/\$\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])); }
  constructor(private readonly store: ExecutionRoutineStore, private readonly jobs: Pick<ExecutionJobs, "get" | "list" | "record">,
    private readonly context: RoutineEnvironment) {}
  get(id: string): ExecutionRoutine {
    const routine = this.store.get(id);
    if (!routine) throw new ExecutionError("NOT_FOUND", { key: "routines.routine_not_found", args: [] });
    return ExecutionRoutine.parse(routine);
  }
  /** An offline import never sends a plan; schedules must have been explicitly paused before migration. */
  importPaused(input: ExecutionRoutine[]): void {
    const parsed = ExecutionRoutine.array().safeParse(input);
    if (!parsed.success) throw new ExecutionError("INVALID", { key: "routines.invalid_legacy_routine_format", args: [] });
    this.store.transaction(() => {
      const seen = new Set<string>();
      for (const routine of parsed.data) {
        if (routine.status !== "paused") throw new ExecutionError("CONFLICT", { key: "routines.pause_legacy_routine_before_importing", args: [] });
        if (seen.has(routine.id) || this.store.get(routine.id)) throw new ExecutionError("CONFLICT", { key: "routines.routine_id_already_exists_or_is_duplicated", args: [] });
        seen.add(routine.id); this.validate(routine); this.store.save(routine); this.store.setCurrent(routine.id);
      }
    });
  }
  private validate(routine: ExecutionRoutine): void {
    try { if (!validTimeZone(routine.timezone) || !nextFire(parseCron(routine.schedule), routine.timezone, this.context.now())) throw new Error(); }
    catch { throw new ExecutionError("INVALID", { key: "routines.invalid_routine_cron_or_time_zone", args: [] }); }
  }
  command(input: unknown, actor: string): ExecutionRoutine {
    const parsed = ExecutionRoutineCommandRequest.safeParse(input);
    if (!parsed.success) throw new ExecutionError("INVALID", { key: "routines.invalid_routine_command_parameters", args: [] });
    const request = parsed.data, serialized = JSON.stringify(request.operation);
    return this.store.transaction(() => {
      const receipt = this.store.receipt(actor, request.request_id);
      if (receipt) {
        if (receipt.operation !== serialized) throw new ExecutionError("CONFLICT", { key: "index.request_id_was_used_for_a_different_operation", args: [] });
        return receipt.routine;
      }
      const operation = request.operation, time = this.context.now().toISOString();
      let routine: ExecutionRoutine;
      if (operation.op === "execution.routine.create") routine = ExecutionRoutine.parse({ ...operation.args,
        schema_version: 2, id: this.context.id(), description: operation.args.description ?? "", status: operation.args.status ?? "active",
        timezone: operation.args.timezone ?? this.context.timezone, context: operation.args.context ?? "none", revision: 1, created: time, updated: time });
      else {
        const current = this.get(operation.args.routine);
        if (current.revision !== operation.args.expected_revision) throw new ExecutionError("CONFLICT", { key: "routines.routine_changed_reload", args: [] });
        const fields = { ...current } as Record<string, unknown>;
        for (const [key, value] of Object.entries(operation.args.patch)) { if (value === null) delete fields[key]; else if (value !== undefined) fields[key] = value; }
        routine = ExecutionRoutine.parse({ ...fields, revision: current.revision + 1, updated: time });
      }
      this.validate(routine); this.store.save(routine); this.store.setCurrent(routine.id);
      this.store.putReceipt(actor, request.request_id, serialized, routine); return routine;
    });
  }
  private runtime(routine: ExecutionRoutine): RuntimeInfo {
    const assignee = parseAssignee(routine.assignee);
    if (assignee === "human") throw new ExecutionError("INVALID", { key: "routines.routine_must_be_assigned_to_an_agent", args: [] });
    const runtime = this.context.runtimes(this.context.now()).find((value) => value.registration.name === (assignee.device ?? this.context.localRuntime));
    if (!runtime) throw new ExecutionError("INVALID", { key: "routines.no_runtime_available_pair_the_device_specified_by_the_routine_first", args: [] });
    if (!runtime.registration.engines.some((engine) => engine.name === assignee.agent)) throw new ExecutionError("INVALID", { key: "modules.selected_agent_is_not_registered_on_runtime", args: [] });
    this.context.validateWorkdir?.(runtime, routine.workdir ?? "~");
    return runtime;
  }
  private plan(routine: ExecutionRoutine): RoutinePlanRecord {
    const runtime = this.runtime(routine), target = parseAssignee(routine.assignee);
    if (target === "human") throw new ExecutionError("INVALID", { key: "routines.routine_must_be_assigned_to_an_agent", args: [] });
    const previous = this.jobs.list(undefined, undefined, routine.id).filter((job) => job.result).at(-1);
    const raw = previous?.result?.report;
    const sensitive = raw && (textContainsCardNumber(raw) || /\b(?:sk-|gh[pousr]_|github_pat_|AKIA|xox[abprs]-|lumio_)[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw));
    const report = routine.context === "previous" && !sensitive ? raw?.slice(0, 3000) : undefined;
    const prompt = this.msg("You are running an independent routine. Work only in the working directory; do not access the Lumio knowledge directory. Request privileged approval through lumio-runtime sudo.\nReport results clearly; if a user decision is needed, use <lumio-question>Question</lumio-question> and end the round.\n\n# ${0}\n\n${1}${2}", routine.title, routine.description, report ? this.msg("\n\n## Previous report\n\n${0}", report) : "");
    const template: RoutineSpec["template"] = { run: { kind: "agent", engine: target.agent, prompt, ...(routine.model ? { model: routine.model } : {}) },
      workdir: routine.workdir ?? "~", timeout_seconds: (routine.timeout_minutes ?? 120) * 60, ...(routine.gpus ? { gpus: routine.gpus } : {}) };
    const fingerprint = this.context.fingerprint(JSON.stringify({ revision: routine.revision, runtime: runtime.actor, template, schedule: routine.schedule, timezone: routine.timezone }));
    const current = this.store.currentPlan(routine.id);
    if (current?.fingerprint === fingerprint) return current;
    const record = { routine: routine.id, actor: runtime.actor, fingerprint,
      spec: RoutineSpec.parse({ routine: routine.id, revision: fingerprint, schedule: routine.schedule, timezone: routine.timezone, lease: this.context.lease(), template }) };
    this.store.savePlan(record); this.store.setCurrent(routine.id, record); return record;
  }
  plans(actor: string): RoutineSpec[] {
    return this.store.transaction(() => {
      const plans: RoutineSpec[] = [];
      for (const routine of this.store.list()) {
        if (routine.status !== "active") continue;
        try { const record = this.plan(routine); if (record.actor === actor) plans.push(record.spec); }
        catch (cause) { if (!(cause instanceof ExecutionError)) throw cause; }
      }
      return plans;
    });
  }
  /** Lease identifies the exact historical input even when an offline runtime still holds an older plan. */
  adopt(actor: string, id: string, now: Date, lease?: string): Job | undefined {
    let fired: Date;
    try { fired = new Date(idTime(id)); } catch { return; }
    if (fired > now || fired.getUTCSeconds() !== 0 || fired.getUTCMilliseconds() !== 0) return;
    const candidates = this.store.planHistory().filter((plan) => plan.actor === actor
      && routineJobId(plan.routine, fired) === id && (lease === undefined || plan.spec.lease === lease));
    if (candidates.length !== 1) return;
    const plan = candidates[0]!, spec = plan.spec;
    const expected = nextFire(parseCron(spec.schedule), spec.timezone, new Date(fired.getTime() - 1));
    if (expected?.getTime() !== fired.getTime()) return;
    const job = Job.parse({ spec: { protocol_version: JOB_PROTOCOL_VERSION, id, runtime: actor, lease: spec.lease,
      source: { routine: plan.routine, round: 1, fired_at: fired.toISOString() }, run: spec.template.run,
      workdir: spec.template.workdir, timeout_seconds: spec.template.timeout_seconds, ...(spec.template.gpus ? { gpus: spec.template.gpus } : {}), created: fired.toISOString() },
      status: "assigned", assigned: now.toISOString() });
    this.jobs.record(job); return job;
  }
  list(): ExecutionRoutineInfo[] {
    return this.store.list().map((routine) => {
      const lastJob = this.jobs.list(undefined, undefined, routine.id).at(-1);
      const last = lastJob?.spec.source?.fired_at ? { job: lastJob.spec.id, status: lastJob.status, fired_at: lastJob.spec.source.fired_at } : undefined;
      let runtime: RuntimeInfo | undefined, problem: string | undefined;
      try { runtime = this.runtime(routine); } catch (cause) { problem = cause instanceof ExecutionError ? this.msg(cause.params.key, ...cause.params.args) : this.msg("Could not generate plan"); }
      return ExecutionRoutineInfo.parse({ routine, ...(runtime ? { runtime: runtime.registration.name } : {}),
        ...(routine.status === "active" && runtime ? { next: nextFire(parseCron(routine.schedule), routine.timezone, this.context.now())?.toISOString() } : {}),
        ...(last ? { last } : {}), ...(problem ? { problem } : {}) });
    });
  }
}

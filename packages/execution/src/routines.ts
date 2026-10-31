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
  now(): Date; id(): string; lease(): string; fingerprint(value: string): string;
  runtimes(now: Date): RuntimeInfo[]; localRuntime?: string; timezone: string;
  validateWorkdir?(runtime: RuntimeInfo, workdir: string): void;
}
export class ExecutionRoutines {
  constructor(private readonly store: ExecutionRoutineStore, private readonly jobs: Pick<ExecutionJobs, "get" | "list" | "record">,
    private readonly context: RoutineEnvironment) {}
  get(id: string): ExecutionRoutine {
    const routine = this.store.get(id);
    if (!routine) throw new ExecutionError("NOT_FOUND", "找不到例行任务");
    return ExecutionRoutine.parse(routine);
  }
  private validate(routine: ExecutionRoutine): void {
    try { if (!validTimeZone(routine.timezone) || !nextFire(parseCron(routine.schedule), routine.timezone, this.context.now())) throw new Error(); }
    catch { throw new ExecutionError("INVALID", "例行任务的 cron 或时区不合法"); }
  }
  command(input: unknown, actor: string): ExecutionRoutine {
    const parsed = ExecutionRoutineCommandRequest.safeParse(input);
    if (!parsed.success) throw new ExecutionError("INVALID", "例行任务操作参数不合法");
    const request = parsed.data, serialized = JSON.stringify(request.operation);
    return this.store.transaction(() => {
      const receipt = this.store.receipt(actor, request.request_id);
      if (receipt) {
        if (receipt.operation !== serialized) throw new ExecutionError("CONFLICT", "请求编号已用于不同的操作");
        return receipt.routine;
      }
      const operation = request.operation, time = this.context.now().toISOString();
      let routine: ExecutionRoutine;
      if (operation.op === "execution.routine.create") routine = ExecutionRoutine.parse({ ...operation.args,
        schema_version: 2, id: this.context.id(), description: operation.args.description ?? "", status: operation.args.status ?? "active",
        timezone: operation.args.timezone ?? this.context.timezone, context: operation.args.context ?? "none", revision: 1, created: time, updated: time });
      else {
        const current = this.get(operation.args.routine);
        if (current.revision !== operation.args.expected_revision) throw new ExecutionError("CONFLICT", "例行任务已被修改，请重新读取");
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
    if (assignee === "human") throw new ExecutionError("INVALID", "例行任务必须交给 agent");
    const runtime = this.context.runtimes(this.context.now()).find((value) => value.registration.name === (assignee.device ?? this.context.localRuntime));
    if (!runtime) throw new ExecutionError("INVALID", "没有可用的执行器：请先配对例行任务指定的设备");
    if (!runtime.registration.engines.some((engine) => engine.name === assignee.agent)) throw new ExecutionError("INVALID", "执行器未登记所选 agent");
    this.context.validateWorkdir?.(runtime, routine.workdir ?? "~");
    return runtime;
  }
  private plan(routine: ExecutionRoutine): RoutinePlanRecord {
    const runtime = this.runtime(routine), target = parseAssignee(routine.assignee);
    if (target === "human") throw new ExecutionError("INVALID", "例行任务必须交给 agent");
    const previous = this.jobs.list(undefined, undefined, routine.id).filter((job) => job.result).at(-1);
    const raw = previous?.result?.report;
    const sensitive = raw && (textContainsCardNumber(raw) || /\b(?:sk-|gh[pousr]_|github_pat_|AKIA|xox[abprs]-|lumio_)[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw));
    const report = routine.context === "previous" && !sensitive ? raw?.slice(0, 3000) : undefined;
    const prompt = `你正在执行一个独立的例行任务。只在工作目录内工作，不访问 Lumio 知识目录。需要高权限时通过 lumio-runtime sudo 请求批准。\n用中文汇报结果；需要用户决定时用 <lumio-question>问题</lumio-question> 然后结束。\n\n# ${routine.title}\n\n${routine.description}${report ? `\n\n## 上一次的汇报\n\n${report}` : ""}`;
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
      try { runtime = this.runtime(routine); } catch (cause) { problem = cause instanceof ExecutionError ? cause.message : "无法生成计划"; }
      return ExecutionRoutineInfo.parse({ routine, ...(runtime ? { runtime: runtime.registration.name } : {}),
        ...(routine.status === "active" && runtime ? { next: nextFire(parseCron(routine.schedule), routine.timezone, this.context.now())?.toISOString() } : {}),
        ...(last ? { last } : {}), ...(problem ? { problem } : {}) });
    });
  }
}

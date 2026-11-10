import { nextTurn, type TurnAction, type PlannedDelivery } from "./turn.ts";
import { completedStages, graphPlan, graphProgress, readyStages, resetStages, workingBranches, type PlanBranch } from "./plan-progress.ts";
export { nextTurn, migrateTurn, type LegacyTurnFacts, type PlannedDelivery } from "./turn.ts";
import {
  WorkProject, WorkTask, WorkComment, WorkExecution, WorkTaskDetail,
  WorkCommandRequest, WorkCommandResult, TaskTurnChange, Turn, PlanTemplate, DEFAULT_PLAN_MAX_ROUNDS, textContainsCardNumber,
  type WorkTaskListArgs, type PlanRun, TrashItem, TRASH_RETENTION_DAYS, TRASHED_REASON,
  type ActorRole, type ID_PREFIXES, type Job, type HandoffPlan, planAncestors, planSinks, DISPATCH_TARGET_SOURCES,
} from "@lumio/schema";

export class WorkError extends Error {
  constructor(public readonly code: "INVALID" | "NOT_FOUND" | "CONFLICT" | "INTERNAL" | "FORBIDDEN", public readonly params: { key: string; args: readonly unknown[] }, public readonly reason?: string) {
    super(code); this.name = "WorkError";
  }
}

/** An expected planned-stage preflight refusal supplied by the dispatch adapter. */
export class PlanDispatchUnavailable extends WorkError {
  constructor(params: WorkError["params"]) { super("CONFLICT", params); }
}

export interface WorkStore {
  project(id: string): WorkProject | undefined;
  projects(): WorkProject[];
  putProject(value: WorkProject): void;
  task(id: string): WorkTask | undefined;
  tasks(): WorkTask[];
  putTask(value: WorkTask): void;
  comments(task: string): WorkComment[];
  putComment(value: WorkComment): void;
  executions(task?: string): WorkExecution[];
  latestJobs(): Map<string, string>;
  putExecution(value: WorkExecution): void;
  turns(task: string): TaskTurnChange[];
  putTurn(value: TaskTurnChange): void;
  planTemplates(): PlanTemplate[];
  putPlanTemplate(value: PlanTemplate): void;
  deletePlanTemplate(id: string): void;
  receipt(actor: string, request: string): { operation: string; result: WorkCommandResult } | undefined;
  putReceipt(actor: string, request: string, operation: string, result: WorkCommandResult): void;
  trash(id: string): TrashItem | undefined;
  trashed(): TrashItem[];
  putTrash(item: TrashItem): void;
  removeTrash(id: string): void;
  transaction<T>(action: () => T): T;
}

/** Trusted execution identity supplied by the application, never by command arguments. */
export interface WorkCaller { role: ActorRole; job?: string }

export interface WorkContext {
  systemActor?: string;
  auditPlan?(change: TaskTurnChange, plan: PlanRun, checkpoint?: CheckpointDecision): void;
  job?(id: string): Job | undefined;
  text?: (key: string, ...args: unknown[]) => string;
  now(): Date;
  id(prefix: (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]): string;
  localRuntime?: string;
  validateTarget?(target: string, source?: TargetSource): void;
  dispatch?(task: WorkTask, input: string, round: number, to?: string, previous?: string | null): Job;
  cancel?(task: string): string | void;
  agentsForJobs?(jobs: string[]): Map<string, string>;
}

type NextTarget = NonNullable<WorkTask["next_target"]>;
type TargetSource = (typeof DISPATCH_TARGET_SOURCES)[number];
type DispatchTarget = { target: string; source: TargetSource };
type DispatchedRound = { job: Job; target: string; target_source: TargetSource };
type GraphStep = { turn: Turn; plan: PlanRun; outcome?: "done"; dispatched?: DispatchedRound };
type CheckpointDecision = { stage: string; action: "continue" | "send_back" | "finish" | "hold"; by: string };
type GraphDispatch = { to?: string; approvedSource?: TargetSource; only?: string; comment?: string };

function requestsChanges(report?: string): boolean {
  return report?.split(/\r?\n/).some(line => line.trim() === "<lumio-outcome>changes</lumio-outcome>") ?? false;
}

function latestExecution(executions: WorkExecution[]): WorkExecution | undefined {
  return executions.reduce<WorkExecution | undefined>((latest, value) => !latest || value.round > latest.round ? value : latest, undefined);
}

function patch<T extends object>(value: T, changes: Record<string, unknown>): T {
  const next = { ...value } as Record<string, unknown>;
  for (const [key, change] of Object.entries(changes)) {
    if (change === null) delete next[key];
    else if (change !== undefined) next[key] = change;
  }
  return next as T;
}

function secret(text: string): boolean {
  return textContainsCardNumber(text) || [
    /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/,
    /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bAKIA[0-9A-Z]{16}\b/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\blumio_[A-Za-z0-9_-]{43}\b/,
  ].some((pattern) => pattern.test(text));
}

/** Work owns task/project semantics; storage, time, IDs and execution are injected. */
export class WorkService {
  private msg(key: string, ...args: unknown[]): string { return this.context.text?.(key, ...args) ?? key.replace(/\$\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])); }
  constructor(private readonly store: WorkStore, private readonly context: WorkContext) {}

  project(id: string): WorkProject {
    const trashed = this.store.trash(id);
    const value = !trashed && this.store.project(id);
    if (!value) throw new WorkError("NOT_FOUND", { key: "index.project_not_found", args: [] }, trashed && TRASHED_REASON);
    return WorkProject.parse(value);
  }
  projects(): WorkProject[] {
    const hidden = new Set(this.store.trashed().map(item => item.id));
    return WorkProject.array().parse(this.store.projects()).filter(value => !hidden.has(value.id));
  }
  task(id: string): WorkTask { return this.withTaskFacts(this.visibleTask(id)); }

  private visibleTask(id: string): WorkTask {
    const trashed = this.store.trash(id);
    const value = !trashed && this.store.task(id);
    if (!value) throw new WorkError("NOT_FOUND", { key: "index.task_not_found", args: [] }, trashed && TRASHED_REASON);
    return WorkTask.parse(value);
  }
  /** Batch reads resolve dependencies, project defaults and latest agents without per-task queries. */
  tasks(filter: WorkTaskListArgs = {}): WorkTask[] {
    const query = filter.query?.trim().toLocaleLowerCase();
    const hidden = new Set(this.store.trashed().map(item => item.id));
    const visible = WorkTask.array().parse(this.store.tasks()).filter(task => !hidden.has(task.id));
    const byId = new Map(visible.map(task => [task.id, task]));
    const tasks = visible.map(task => this.withReadiness(task, id => byId.get(id))).filter(task =>
      (!filter.project || task.project === filter.project) && (!filter.status || legacyTaskStatus(task) === filter.status)
      && (!filter.tag || task.tags.includes(filter.tag)) && (!filter.parent || task.parent === filter.parent)
      && (!filter.readiness || (task.outcome === "open" && (filter.readiness === "blocked" ? task.blocked_by!.length > 0 : task.blocked_by!.length === 0)))
      && (!query || `${task.title}\n${task.description}\n${task.tags.join(" ")}`.toLocaleLowerCase().includes(query)));
    if (!tasks.length) return tasks;
    const projects = new Map(this.store.projects().filter(project => !hidden.has(project.id)).map(project => [project.id, project]));
    const templates = [...projects.values()].some(project => project.default_plan)
      ? new Map(this.planTemplates().map(template => [template.id, template.plan])) : undefined;
    const latestJobs = this.store.latestJobs();
    const jobs = tasks.flatMap(task => {
      const job = latestJobs.get(task.id);
      return job ? [job] : [];
    });
    const agents = this.context.agentsForJobs?.(jobs);
    return tasks.map(task => {
      const project = task.project ? projects.get(task.project) : undefined;
      const plan = project?.default_plan ? templates?.get(project.default_plan) : undefined;
      return { ...task, next_target: this.nextTarget(task, latestJobs.get(task.id), job => agents?.get(job), project?.default_target, plan) };
    });
  }
  private withReadiness(task: WorkTask, lookup = (id: string) => this.store.trash(id) ? undefined : this.store.task(id)): WorkTask {
    return { ...task, blocked_by: task.dependencies.filter(id => lookup(id)?.outcome === "open") };
  }
  private withTaskFacts(task: WorkTask, current = task, executions = this.store.executions(current.id)): WorkTask {
    const project = current.project && !this.store.trash(current.project) ? this.store.project(current.project) : undefined;
    const template = !current.plan && project?.default_plan ? this.planTemplates().find(value => value.id === project.default_plan) : undefined;
    return { ...this.withReadiness(task), next_target: this.nextTarget(current, latestExecution(executions)?.job,
      job => this.context.agentsForJobs?.([job]).get(job), project?.default_target, template?.plan) };
  }
  private requireReady(task: WorkTask, ids = this.withReadiness(task).blocked_by!): void {
    if (ids.length) throw new WorkError("CONFLICT", { key: "work.blocked_dependencies", args: [ids.map(id => `${id}: ${this.store.task(id)!.title}`).join(", ")] });
  }
  detail(id: string): WorkTaskDetail {
    const raw = this.visibleTask(id), executions = this.store.executions(id);
    const task = this.withTaskFacts(raw, raw, executions);
    const hidden = new Set(this.store.trashed().map(item => item.id));
    const visible = this.store.tasks().filter(value => !hidden.has(value.id));
    return WorkTaskDetail.parse({ task, dependents: visible.filter(value => value.dependencies.includes(id)).map(value => value.id),
      children: visible.filter(value => value.parent === id).map(value => value.id),
      comments: this.store.comments(id), executions, turns: this.store.turns(id) });
  }
  planTemplates(): PlanTemplate[] { return PlanTemplate.array().parse(this.store.planTemplates()); }

  /** Import historical facts without transitions, generated IDs or execution side effects. The caller archives provenance. */
  importSettled(input: { projects: WorkProject[]; tasks: WorkTask[]; executions?: WorkExecution[] }): void {
    const projects = WorkProject.array().safeParse(input.projects), tasks = WorkTask.array().safeParse(input.tasks), executions = WorkExecution.array().safeParse(input.executions ?? []);
    if (!projects.success || !tasks.success || !executions.success) throw new WorkError("INVALID", { key: "index.invalid_legacy_work_object_format", args: [] });
    this.store.transaction(() => {
      const ids = [...projects.data.map((value) => value.id), ...tasks.data.map((value) => value.id)];
      if (new Set(ids).size !== ids.length || projects.data.some((value) => this.store.project(value.id)) || tasks.data.some((value) => this.store.task(value.id))) throw new WorkError("CONFLICT", { key: "index.legacy_object_id_already_exists_or_is_duplicated", args: [] });
      const taskIds = new Set(tasks.data.map((value) => value.id)), oldJobs = new Set(this.store.executions().map((value) => value.job));
      if (executions.data.some((value) => !value.applied || !taskIds.has(value.task) || oldJobs.has(value.job))) throw new WorkError("CONFLICT", { key: "index.only_processed_historical_executions_belonging_to_this_task_batch_ca", args: [] });
      for (const value of projects.data) this.store.putProject(value);
      // Reserve all task IDs first so parent/dependency ordering cannot create a partial import.
      for (const value of tasks.data) this.store.putTask(WorkTask.parse({ ...value, parent: undefined, dependencies: [] }));
      for (const value of tasks.data) { this.store.putTask(value); this.initialTurn(value, this.context.systemActor ?? value.created_by!); }
      for (const value of tasks.data) this.checkTask(value);
      for (const value of executions.data) this.store.putExecution(value);
    });
  }

  private initialTurn(task: WorkTask, by: string): void {
    this.store.putTurn(TaskTurnChange.parse({ task: task.id, at: task.updated, by, from: task.turn, to: task.turn, outcome: task.outcome }));
  }
  private transition(task: WorkTask, action: TurnAction, by: string, at: string): WorkTask {
    const change = nextTurn(action, at, task, this.plannedDelivery);
    const plan = task.plan && change.turn.stage ? { ...task.plan, stage: change.turn.stage,
      rounds: task.plan.rounds + Number(change.turn.reason === "working" && change.turn.job !== task.turn.job) } : task.plan;
    return this.recordTransition(task, change, by, at, change.turn.reason === "working" || !plan?.active
      ? plan : { ...plan, active: undefined });
  }
  private recordTransition(task: WorkTask, { turn, outcome }: { turn: Turn; outcome?: WorkTask["outcome"] },
    by: string, at: string, plan = task.plan, checkpoint?: CheckpointDecision): WorkTask {
    const updated = WorkTask.parse({ ...task, turn, ...(outcome === undefined ? {} : { outcome }), plan, revision: task.revision + 1, updated: at, updated_by: by });
    this.store.putTask(updated);
    const record = TaskTurnChange.parse({ task: task.id, at, by, from: task.turn, to: updated.turn,
      ...(outcome !== undefined ? { outcome } : {}) });
    this.store.putTurn(record);
    if (plan && (updated.turn.stage || checkpoint)) this.context.auditPlan?.(record, plan, checkpoint);
    return updated;
  }
  private snapshot(task: WorkTask, latest?: WorkExecution): string {
    // IDs and one-line summaries spill older material; only comments since the last hand-back are inline.
    const turns = this.store.turns(task.id);
    const returned = turns.filter(change => change.to.reason !== "working").at(-1);
    const previous = latest ? this.context.job?.(latest.job) : undefined;
    const line = (value: string) => secret(value) ? "[sensitive content omitted]" : value.replace(/\s+/g, " ").trim().slice(0, 500);
    const history = this.store.comments(task.id);
    const runtimes = new Set(this.store.executions(task.id).map(run => this.context.job?.(run.job)?.spec.runtime).filter(Boolean));
    // Comments and hand-backs may share a millisecond: the appended report is also an ordering boundary.
    const boundary = history.findLastIndex(comment => runtimes.has(comment.author));
    const comments = history.slice(boundary + 1).filter(comment => !returned || comment.created >= returned.at);
    const stage = task.plan?.plan.stages.find(stage => stage.id === task.plan?.stage);
    const repo = task.project ? this.project(task.project).repo : undefined;
    return [`# ${task.title}`, "", `Task ID: ${task.id}`, ...(repo ? [`Repository: ${repo}`] : []), "", task.description,
      ...(stage?.kind === "agent" ? ["", `## Plan stage: ${stage.id}`, stage.instruction,
        ...(stage.back_to ? ["If changes are needed, explain what must change and put <lumio-outcome>changes</lumio-outcome> on a separate line at the end of your report to send work back."] : [])] : []),
      "", "Use the Lumio skill to retrieve more context by ID: task show, job show, show (notes). Older discussions and reports are not included in full.",
      "", "## Comments since hand-back", ...comments.map(comment => `${comment.id} (${comment.author}): ${comment.body}`),
      ...(latest ? ["", "## Previous round", `${latest.job}: ${line([previous?.result?.question, previous?.result?.report || previous?.result?.error || "Report available via job show"].filter(Boolean).join(" "))}`] : []),
      "", "## Earlier rounds", ...this.store.executions(task.id).filter(run => run.job !== latest?.job).map(run => `${run.job}: ${line(this.context.job?.(run.job)?.result?.report ?? `Round ${run.round}`)}`),
      "", "## References", ...task.references.map(ref => `${ref.id}: ${line(ref.label ?? ref.module)}`),
    ].join("\n");
  }

  private checkTask(task: WorkTask, previous?: WorkTask): void {
    if (task.project) this.project(task.project);
    const parent = task.parent && (task.parent === previous?.parent ? this.store.task(task.parent) : this.visibleTask(task.parent));
    if (parent) {
      if (parent.id === task.id) throw new WorkError("CONFLICT", { key: "index.a_task_cannot_be_its_own_parent", args: [] });
      if (parent.project && task.project && parent.project !== task.project) throw new WorkError("CONFLICT", { key: "index.parent_task_must_belong_to_the_same_project", args: [] });
      const seen = new Set([task.id]);
      let current: WorkTask | undefined = parent;
      while (current) {
        if (seen.has(current.id)) throw new WorkError("CONFLICT", { key: "index.parent_relationships_must_not_form_cycles", args: [] });
        seen.add(current.id); current = current.parent ? this.store.task(current.parent) : undefined;
      }
    }
    if (new Set(task.dependencies).size !== task.dependencies.length) throw new WorkError("INVALID", { key: "index.dependency_tasks_must_not_be_duplicated", args: [] });
    const visit = (id: string, seen: Set<string>): void => {
      if (id === task.id) throw new WorkError("CONFLICT", { key: "index.task_dependencies_must_not_form_cycles", args: [] });
      if (seen.has(id)) return;
      seen.add(id);
      for (const next of this.store.task(id)?.dependencies ?? []) visit(next, seen);
    };
    for (const id of task.dependencies) {
      if (!previous?.dependencies.includes(id)) this.visibleTask(id);
      visit(id, new Set());
    }
    if (task.outcome === "done") this.requireReady(task, this.withReadiness(task).blocked_by!
      .filter(id => previous?.outcome !== "done" || !previous.dependencies.includes(id)));
  }

  /** Freeze the observed version and delegation target before presenting a proposal. */
  proposalRequest(input: WorkCommandRequest): { request: WorkCommandRequest; source?: TargetSource } {
    const request = WorkCommandRequest.parse(input), operation = request.operation;
    if (operation.op === "work.plan_template.save") {
      this.validatePlan(operation.args.plan);
      if (operation.args.template) this.requireTemplate(operation.args.template);
      return { request };
    }
    if (operation.op !== "work.task.dispatch" && operation.op !== "work.task.plan.set") throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
    const task = this.visibleTask(operation.args.task);
    if (operation.args.expected_revision !== undefined && operation.args.expected_revision !== task.revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_dispatching", args: [] });
    operation.args.expected_revision = task.revision;
    if (operation.op === "work.task.plan.set") {
      this.validatePlan(operation.args.plan);
      return { request };
    }
    this.requireReady(task);
    const { target, source } = this.taskTarget(task, latestExecution(this.store.executions(task.id))?.job, operation.args.to);
    operation.args.to = target;
    return { request, source };
  }

  private qualifyTarget(target: string): string {
    return !target.includes("@") && this.context.localRuntime ? `${target}@${this.context.localRuntime}` : target;
  }
  private planStage(task: WorkTask) {
    return task.plan?.plan.stages.find(stage => stage.id === task.plan?.stage);
  }
  private nextTarget(task: WorkTask, lastJob: string | undefined, agentForJob: (job: string) => string | undefined,
    projectDefault?: string, defaultPlan?: HandoffPlan): NextTarget | undefined {
    const stage = this.planStage(task);
    if (task.plan) return stage?.kind === "agent" ? { target: this.qualifyTarget(stage.agent), source: "plan" } : undefined;
    if (defaultPlan && task.turn.reason !== "answer") {
      const first = readyStages(defaultPlan, new Set())[0];
      return first?.kind === "agent" ? { target: this.qualifyTarget(first.agent), source: "project" } : undefined;
    }
    if (lastJob) {
      const target = agentForJob(lastJob);
      return target ? { target: this.qualifyTarget(target), source: "last_round" } : undefined;
    }
    return projectDefault ? { target: this.qualifyTarget(projectDefault), source: "project" } : undefined;
  }
  private taskTarget(task: WorkTask, lastJob: string | undefined, explicit?: string, approvedSource?: TargetSource, checkPlanRegistration = true): DispatchTarget {
    const stage = this.planStage(task);
    if (explicit !== undefined) {
      const target = this.qualifyTarget(explicit), source = approvedSource ?? "explicit";
      if (!task.plan || checkPlanRegistration) this.context.validateTarget?.(target, source);
      if (task.plan && (stage?.kind !== "agent" || target !== this.qualifyTarget(stage.agent))) {
        throw new WorkError("CONFLICT", { key: "work.plan_agent", args: [] });
      }
      return { target, source };
    }
    if (task.plan && stage?.kind !== "agent") throw new WorkError("CONFLICT", { key: "work.plan_agent", args: [] });
    const target = this.nextTarget(task, lastJob, job => this.context.agentsForJobs?.([job]).get(job),
      !task.plan && !lastJob && task.project ? this.project(task.project).default_target : undefined);
    if (!target) throw new WorkError("INVALID", { key: "index.specify_an_agent_assignee_e_g_pi_server", args: [] });
    if (!task.plan || checkPlanRegistration) this.context.validateTarget?.(target.target, target.source);
    return target;
  }

  private validatePlan(plan: HandoffPlan | null): void {
    for (const stage of plan?.stages ?? []) if (stage.kind === "agent") this.context.validateTarget?.(stage.agent);
  }

  private requireTemplate(id: string): PlanTemplate {
    const template = this.planTemplates().find(value => value.id === id);
    if (!template) throw new WorkError("NOT_FOUND", { key: "work.template_not_found", args: [] });
    return template;
  }

  private initialPlan(plan: HandoffPlan, approved: PlanRun["approved"], from?: string): PlanRun {
    const run: PlanRun = { plan, approved, stage: from ?? plan.stages[0]!.id, rounds: 0 };
    if (!graphPlan(plan)) return run;
    const done = from ? planAncestors(plan.stages).get(from)! : new Set<string>();
    if (plan.finish === "auto" && plan.stages.some(stage => stage.kind === "checkpoint" && done.has(stage.id))) {
      throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
    }
    return graphProgress(run, done, from ?? readyStages(plan, done)[0]!.id);
  }

  private reviewTurn(task: WorkTask, stage: string, at: string, note?: string): Turn {
    const latest = latestExecution(this.store.executions(task.id));
    return Turn.parse({ holder: "human", reason: "review", since: at, stage, note,
      round: latest?.round, job: latest?.job });
  }

  /** The same safeguards apply to initial delegation, retries and automatic plan handoffs. */
  private startRound(task: WorkTask, actor: string, at: string, options: {
    to?: string; comment?: string; automatic?: boolean; approvedSource?: TargetSource; previous?: string | null;
  }): { turn: Turn; dispatched?: DispatchedRound } {
    const { to, comment, automatic, approvedSource, previous } = options;
    this.checkDispatch(task, automatic);
    const executions = this.store.executions(task.id);
    const latest = latestExecution(executions);
    const { target, source } = this.taskTarget(task, latest?.job, to, approvedSource, false);
    if (task.plan && task.plan.rounds >= (task.plan.plan.max_rounds ?? DEFAULT_PLAN_MAX_ROUNDS)) {
      return { turn: this.reviewTurn(task, task.plan.stage, at, this.msg("work.plan_max_rounds", task.plan.plan.max_rounds ?? DEFAULT_PLAN_MAX_ROUNDS)) };
    }
    if (!this.context.dispatch) throw new WorkError("INTERNAL", { key: "index.execution_capability_is_not_configured", args: [] });
    if (comment !== undefined) this.store.putComment(WorkComment.parse({ id: this.context.id("wmsg"), task: task.id, author: actor, body: comment, created: at }));
    const prior = previous ? executions.find(execution => execution.job === previous) : latest;
    const snapshot = this.snapshot(task, prior), round = (latest?.round ?? 0) + 1;
    const job = this.context.dispatch(task, snapshot, round, target, previous);
    this.store.putExecution(WorkExecution.parse({ task: task.id, job: job.spec.id, round, input_revision: task.revision,
      input_snapshot: snapshot, created: at, applied: false }));
    const note = task.plan ? this.planNote(task.plan, task.plan.stage) : undefined;
    return { dispatched: { job, target, target_source: source }, turn: nextTurn({ kind: "dispatch", to: target, round, job: job.spec.id,
      stage: task.plan?.stage, note }, at).turn };
  }

  private checkDispatch(task: WorkTask, automatic?: boolean): void {
    if (task.outcome !== "open" || task.turn.holder === "nobody" || (task.turn.reason === "working" && !automatic)) {
      throw new WorkError("CONFLICT", { key: "index.task_is_done_cancelled_or_paused", args: [] });
    }
    this.requireReady(task);
    if ((!automatic || !task.plan || !graphPlan(task.plan.plan)) && this.store.executions(task.id).some(execution => !execution.applied)) {
      throw new WorkError("CONFLICT", { key: "index.this_task_already_has_a_running_round_or_pending_result", args: [] });
    }
  }

  private planNote(run: PlanRun, stage: string): string {
    return `Plan ${run.approved.at} by ${run.approved.by}; stage ${stage}`;
  }

  private failedPlanTurn(task: WorkTask, stage: string, at: string, cause: unknown, code: string): Turn {
    const detail = cause instanceof PlanDispatchUnavailable ? this.msg(cause.params.key, ...cause.params.args) : code;
    const note = this.msg("work.plan_dispatch_failed", stage, detail).slice(0, 200);
    return Turn.parse({ ...this.reviewTurn(task, stage, at, note), reason: "failed" });
  }

  private planTurn(task: WorkTask, stageId: string, actor: string, at: string): Turn {
    const run = task.plan!;
    if (stageId === "end") return this.reviewTurn(task, "end", at);
    const stage = run.plan.stages.find(stage => stage.id === stageId);
    if (!stage) throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
    if (stage.kind === "checkpoint") return this.reviewTurn(task, stage.id, at, stage.prompt);
    try {
      return this.store.transaction(() => this.startRound({ ...task, plan: { ...run, stage: stage.id } }, actor, at, { automatic: true }).turn);
    } catch (cause) {
      // An unavailable approved agent or newly blocked dependency needs human attention.
      // Storage/audit faults still roll back result application and remain retryable.
      const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
      if (code !== "INVALID" && code !== "NOT_FOUND" && code !== "CONFLICT") throw cause;
      return this.failedPlanTurn(task, stage.id, at, cause, code);
    }
  }

  private plannedDelivery: PlannedDelivery = (task, action, at) => {
    const run = task.plan!, index = run.plan.stages.findIndex(stage => stage.id === run.stage), current = run.plan.stages[index];
    const back = current?.kind === "agent" && requestsChanges(action.report) ? current.back_to : undefined;
    return this.planTurn(task, back ?? run.plan.stages[index + 1]?.id ?? "end", this.context.systemActor ?? run.approved.by, at);
  };

  /** Join the existing execution and turn histories to find the last round per stage of this plan. */
  private graphAttempts(task: WorkTask, run: PlanRun): Map<string, { branch: PlanBranch; execution: WorkExecution }> {
    const executions = run.rounds > 0 ? this.store.executions(task.id).sort((a, b) => a.round - b.round).slice(-run.rounds) : [];
    const byJob = new Map(executions.map(execution => [execution.job, execution]));
    const attempts = new Map<string, { branch: PlanBranch; execution: WorkExecution }>();
    for (const change of this.store.turns(task.id)) {
      for (const branch of workingBranches(change.to)) {
        const execution = byJob.get(branch.job);
        if (execution && (attempts.get(branch.stage)?.branch.round ?? 0) < branch.round) {
          attempts.set(branch.stage, { branch, execution });
        }
      }
    }
    return attempts;
  }

  private graphWorking(run: PlanRun, done: ReadonlySet<string>, active: PlanBranch[], at: string, note?: string): GraphStep {
    const first = active[0]!;
    const turn = active.length > 1
      ? Turn.parse({ holder: "agents", reason: "working", since: at, stage: first.stage, parallel: active })
      : nextTurn({ kind: "dispatch", to: first.agent, stage: first.stage, round: first.round, job: first.job, note }, at).turn;
    return { plan: graphProgress(run, done, first.stage, active), turn };
  }

  private advanceGraph(task: WorkTask, run: PlanRun, done: Set<string>, active: PlanBranch[], actor: string, at: string,
    options: { start?: GraphDispatch; settled?: Job; prefer?: string; skipStops?: boolean } = {}): GraphStep {
    const review = (stage: string, note?: string): GraphStep => ({
      plan: graphProgress(run, done, stage), turn: this.reviewTurn(task, stage, at, note),
    });
    const attempts = this.graphAttempts(task, run);
    let ready = readyStages(run.plan, done, active);
    let prefer = options.prefer;
    if (!options.start && !options.skipStops) {
      // A question, failure or send-back stops new launches while in-flight peers drain.
      // Old results from a reset descendant no longer apply after its ancestor has run again.
      const ancestors = planAncestors(run.plan.stages);
      const stopped = ready.flatMap(stage => {
        const attempt = attempts.get(stage.id);
        if (stage.kind !== "agent" || !attempt?.execution.applied
          || [...ancestors.get(stage.id)!].some(id => (attempts.get(id)?.branch.round ?? 0) > attempt.branch.round)) return [];
        const job = attempt.branch.job === options.settled?.spec.id ? options.settled : this.context.job?.(attempt.branch.job);
        if (!job) return [];
        const back = job.status === "done" && requestsChanges(job.result?.report) ? stage.back_to : undefined;
        return job.status === "done" && !back ? [] : [{ branch: attempt.branch, status: job.status, back }];
      }).sort((a, b) => a.branch.round - b.branch.round);
      if (stopped.length && active.length) return this.graphWorking(run, done, active, at);
      const attention = stopped.find(result => !result.back);
      if (attention) {
        const { branch, status } = attention;
        const turn = nextTurn({ kind: "result", status, job: branch.job, round: branch.round }, at).turn;
        return { plan: graphProgress(run, done, branch.stage), turn: Turn.parse({ ...turn, stage: branch.stage }) };
      }
      if (stopped.length) {
        for (const result of stopped) done.add(result.branch.stage);
        resetStages(run.plan, done, stopped.flatMap(result => result.back ? [result.back] : []));
        prefer = stopped[0]!.back;
        ready = readyStages(run.plan, done);
      }
    }

    if (!ready.length) {
      if (active.length) return this.graphWorking(run, done, active, at);
      if (run.plan.finish !== "auto" || !planSinks(run.plan.stages).every(id => done.has(id))) return review("end");
      if (this.withReadiness(task).blocked_by!.length) {
        const result = review("end", this.msg("work.plan_dispatch_failed", "end", "CONFLICT"));
        return { ...result, turn: Turn.parse({ ...result.turn, reason: "failed" }) };
      }
      return { plan: graphProgress(run, done, "end"), outcome: "done",
        turn: Turn.parse({ ...nextTurn({ kind: "finish", outcome: "done" }, at).turn, stage: "end" }) };
    }

    const first = ready.find(stage => stage.id === (options.start?.only ?? prefer)) ?? ready[0]!;
    if (first.kind === "checkpoint") {
      if (options.start) throw new WorkError("CONFLICT", { key: "work.plan_agent", args: [] });
      return review(first.id, first.prompt);
    }
    const limit = run.plan.max_rounds ?? DEFAULT_PLAN_MAX_ROUNDS;
    if (run.rounds >= limit) {
      return active.length ? this.graphWorking(run, done, active, at) : review(first.id, this.msg("work.plan_max_rounds", limit));
    }
    const candidates = options.start?.only ? [first] : [first, ...ready.filter(stage => stage.id !== first.id)];
    let failedStage = first.id;
    try {
      return this.store.transaction(() => {
        const branches = [...active];
        const comment = options.start?.comment;
        if (comment !== undefined) this.store.putComment(WorkComment.parse({ id: this.context.id("wmsg"), task: task.id, author: actor, body: comment, created: at }));
        let dispatched: DispatchedRound | undefined;
        for (const stage of candidates.slice(0, limit - run.rounds)) {
          failedStage = stage.id;
          const branchRun = graphProgress({ ...run, rounds: run.rounds + branches.length - active.length }, done, stage.id);
          const result = this.startRound({ ...task, plan: branchRun }, actor, at, { automatic: true,
            previous: attempts.get(stage.id)?.branch.job ?? null,
            ...(stage.id === first.id ? { to: options.start?.to, approvedSource: options.start?.approvedSource } : {}) });
          const branch = workingBranches(result.turn)[0]!;
          branches.push(branch);
          dispatched ??= result.dispatched;
        }
        const progress = { ...run, rounds: run.rounds + branches.length - active.length };
        return { ...this.graphWorking(progress, done, branches, at, this.planNote(run, branches[0]!.stage)), dispatched };
      });
    } catch (cause) {
      const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
      if ((options.start && !(cause instanceof PlanDispatchUnavailable)) || (code !== "INVALID" && code !== "NOT_FOUND" && code !== "CONFLICT")) throw cause;
      if (active.length) return this.graphWorking(run, done, active, at);
      return { plan: graphProgress(run, done, failedStage), turn: this.failedPlanTurn(task, failedStage, at, cause, code) };
    }
  }

  private applyGraphResult(task: WorkTask, branch: PlanBranch, job: Job, actor: string, at: string): void {
    const run = task.plan!, done = completedStages(run);
    const stage = run.plan.stages.find(node => node.id === branch.stage);
    if (job.status === "done" && !(stage?.kind === "agent" && stage.back_to && requestsChanges(job.result?.report))) done.add(branch.stage);
    const active = workingBranches(task.turn).filter(value => value.job !== branch.job);
    const next = this.advanceGraph(task, run, done, active, actor, at, { settled: job });
    this.recordTransition(task, next, actor, at, next.plan);
  }

  replay(request: WorkCommandRequest, actor: string): WorkCommandResult | undefined {
    const previous = this.store.receipt(actor, request.request_id);
    if (!previous) return;
    if (previous.operation !== JSON.stringify(request.operation)) throw new WorkError("CONFLICT", { key: "index.request_id_was_used_for_a_different_operation", args: [] });
    const result = WorkCommandResult.parse(previous.result);
    if (result.kind === "task") return { ...result, task: this.withTaskFacts(result.task, this.visibleTask(result.task.id)) };
    if (result.kind === "project") this.project(result.project.id);
    if (result.kind === "comment") this.visibleTask(result.comment.task);
    return result;
  }

  command(input: unknown, actor: string, approval?: { by: string; proposal: string; targetSource?: TargetSource }, caller: WorkCaller = { role: "human" }): WorkCommandResult {
    const parsed = WorkCommandRequest.safeParse(input);
    if (!parsed.success) throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
    const request = parsed.data, serialized = JSON.stringify(request.operation);
    if ((request.operation.op === "work.task.delete" || request.operation.op === "work.project.delete") && caller.role !== "human") {
      throw new WorkError("FORBIDDEN", { key: "work.human_only", args: [] });
    }
    return this.store.transaction(() => {
      const previous = this.replay(request, actor);
      if (previous) return previous;
      const operation = request.operation, time = this.context.now().toISOString();
      let result: WorkCommandResult;
      switch (operation.op) {
        case "work.project.create": {
          if (operation.args.default_target) this.context.validateTarget?.(operation.args.default_target);
          if (operation.args.default_plan) this.requireTemplate(operation.args.default_plan);
          const project = WorkProject.parse({ schema_version: 2, type: "project", id: this.context.id("prj"),
            title: operation.args.title, description: operation.args.description ?? "", tags: operation.args.tags ?? [],
            goal: operation.args.goal, repo: operation.args.repo, workdir: operation.args.workdir, default_target: operation.args.default_target, default_plan: operation.args.default_plan, deadline: operation.args.deadline,
            revision: 1, status: "planning", created: time, updated: time, created_by: actor, updated_by: actor });
          this.store.putProject(project); result = { kind: "project", project }; break;
        }
        case "work.project.update": {
          const current = this.project(operation.args.project);
          if (current.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.project_changed_reload_before_saving", args: [] });
          if (operation.args.patch.default_target) this.context.validateTarget?.(operation.args.patch.default_target);
          if (operation.args.patch.default_plan) this.requireTemplate(operation.args.patch.default_plan);
          const project = WorkProject.parse({ ...patch(current, operation.args.patch), revision: current.revision + 1, updated: time, updated_by: actor });
          this.store.putProject(project); result = { kind: "project", project }; break;
        }
        case "work.task.create": {
          const task = WorkTask.parse({ ...operation.args, schema_version: 3, type: "task", id: this.context.id("task"),
            description: operation.args.description ?? "", tags: operation.args.tags ?? [], ...nextTurn({ kind: "create" }, time), dependencies: operation.args.dependencies ?? [], references: operation.args.references ?? [],
            revision: 1, created: time, updated: time, created_by: actor, updated_by: actor });
          this.checkTask(task); this.store.putTask(task); this.initialTurn(task, actor); result = { kind: "task", task }; break;
        }
        case "work.task.update": {
          const current = this.visibleTask(operation.args.task);
          if (current.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_saving", args: [] });
          const task = WorkTask.parse({ ...patch(current, operation.args.patch), revision: current.revision + 1, updated: time, updated_by: actor });
          this.checkTask(task, current); this.store.putTask(task);
          result = { kind: "task", task }; break;
        }
        case "work.task.comment": {
          this.visibleTask(operation.args.task);
          const comment = WorkComment.parse({ id: this.context.id("wmsg"), task: operation.args.task, author: actor, body: operation.args.body, created: time });
          this.store.putComment(comment); result = { kind: "comment", comment }; break;
        }
        case "work.task.hand":
        case "work.task.finish":
        case "work.task.reopen": {
          const task = this.visibleTask(operation.args.task);
          if (task.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_saving", args: [] });
          if ((operation.op === "work.task.reopen") === (task.outcome === "open")) throw new WorkError("CONFLICT", { key: "work.invalid_outcome_transition", args: [] });
          const action: TurnAction = operation.op === "work.task.hand" ? { kind: "hand", to: operation.args.to, note: operation.args.note }
            : operation.op === "work.task.finish" ? { kind: "finish", outcome: operation.args.outcome } : { kind: "reopen" };
          if (operation.op === "work.task.hand") {
            // A self-handoff leaves the round alive to deliver its final report. Check the pending
            // execution as well as turn: an earlier handoff may already have moved turn elsewhere.
            const pending = this.store.executions(task.id).filter(execution => {
              const job = this.context.job?.(execution.job);
              return !execution.applied && (!job || (!job.result && ["queued", "assigned", "running"].includes(job.status)));
            });
            const job = pending[0]?.job ?? (task.turn.reason === "working" ? task.turn.job : undefined);
            if (job && caller.role !== "human") {
              const ownRound = caller.role === "agent" ? caller.job === job : this.context.job?.(job)?.spec.runtime === actor;
              if (!ownRound || pending.length > 1) throw new WorkError("CONFLICT", { key: "work.hand_other_round", args: [] });
            }
            if (job && caller.role === "human") this.context.cancel?.(task.id);
          } else if (operation.op === "work.task.finish") this.context.cancel?.(task.id);
          const updated = this.transition(task, action, actor, time);
          this.checkTask(updated, task); result = { kind: "task", task: updated }; break;
        }
        case "work.task.plan.set": {
          const task = this.visibleTask(operation.args.task);
          if (task.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_saving", args: [] });
          const { plan, from } = operation.args;
          this.validatePlan(plan);
          if (from && (!plan || !plan.stages.some(stage => stage.id === from))) throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
          if (task.turn.reason === "working" || task.outcome !== "open") throw new WorkError("CONFLICT", { key: "work.invalid_outcome_transition", args: [] });
          const run = plan ? this.initialPlan(plan, { at: time, by: approval?.by ?? actor, proposal: approval?.proposal }, from) : undefined;
          const updated = WorkTask.parse({ ...task, plan: run,
            revision: task.revision + 1, updated: time, updated_by: actor });
          this.store.putTask(updated); result = { kind: "task", task: updated }; break;
        }
        case "work.task.checkpoint": {
          if (caller.role !== "human") throw new WorkError("INVALID", { key: "work.human_only", args: [] });
          const task = this.visibleTask(operation.args.task), { stage, action, back_to, comment } = operation.args, run = task.plan;
          if (!run || run.stage !== stage || task.outcome !== "open" || task.turn.holder !== "human"
            || this.store.executions(task.id).some(execution => !execution.applied)) {
            throw new WorkError("CONFLICT", { key: "work.checkpoint_changed", args: [] });
          }
          if (comment !== undefined) this.store.putComment(WorkComment.parse({ id: this.context.id("wmsg"), task: task.id, author: actor, body: comment, created: time }));
          const checkpoint = { stage, action, by: actor };
          let updated: WorkTask;
          if (action === "finish") {
            updated = this.transition(task, { kind: "finish", outcome: "done" }, actor, time); this.checkTask(updated, task);
          } else if (action === "hold") updated = this.transition(task, { kind: "hand", to: "nobody", note: comment?.slice(0, 200) }, actor, time);
          else {
            const index = run.plan.stages.findIndex(value => value.id === stage), current = run.plan.stages[index];
            if (action === "send_back" && (!comment?.trim() || !run.plan.stages.some(value => value.id === back_to && value.kind === "agent"))) {
              throw new WorkError("INVALID", { key: "work.checkpoint_back_to", args: [] });
            }
            if (action === "continue" && stage === "end" && (!graphPlan(run.plan) || !current || completedStages(run).has(stage))) {
              throw new WorkError("INVALID", { key: "work.checkpoint_end", args: [] });
            }
            if (graphPlan(run.plan)) {
              const done = completedStages(run);
              if (action === "send_back") resetStages(run.plan, done, [back_to!]);
              else if (current?.kind === "checkpoint") done.add(current.id);
              const start = action === "continue" && current?.kind === "agent" ? { only: current.id } : undefined;
              const next = this.advanceGraph(task, run, done, [], actor, time, { start, prefer: back_to, skipStops: action === "send_back" });
              const by = next.outcome === "done" ? this.context.systemActor ?? actor : actor;
              updated = this.recordTransition(task, next, by, time, next.plan, checkpoint);
            } else {
              const target = action === "send_back" ? back_to! : current?.kind === "agent" ? current.id : run.plan.stages[index + 1]?.id ?? "end";
              updated = this.transition(task, { kind: "plan", turn: this.planTurn(task, target, actor, time) }, actor, time);
            }
          }
          result = { kind: "task", task: updated }; break;
        }
        case "work.plan_template.save": {
          if (caller.role !== "human" && !(caller.role === "agent" && approval)) throw new WorkError("INVALID", { key: "work.human_only", args: [] });
          const { template: id, name, plan } = operation.args, previous = id ? this.requireTemplate(id) : undefined;
          this.validatePlan(plan);
          const template = PlanTemplate.parse({ id: id ?? this.context.id("wft"), name, plan, created: previous?.created ?? time, updated: time });
          this.store.putPlanTemplate(template); result = { kind: "template", template }; break;
        }
        case "work.plan_template.delete": {
          if (caller.role !== "human") throw new WorkError("INVALID", { key: "work.human_only", args: [] });
          const id = operation.args.template;
          this.requireTemplate(id);
          for (const project of this.store.projects().filter(value => value.default_plan === id)) {
            this.store.putProject({ ...project, default_plan: undefined, revision: project.revision + 1, updated: time, updated_by: actor });
          }
          this.store.deletePlanTemplate(id); result = { kind: "removed", id }; break;
        }
        case "work.task.delete": {
          const task = this.visibleTask(operation.args.task);
          if (task.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_saving", args: [] });
          const stopped = this.context.cancel?.(task.id) || undefined;
          if (task.turn.reason === "working") {
            // Settle the round without changing the task's outcome or advancing its plan.
            const branch = workingBranches(task.turn)[0];
            this.transition(task, { kind: "result", status: "cancelled", job: branch?.job ?? task.turn.job!, round: branch?.round ?? task.turn.round! }, actor, time);
          } else this.store.putTask({ ...task, revision: task.revision + 1, updated: time, updated_by: actor });
          const item = this.trashItem({ kind: "task", id: task.id, title: task.title, project: task.project, stopped_job: stopped }, actor, time);
          result = { kind: "trashed", item }; break;
        }
        case "work.project.delete": {
          const project = this.project(operation.args.project);
          if (project.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.project_changed_reload_before_saving", args: [] });
          const detached = this.store.tasks().filter(task => task.project === project.id);
          for (const task of detached) this.store.putTask({ ...task, project: undefined, revision: task.revision + 1, updated: time, updated_by: actor });
          this.store.putProject({ ...project, revision: project.revision + 1, updated: time, updated_by: actor });
          const item = this.trashItem({ kind: "project", id: project.id, title: project.title, detached_tasks: detached.map(task => task.id) }, actor, time);
          result = { kind: "trashed", item }; break;
        }
        case "work.task.grant":
          // ADR 0049 第 3 节：契约已就位，执行由 H1-9 实现。
          throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] }, "work.task.grant is not implemented yet (H1-9)");
        case "work.task.dispatch": {
          let task = this.visibleTask(operation.args.task);
          const { expected_revision, to, comment } = operation.args;
          if (expected_revision !== undefined && task.revision !== expected_revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_dispatching", args: [] });
          if (caller.role === "human" && to === undefined && !task.plan && task.project && task.turn.reason !== "answer") {
            const id = this.project(task.project).default_plan;
            if (id) {
              this.checkDispatch(task);
              task = { ...task, plan: this.initialPlan(this.requireTemplate(id).plan, { at: time, by: actor }) };
              const first = this.planStage(task);
              if (first?.kind === "checkpoint") {
                result = { kind: "task", task: this.recordTransition(task, { turn: this.reviewTurn(task, first.id, time, first.prompt) }, actor, time) };
                break;
              }
            }
          }
          if (task.plan && graphPlan(task.plan.plan)) {
            this.checkDispatch(task);
            const run = task.plan;
            if (this.planStage(task)?.kind !== "agent") throw new WorkError("CONFLICT", { key: "work.plan_agent", args: [] });
            const retry = run.rounds > 0 && task.turn.stage === run.stage && task.turn.reason !== "review";
            const next = this.advanceGraph(task, run, completedStages(run), [], actor, time, { prefer: run.stage,
              start: { to, comment, approvedSource: approval?.targetSource, only: retry ? run.stage : undefined } });
            const updated = this.recordTransition(task, next, actor, time, next.plan);
            result = next.dispatched ? { kind: "job", ...next.dispatched } : { kind: "task", task: updated };
            break;
          }
          let started: ReturnType<WorkService["startRound"]>;
          try {
            started = this.store.transaction(() => this.startRound(task, actor, time, { to, comment, approvedSource: approval?.targetSource }));
          } catch (cause) {
            if (!task.plan || !(cause instanceof PlanDispatchUnavailable)) throw cause;
            started = { turn: this.failedPlanTurn(task, task.plan.stage, time, cause, cause.code) };
          }
          const updated = this.transition(task, { kind: "plan", turn: started.turn }, actor, time);
          result = started.dispatched ? { kind: "job", ...started.dispatched } : { kind: "task", task: updated }; break;
        }
      }
      result = WorkCommandResult.parse(result);
      this.store.putReceipt(actor, request.request_id, serialized, result);
      return result.kind === "task" ? { ...result, task: this.withTaskFacts(result.task) } : result;
    });
  }

  private trashItem(input: Omit<TrashItem, "deleted_at" | "deleted_by" | "expires_at">, actor: string, time: string): TrashItem {
    const item = TrashItem.parse({ ...input, deleted_by: actor, deleted_at: time,
      expires_at: new Date(Date.parse(time) + TRASH_RETENTION_DAYS * 86_400_000).toISOString() });
    this.store.putTrash(item);
    return item;
  }

  restore(item: TrashItem, actor: string): string[] | undefined {
    return this.store.transaction(() => {
      const restored = item.detached_tasks?.filter(id => {
        const task = this.store.task(id);
        if (!task || task.project) return false;
        this.store.putTask({ ...task, project: item.id, revision: task.revision + 1, updated: this.context.now().toISOString(), updated_by: actor });
        return true;
      });
      this.store.removeTrash(item.id);
      return restored;
    });
  }

  /** A terminal result appends progress and advances the current turn exactly once. */
  applyResult(job: Job): void {
    if (!["done", "waiting_for_human", "failed", "unknown", "cancelled"].includes(job.status)) return;
    this.store.transaction(() => {
      const execution = this.store.executions().find((value) => value.job === job.spec.id);
      if (!execution || execution.applied) return;
      const task = this.store.task(execution.task);
      if (!task) {
        this.store.putExecution({ ...execution, applied: true });
        return;
      }
      const body = [this.msg("Round ${0}: ${1}", execution.round, job.status), job.result?.report ?? "", job.result?.question ? this.msg("Question: ${0}", job.result.question) : "", job.result?.error ?? ""].filter(Boolean).join("\n\n");
      const shown = secret(body) ? this.msg("Round ${0}: ${1}\n\nReport may contain sensitive information and was not added to task discussion; use lumio job show ${2} to view it.", execution.round, job.status, job.spec.id)
        : `${body.slice(0, 3000)}${body.length > 3000 ? this.msg("\n\n… (truncated)") : ""}`;
      this.store.putComment(WorkComment.parse({ id: this.context.id("wmsg"), task: execution.task, author: job.spec.runtime,
        body: shown, created: this.context.now().toISOString() }));
      this.store.putExecution({ ...execution, applied: true });
      if (this.store.trash(task.id) || task.outcome !== "open" || task.turn.reason !== "working") return;
      const actor = this.context.systemActor ?? job.spec.runtime, at = this.context.now().toISOString();
      if (task.plan && graphPlan(task.plan.plan)) {
        const branch = workingBranches(task.turn).find(value => value.job === job.spec.id);
        if (branch) this.applyGraphResult(task, branch, job, actor, at);
      } else if (task.turn.job === job.spec.id) {
        this.transition(task, { kind: "result", status: job.status, round: execution.round, job: job.spec.id, report: job.result?.report }, actor, at);
      }
    });
  }
}

/** Compatibility projection for existing read filters and the R4-5 Web transition. */
export function legacyTaskStatus(task: WorkTask): string {
  return task.outcome !== "open" ? task.outcome : task.turn.holder === "nobody" ? "paused" : task.turn.holder === "external" ? "waiting" : task.turn.reason === "todo" ? "todo" : "active";
}

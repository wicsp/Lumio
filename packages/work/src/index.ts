import { nextTurn, type TurnAction, type PlannedDelivery } from "./turn.ts";
export { nextTurn, migrateTurn, type LegacyTurnFacts, type PlannedDelivery } from "./turn.ts";
import {
  WorkProject, WorkTask, WorkComment, WorkExecution, WorkTaskDetail,
  WorkCommandRequest, WorkCommandResult, TaskTurnChange, Turn, PlanTemplate, DEFAULT_PLAN_MAX_ROUNDS, textContainsCardNumber,
  type PlanRun,
  type ActorRole, type ID_PREFIXES, type Job,
} from "@lumio/schema";

export class WorkError extends Error {
  constructor(public readonly code: "INVALID" | "NOT_FOUND" | "CONFLICT" | "INTERNAL", public readonly params: { key: string; args: readonly unknown[] }) {
    super(code); this.name = "WorkError";
  }
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
  putExecution(value: WorkExecution): void;
  turns(task: string): TaskTurnChange[];
  putTurn(value: TaskTurnChange): void;
  planTemplates(): PlanTemplate[];
  putPlanTemplate(value: PlanTemplate): void;
  deletePlanTemplate(id: string): void;
  receipt(actor: string, request: string): { operation: string; result: WorkCommandResult } | undefined;
  putReceipt(actor: string, request: string, operation: string, result: WorkCommandResult): void;
  transaction<T>(action: () => T): T;
}

/** Trusted execution identity supplied by the application, never by command arguments. */
export interface WorkCaller { role: ActorRole; job?: string }

export interface WorkContext {
  systemActor?: string;
  auditPlan?(change: TaskTurnChange, plan: PlanRun): void;
  job?(id: string): Job | undefined;
  text?: (key: string, ...args: unknown[]) => string;
  now(): Date;
  id(prefix: (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]): string;
  validateTarget?(target: string): void;
  dispatch?(task: WorkTask, input: string, round: number, to?: string): Job;
  cancel?(task: string): void;
  agentForJob?(job: string): string | undefined;
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
    const value = this.store.project(id);
    if (!value) throw new WorkError("NOT_FOUND", { key: "index.project_not_found", args: [] });
    return WorkProject.parse(value);
  }
  projects(): WorkProject[] { return WorkProject.array().parse(this.store.projects()); }
  task(id: string): WorkTask {
    const value = this.store.task(id);
    if (!value) throw new WorkError("NOT_FOUND", { key: "index.task_not_found", args: [] });
    return WorkTask.parse(value);
  }
  tasks(filter: { project?: string; status?: string; query?: string } = {}): WorkTask[] {
    const query = filter.query?.trim().toLocaleLowerCase();
    return WorkTask.array().parse(this.store.tasks()).filter((task) =>
      (!filter.project || task.project === filter.project) && (!filter.status || legacyTaskStatus(task) === filter.status)
      && (!query || `${task.title}\n${task.description}\n${task.tags.join(" ")}`.toLocaleLowerCase().includes(query)));
  }
  detail(id: string): WorkTaskDetail {
    return WorkTaskDetail.parse({ task: this.task(id), comments: this.store.comments(id), executions: this.store.executions(id), turns: this.store.turns(id) });
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
    const updated = WorkTask.parse({ ...task, ...change, plan, revision: task.revision + 1, updated: at, updated_by: by });
    this.store.putTask(updated);
    const record = TaskTurnChange.parse({ task: task.id, at, by, from: task.turn, to: updated.turn,
      ...(change.outcome !== undefined ? { outcome: change.outcome } : {}) });
    this.store.putTurn(record);
    if (plan && updated.turn.stage) this.context.auditPlan?.(record, plan);
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

  private checkTask(task: WorkTask): void {
    if (task.project) this.project(task.project);
    if (task.parent) {
      const parent = this.task(task.parent);
      if (parent.id === task.id) throw new WorkError("CONFLICT", { key: "index.a_task_cannot_be_its_own_parent", args: [] });
      if (parent.project && task.project && parent.project !== task.project) throw new WorkError("CONFLICT", { key: "index.parent_task_must_belong_to_the_same_project", args: [] });
      const seen = new Set([task.id]);
      let current: WorkTask | undefined = parent;
      while (current) {
        if (seen.has(current.id)) throw new WorkError("CONFLICT", { key: "index.parent_relationships_must_not_form_cycles", args: [] });
        seen.add(current.id); current = current.parent ? this.task(current.parent) : undefined;
      }
    }
    if (new Set(task.dependencies).size !== task.dependencies.length) throw new WorkError("INVALID", { key: "index.dependency_tasks_must_not_be_duplicated", args: [] });
    const visit = (id: string, seen: Set<string>): void => {
      if (id === task.id) throw new WorkError("CONFLICT", { key: "index.task_dependencies_must_not_form_cycles", args: [] });
      if (seen.has(id)) return;
      seen.add(id);
      for (const next of this.task(id).dependencies) visit(next, seen);
    };
    for (const id of task.dependencies) visit(id, new Set());
    if (task.outcome === "done" && task.dependencies.some((id) => this.task(id).outcome !== "done")) {
      throw new WorkError("CONFLICT", { key: "index.dependency_tasks_are_not_completed", args: [] });
    }
  }

  /** Freeze the observed version and implicit previous agent before presenting a proposal. */
  proposalRequest(input: WorkCommandRequest): WorkCommandRequest {
    const request = WorkCommandRequest.parse(input), operation = request.operation;
    if (operation.op !== "work.task.dispatch" && operation.op !== "work.task.plan.set") throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
    const task = this.task(operation.args.task);
    if (operation.args.expected_revision !== undefined && operation.args.expected_revision !== task.revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_dispatching", args: [] });
    if (operation.op === "work.task.plan.set") this.validatePlan(operation.args.plan);
    return WorkCommandRequest.parse({ ...request, operation: { ...operation, args: { ...operation.args, expected_revision: task.revision,
      ...(operation.op === "work.task.dispatch" ? { to: this.taskTarget(task, operation.args.to) } : {}) } } });
  }
  private dispatchTarget(task: string, explicit?: string): string {
    const latest = this.store.executions(task).reduce<WorkExecution | undefined>((prior, value) => !prior || value.round > prior.round ? value : prior, undefined);
    const to = explicit ?? (latest ? this.context.agentForJob?.(latest.job) : undefined);
    if (!to || to === "human") throw new WorkError("INVALID", { key: "index.specify_an_agent_assignee_e_g_pi_server", args: [] });
    return to;
  }
  private taskTarget(task: WorkTask, explicit?: string): string {
    const stage = task.plan?.plan.stages.find(stage => stage.id === task.plan?.stage);
    if (explicit) this.context.validateTarget?.(explicit);
    if (task.plan && (stage?.kind !== "agent" || (explicit !== undefined && explicit !== stage.agent))) {
      throw new WorkError("CONFLICT", { key: "work.plan_agent", args: [] });
    }
    const target = this.dispatchTarget(task.id, stage?.kind === "agent" ? stage.agent : explicit);
    this.context.validateTarget?.(target);
    return target;
  }

  private validatePlan(plan: import("@lumio/schema").HandoffPlan | null): void {
    for (const stage of plan?.stages ?? []) if (stage.kind === "agent") this.context.validateTarget?.(stage.agent);
  }

  private reviewTurn(task: WorkTask, stage: string, at: string, note?: string): Turn {
    const latest = this.store.executions(task.id).at(-1);
    return Turn.parse({ holder: "human", reason: "review", since: at, stage, note,
      round: latest?.round, job: latest?.job });
  }

  /** The same safeguards apply to initial delegation, retries and automatic plan handoffs. */
  private startRound(task: WorkTask, actor: string, at: string, explicit?: string, comment?: string, automatic = false): { turn: Turn; job?: Job } {
    if (task.outcome !== "open" || task.turn.holder === "nobody" || (task.turn.reason === "working" && !automatic)) {
      throw new WorkError("CONFLICT", { key: "index.task_is_done_cancelled_or_paused", args: [] });
    }
    if (task.dependencies.some(id => this.task(id).outcome !== "done")) throw new WorkError("CONFLICT", { key: "index.dependency_tasks_are_not_completed", args: [] });
    const executions = this.store.executions(task.id);
    if (executions.some(execution => !execution.applied)) throw new WorkError("CONFLICT", { key: "index.this_task_already_has_a_running_round_or_pending_result", args: [] });
    const to = this.taskTarget(task, explicit);
    if (task.plan && task.plan.rounds >= (task.plan.plan.max_rounds ?? DEFAULT_PLAN_MAX_ROUNDS)) {
      return { turn: this.reviewTurn(task, task.plan.stage, at, this.msg("work.plan_max_rounds", task.plan.plan.max_rounds ?? DEFAULT_PLAN_MAX_ROUNDS)) };
    }
    if (!this.context.dispatch) throw new WorkError("INTERNAL", { key: "index.execution_capability_is_not_configured", args: [] });
    if (comment !== undefined) this.store.putComment(WorkComment.parse({ id: this.context.id("wmsg"), task: task.id, author: actor, body: comment, created: at }));
    const latest = executions.reduce<WorkExecution | undefined>((prior, value) => !prior || value.round > prior.round ? value : prior, undefined);
    const snapshot = this.snapshot(task, latest), round = (latest?.round ?? 0) + 1;
    const job = this.context.dispatch(task, snapshot, round, to);
    this.store.putExecution(WorkExecution.parse({ task: task.id, job: job.spec.id, round, input_revision: task.revision,
      input_snapshot: snapshot, created: at, applied: false }));
    const note = task.plan ? `Plan ${task.plan.approved.at} by ${task.plan.approved.by}; stage ${task.plan.stage}` : undefined;
    return { job, turn: nextTurn({ kind: "dispatch", to: this.context.agentForJob?.(job.spec.id) ?? to, round, job: job.spec.id,
      stage: task.plan?.stage, note }, at).turn };
  }

  private planTurn(task: WorkTask, stageId: string, actor: string, at: string): Turn {
    const run = task.plan!;
    if (stageId === "end") return this.reviewTurn(task, "end", at);
    const stage = run.plan.stages.find(stage => stage.id === stageId);
    if (!stage) throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
    if (stage.kind === "checkpoint") return this.reviewTurn(task, stage.id, at, stage.prompt);
    try {
      return this.store.transaction(() => this.startRound({ ...task, plan: { ...run, stage: stage.id } }, actor, at, stage.agent, undefined, true).turn);
    } catch (cause) {
      // An unavailable approved agent or newly blocked dependency needs human attention.
      // Storage/audit faults still roll back result application and remain retryable.
      const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
      if (code !== "INVALID" && code !== "NOT_FOUND" && code !== "CONFLICT") throw cause;
      return Turn.parse({ ...this.reviewTurn(task, stage.id, at), reason: "failed", note: this.msg("work.plan_dispatch_failed", stage.id, code) });
    }
  }

  private plannedDelivery: PlannedDelivery = (task, action, at) => {
    const run = task.plan!, index = run.plan.stages.findIndex(stage => stage.id === run.stage), current = run.plan.stages[index];
    const back = current?.kind === "agent" && action.report?.split(/\r?\n/).some(line => line.trim() === "<lumio-outcome>changes</lumio-outcome>") ? current.back_to : undefined;
    return this.planTurn(task, back ?? run.plan.stages[index + 1]?.id ?? "end", this.context.systemActor ?? run.approved.by, at);
  };

  replay(request: WorkCommandRequest, actor: string): WorkCommandResult | undefined {
    const previous = this.store.receipt(actor, request.request_id);
    if (!previous) return;
    if (previous.operation !== JSON.stringify(request.operation)) throw new WorkError("CONFLICT", { key: "index.request_id_was_used_for_a_different_operation", args: [] });
    return WorkCommandResult.parse(previous.result);
  }

  command(input: unknown, actor: string, approval?: { by: string; proposal: string }, caller: WorkCaller = { role: "human" }): WorkCommandResult {
    const parsed = WorkCommandRequest.safeParse(input);
    if (!parsed.success) throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
    const request = parsed.data, serialized = JSON.stringify(request.operation);
    return this.store.transaction(() => {
      const previous = this.replay(request, actor);
      if (previous) return previous;
      const operation = request.operation, time = this.context.now().toISOString();
      let result: WorkCommandResult;
      switch (operation.op) {
        case "work.project.create": {
          const project = WorkProject.parse({ schema_version: 2, type: "project", id: this.context.id("prj"),
            title: operation.args.title, description: operation.args.description ?? "", tags: operation.args.tags ?? [],
            goal: operation.args.goal, repo: operation.args.repo, workdir: operation.args.workdir, deadline: operation.args.deadline,
            revision: 1, status: "planning", created: time, updated: time, created_by: actor, updated_by: actor });
          this.store.putProject(project); result = { kind: "project", project }; break;
        }
        case "work.project.update": {
          const current = this.project(operation.args.project);
          if (current.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.project_changed_reload_before_saving", args: [] });
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
          const current = this.task(operation.args.task);
          if (current.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_saving", args: [] });
          const task = WorkTask.parse({ ...patch(current, operation.args.patch), revision: current.revision + 1, updated: time, updated_by: actor });
          this.checkTask(task); this.store.putTask(task);
          result = { kind: "task", task }; break;
        }
        case "work.task.comment": {
          this.task(operation.args.task);
          const comment = WorkComment.parse({ id: this.context.id("wmsg"), task: operation.args.task, author: actor, body: operation.args.body, created: time });
          this.store.putComment(comment); result = { kind: "comment", comment }; break;
        }
        case "work.task.hand":
        case "work.task.finish":
        case "work.task.reopen": {
          const task = this.task(operation.args.task);
          if (task.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_saving", args: [] });
          if ((operation.op === "work.task.reopen") === (task.outcome === "open")) throw new WorkError("CONFLICT", { key: "work.invalid_outcome_transition", args: [] });
          const action: TurnAction = operation.op === "work.task.hand" ? { kind: "hand", to: operation.args.to, note: operation.args.note }
            : operation.op === "work.task.finish" ? { kind: "finish", outcome: operation.args.outcome } : { kind: "reopen" };
          if (operation.op === "work.task.hand") {
            // A self-handoff leaves the round alive to deliver its final report. Check the pending
            // execution as well as turn: an earlier handoff may already have moved turn elsewhere.
            const pending = this.store.executions(task.id).find(execution => {
              const job = this.context.job?.(execution.job);
              return !execution.applied && (!job || (!job.result && ["queued", "assigned", "running"].includes(job.status)));
            });
            const job = pending?.job ?? (task.turn.reason === "working" ? task.turn.job : undefined);
            if (job && caller.role !== "human") {
              const ownRound = caller.role === "agent" ? caller.job === job : this.context.job?.(job)?.spec.runtime === actor;
              if (!ownRound) throw new WorkError("CONFLICT", { key: "work.hand_other_round", args: [] });
            }
            if (job && caller.role === "human") this.context.cancel?.(task.id);
          } else if (operation.op === "work.task.finish") this.context.cancel?.(task.id);
          const updated = this.transition(task, action, actor, time);
          this.checkTask(updated); result = { kind: "task", task: updated }; break;
        }
        case "work.task.plan.set": {
          const task = this.task(operation.args.task);
          if (task.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_saving", args: [] });
          const { plan, from } = operation.args;
          this.validatePlan(plan);
          if (from && (!plan || !plan.stages.some(stage => stage.id === from))) throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
          if (task.turn.reason === "working" || task.outcome !== "open") throw new WorkError("CONFLICT", { key: "work.invalid_outcome_transition", args: [] });
          const updated = WorkTask.parse({ ...task, plan: plan ? { plan, approved: { at: time, by: approval?.by ?? actor, ...(approval ? { proposal: approval.proposal } : {}) }, stage: from ?? plan.stages[0]!.id, rounds: 0 } : undefined,
            revision: task.revision + 1, updated: time, updated_by: actor });
          this.store.putTask(updated); result = { kind: "task", task: updated }; break;
        }
        case "work.task.checkpoint": {
          if (caller.role !== "human") throw new WorkError("INVALID", { key: "work.human_only", args: [] });
          const task = this.task(operation.args.task), { stage, action, back_to, comment } = operation.args, run = task.plan;
          if (!run || run.stage !== stage || task.outcome !== "open" || task.turn.holder !== "human"
            || this.store.executions(task.id).some(execution => !execution.applied)) {
            throw new WorkError("CONFLICT", { key: "work.checkpoint_changed", args: [] });
          }
          if (comment !== undefined) this.store.putComment(WorkComment.parse({ id: this.context.id("wmsg"), task: task.id, author: actor, body: comment, created: time }));
          let updated: WorkTask;
          if (action === "finish") {
            updated = this.transition(task, { kind: "finish", outcome: "done" }, actor, time); this.checkTask(updated);
          } else if (action === "hold") updated = this.transition(task, { kind: "hand", to: "nobody", note: comment?.slice(0, 200) }, actor, time);
          else {
            const index = run.plan.stages.findIndex(value => value.id === stage), current = run.plan.stages[index];
            if (action === "send_back" && (!comment?.trim() || !run.plan.stages.some(value => value.id === back_to && value.kind === "agent"))) {
              throw new WorkError("INVALID", { key: "work.checkpoint_back_to", args: [] });
            }
            if (action === "continue" && stage === "end") throw new WorkError("INVALID", { key: "work.checkpoint_end", args: [] });
            const target = action === "send_back" ? back_to! : current?.kind === "agent" ? current.id : run.plan.stages[index + 1]?.id ?? "end";
            updated = this.transition(task, { kind: "plan", turn: this.planTurn(task, target, actor, time) }, actor, time);
          }
          result = { kind: "task", task: updated }; break;
        }
        case "work.plan_template.save": {
          if (caller.role !== "human") throw new WorkError("INVALID", { key: "work.human_only", args: [] });
          const { template: id, name, plan } = operation.args, previous = id ? this.planTemplates().find(value => value.id === id) : undefined;
          if (id && !previous) throw new WorkError("NOT_FOUND", { key: "work.template_not_found", args: [] });
          const template = PlanTemplate.parse({ id: id ?? this.context.id("wft"), name, plan, created: previous?.created ?? time, updated: time });
          this.store.putPlanTemplate(template); result = { kind: "template", template }; break;
        }
        case "work.plan_template.delete": {
          if (caller.role !== "human") throw new WorkError("INVALID", { key: "work.human_only", args: [] });
          const id = operation.args.template;
          if (!this.planTemplates().some(value => value.id === id)) throw new WorkError("NOT_FOUND", { key: "work.template_not_found", args: [] });
          this.store.deletePlanTemplate(id); result = { kind: "removed", id }; break;
        }
        case "work.task.dispatch": {
          const task = this.task(operation.args.task);
          if (operation.args.expected_revision !== undefined && task.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_dispatching", args: [] });
          const started = this.startRound(task, actor, time, operation.args.to, operation.args.comment);
          const updated = this.transition(task, { kind: "plan", turn: started.turn }, actor, time);
          result = started.job ? { kind: "job", job: started.job } : { kind: "task", task: updated }; break;
        }
      }
      result = WorkCommandResult.parse(result);
      this.store.putReceipt(actor, request.request_id, serialized, result);
      return result;
    });
  }

  /** A terminal result appends progress and hands back exactly once; it never finishes the task. */
  applyResult(job: Job): void {
    if (!["done", "waiting_for_human", "failed", "unknown", "cancelled"].includes(job.status)) return;
    this.store.transaction(() => {
      const execution = this.store.executions().find((value) => value.job === job.spec.id);
      if (!execution || execution.applied) return;
      const body = [this.msg("Round ${0}: ${1}", execution.round, job.status), job.result?.report ?? "", job.result?.question ? this.msg("Question: ${0}", job.result.question) : "", job.result?.error ?? ""].filter(Boolean).join("\n\n");
      const shown = secret(body) ? this.msg("Round ${0}: ${1}\n\nReport may contain sensitive information and was not added to task discussion; use lumio job show ${2} to view it.", execution.round, job.status, job.spec.id)
        : `${body.slice(0, 3000)}${body.length > 3000 ? this.msg("\n\n… (truncated)") : ""}`;
      this.store.putComment(WorkComment.parse({ id: this.context.id("wmsg"), task: execution.task, author: job.spec.runtime,
        body: shown, created: this.context.now().toISOString() }));
      this.store.putExecution({ ...execution, applied: true });
      const task = this.task(execution.task);
      if (task.outcome === "open" && task.turn.reason === "working" && task.turn.job === job.spec.id) {
        this.transition(task, { kind: "result", status: job.status, round: execution.round, job: job.spec.id, report: job.result?.report },
          this.context.systemActor ?? job.spec.runtime, this.context.now().toISOString());
      }
    });
  }
}

/** Compatibility projection for existing read filters and the R4-5 Web transition. */
export function legacyTaskStatus(task: WorkTask): string {
  return task.outcome !== "open" ? task.outcome : task.turn.holder === "nobody" ? "paused" : task.turn.holder === "external" ? "waiting" : task.turn.reason === "todo" ? "todo" : "active";
}

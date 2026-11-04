import {
  WorkProject, WorkTask, WorkComment, WorkExecution, WorkTaskDetail,
  WorkCommandRequest, WorkCommandResult, textContainsCardNumber,
  type ID_PREFIXES, type Job,
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
  receipt(actor: string, request: string): { operation: string; result: WorkCommandResult } | undefined;
  putReceipt(actor: string, request: string, operation: string, result: WorkCommandResult): void;
  transaction<T>(action: () => T): T;
}

export interface WorkContext {
  text?: (key: string, ...args: unknown[]) => string;
  now(): Date;
  id(prefix: (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]): string;
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
      (!filter.project || task.project === filter.project) && (!filter.status || task.status === filter.status)
      && (!query || `${task.title}\n${task.description}\n${task.tags.join(" ")}`.toLocaleLowerCase().includes(query)));
  }
  detail(id: string): WorkTaskDetail {
    return WorkTaskDetail.parse({ task: this.task(id), comments: this.store.comments(id), executions: this.store.executions(id) });
  }

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
      for (const value of tasks.data) this.store.putTask(value);
      for (const value of tasks.data) this.checkTask(value);
      for (const value of executions.data) this.store.putExecution(value);
    });
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
    if (task.status === "done" && task.dependencies.some((id) => this.task(id).status !== "done")) {
      throw new WorkError("CONFLICT", { key: "index.dependency_tasks_are_not_completed", args: [] });
    }
  }

  command(input: unknown, actor: string): WorkCommandResult {
    const parsed = WorkCommandRequest.safeParse(input);
    if (!parsed.success) throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
    const request = parsed.data, serialized = JSON.stringify(request.operation);
    return this.store.transaction(() => {
      const previous = this.store.receipt(actor, request.request_id);
      if (previous) {
        if (previous.operation !== serialized) throw new WorkError("CONFLICT", { key: "index.request_id_was_used_for_a_different_operation", args: [] });
        return WorkCommandResult.parse(previous.result);
      }
      const operation = request.operation, time = this.context.now().toISOString();
      let result: WorkCommandResult;
      switch (operation.op) {
        case "work.project.create": {
          const project = WorkProject.parse({ schema_version: 2, type: "project", id: this.context.id("prj"),
            title: operation.args.title, description: operation.args.description ?? "", tags: operation.args.tags ?? [],
            goal: operation.args.goal, repo: operation.args.repo, deadline: operation.args.deadline,
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
          const task = WorkTask.parse({ ...operation.args, schema_version: 2, type: "task", id: this.context.id("task"),
            description: operation.args.description ?? "", tags: operation.args.tags ?? [], assignee: operation.args.assignee ?? "human",
            status: operation.args.status ?? "todo", dependencies: operation.args.dependencies ?? [], references: operation.args.references ?? [],
            revision: 1, created: time, updated: time, created_by: actor, updated_by: actor });
          this.checkTask(task); this.store.putTask(task); result = { kind: "task", task }; break;
        }
        case "work.task.update": {
          const current = this.task(operation.args.task);
          if (current.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_saving", args: [] });
          const task = WorkTask.parse({ ...patch(current, operation.args.patch), revision: current.revision + 1, updated: time, updated_by: actor });
          this.checkTask(task); this.store.putTask(task);
          if (["paused", "cancelled"].includes(task.status)) this.context.cancel?.(task.id);
          result = { kind: "task", task }; break;
        }
        case "work.task.comment": {
          this.task(operation.args.task);
          const comment = WorkComment.parse({ id: this.context.id("wmsg"), task: operation.args.task, author: actor, body: operation.args.body, created: time });
          this.store.putComment(comment); result = { kind: "comment", comment }; break;
        }
        case "work.task.acknowledge": {
          const task = this.task(operation.args.task);
          const execution = this.store.executions(task.id).find(value => value.round === operation.args.round);
          if (!execution) throw new WorkError("NOT_FOUND", { key: "work.round_not_found", args: [] });
          if (!execution.applied) throw new WorkError("CONFLICT", { key: "work.round_not_applied", args: [] });
          if (!execution.acknowledged) this.store.putExecution({ ...execution, acknowledged: { at: time, by: actor } });
          result = { kind: "task", task }; break;
        }
        case "work.task.workflow.set":
        case "work.task.workflow.decide":
        case "work.workflow_template.save":
        case "work.workflow_template.delete":
          // Contract from ADR 0031; implemented in R4-2. Refused until then rather than silently ignored.
          throw new WorkError("INVALID", { key: "index.invalid_work_command_parameters", args: [] });
        case "work.task.dispatch": {
          const task = this.task(operation.args.task);
          if (operation.args.expected_revision !== undefined && task.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", { key: "index.task_changed_reload_before_dispatching", args: [] });
          if (["done", "cancelled", "paused"].includes(task.status)) throw new WorkError("CONFLICT", { key: "index.task_is_done_cancelled_or_paused", args: [] });
          if (task.dependencies.some((id) => this.task(id).status !== "done")) throw new WorkError("CONFLICT", { key: "index.dependency_tasks_are_not_completed", args: [] });
          const executions = this.store.executions(task.id);
          const latest = executions.reduce<WorkExecution | undefined>((prior, value) => !prior || value.round > prior.round ? value : prior, undefined);
          const to = operation.args.to ?? (operation.args.comment !== undefined && latest ? this.context.agentForJob?.(latest.job) : undefined) ?? task.assignee;
          if (to === "human") throw new WorkError("INVALID", { key: "index.specify_an_agent_assignee_e_g_pi_server", args: [] });
          if (executions.some((execution) => !execution.applied)) throw new WorkError("CONFLICT", { key: "index.this_task_already_has_a_running_round_or_pending_result", args: [] });
          if (!this.context.dispatch) throw new WorkError("INTERNAL", { key: "index.execution_capability_is_not_configured", args: [] });
          if (operation.args.comment !== undefined) this.store.putComment(WorkComment.parse({
            id: this.context.id("wmsg"), task: task.id, author: actor, body: operation.args.comment, created: time,
          }));
          const comments = this.store.comments(task.id);
          const snapshot = [`# ${task.title}`, "", task.description, ...comments.flatMap((comment) => ["", this.msg("## Discussion ${0} ${1}", comment.author, comment.created), comment.body])].join("\n");
          const round = executions.reduce((maximum, value) => Math.max(maximum, value.round), 0) + 1;
          const job = this.context.dispatch(task, snapshot, round, to);
          this.store.putExecution(WorkExecution.parse({ task: task.id, job: job.spec.id, round, input_revision: task.revision,
            input_snapshot: snapshot, created: time, applied: false }));
          if (task.status === "todo") this.store.putTask(WorkTask.parse({ ...task, status: "active", revision: task.revision + 1, updated: time, updated_by: actor }));
          result = { kind: "job", job }; break;
        }
      }
      result = WorkCommandResult.parse(result);
      this.store.putReceipt(actor, request.request_id, serialized, result);
      return result;
    });
  }

  /** A result updates progress once; it never marks the whole task done or changes its owner. */
  applyResult(job: Job): void {
    if (!job.result && job.status !== "cancelled") return;
    this.store.transaction(() => {
      const execution = this.store.executions().find((value) => value.job === job.spec.id);
      if (!execution || execution.applied) return;
      const body = [this.msg("Round ${0}: ${1}", execution.round, job.status), job.result?.report ?? "", job.result?.question ? this.msg("Question: ${0}", job.result.question) : "", job.result?.error ?? ""].filter(Boolean).join("\n\n");
      const shown = secret(body) ? this.msg("Round ${0}: ${1}\n\nReport may contain sensitive information and was not added to task discussion; use lumio job show ${2} to view it.", execution.round, job.status, job.spec.id)
        : `${body.slice(0, 3000)}${body.length > 3000 ? this.msg("\n\n… (truncated)") : ""}`;
      this.store.putComment(WorkComment.parse({ id: this.context.id("wmsg"), task: execution.task, author: job.spec.runtime,
        body: shown, created: this.context.now().toISOString() }));
      this.store.putExecution({ ...execution, applied: true });
    });
  }
}

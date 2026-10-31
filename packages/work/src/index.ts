import {
  WorkProject, WorkTask, WorkComment, WorkExecution, WorkTaskDetail,
  WorkCommandRequest, WorkCommandResult, textContainsCardNumber,
  type ID_PREFIXES, type Job,
} from "@lumio/schema";

export class WorkError extends Error {
  constructor(public readonly code: "INVALID" | "NOT_FOUND" | "CONFLICT" | "INTERNAL", message: string) {
    super(message); this.name = "WorkError";
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
  now(): Date;
  id(prefix: (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]): string;
  dispatch?(task: WorkTask, input: string, round: number, to?: string): Job;
  cancel?(task: string): void;
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
  constructor(private readonly store: WorkStore, private readonly context: WorkContext) {}

  project(id: string): WorkProject {
    const value = this.store.project(id);
    if (!value) throw new WorkError("NOT_FOUND", "找不到项目");
    return WorkProject.parse(value);
  }
  projects(): WorkProject[] { return WorkProject.array().parse(this.store.projects()); }
  task(id: string): WorkTask {
    const value = this.store.task(id);
    if (!value) throw new WorkError("NOT_FOUND", "找不到任务");
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
    if (!projects.success || !tasks.success || !executions.success) throw new WorkError("INVALID", "历史工作对象格式不合法");
    this.store.transaction(() => {
      const ids = [...projects.data.map((value) => value.id), ...tasks.data.map((value) => value.id)];
      if (new Set(ids).size !== ids.length || projects.data.some((value) => this.store.project(value.id)) || tasks.data.some((value) => this.store.task(value.id))) throw new WorkError("CONFLICT", "历史对象 ID 已存在或重复");
      const taskIds = new Set(tasks.data.map((value) => value.id)), oldJobs = new Set(this.store.executions().map((value) => value.job));
      if (executions.data.some((value) => !value.applied || !taskIds.has(value.task) || oldJobs.has(value.job))) throw new WorkError("CONFLICT", "只允许导入已处理且属于本批任务的历史执行");
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
      if (parent.id === task.id) throw new WorkError("CONFLICT", "任务不能作为自己的父任务");
      if (parent.project && task.project && parent.project !== task.project) throw new WorkError("CONFLICT", "父任务必须属于同一项目");
      const seen = new Set([task.id]);
      let current: WorkTask | undefined = parent;
      while (current) {
        if (seen.has(current.id)) throw new WorkError("CONFLICT", "父任务关系不能形成循环");
        seen.add(current.id); current = current.parent ? this.task(current.parent) : undefined;
      }
    }
    if (new Set(task.dependencies).size !== task.dependencies.length) throw new WorkError("INVALID", "依赖任务不能重复");
    const visit = (id: string, seen: Set<string>): void => {
      if (id === task.id) throw new WorkError("CONFLICT", "任务依赖不能形成循环");
      if (seen.has(id)) return;
      seen.add(id);
      for (const next of this.task(id).dependencies) visit(next, seen);
    };
    for (const id of task.dependencies) visit(id, new Set());
    if (task.status === "done" && task.dependencies.some((id) => this.task(id).status !== "done")) {
      throw new WorkError("CONFLICT", "依赖任务尚未完成");
    }
  }

  command(input: unknown, actor: string): WorkCommandResult {
    const parsed = WorkCommandRequest.safeParse(input);
    if (!parsed.success) throw new WorkError("INVALID", "工作操作参数不合法");
    const request = parsed.data, serialized = JSON.stringify(request.operation);
    return this.store.transaction(() => {
      const previous = this.store.receipt(actor, request.request_id);
      if (previous) {
        if (previous.operation !== serialized) throw new WorkError("CONFLICT", "请求编号已用于不同的操作");
        return WorkCommandResult.parse(previous.result);
      }
      const operation = request.operation, time = this.context.now().toISOString();
      let result: WorkCommandResult;
      switch (operation.op) {
        case "work.project.create": {
          const project = WorkProject.parse({ schema_version: 2, type: "project", id: this.context.id("prj"),
            title: operation.args.title, description: operation.args.description ?? "", tags: operation.args.tags ?? [],
            goal: operation.args.goal, repo: operation.args.repo, deadline: operation.args.deadline,
            revision: 1, status: "planning", created: time, updated: time });
          this.store.putProject(project); result = { kind: "project", project }; break;
        }
        case "work.project.update": {
          const current = this.project(operation.args.project);
          if (current.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", "项目已被修改，请重新读取后再保存");
          const project = WorkProject.parse({ ...patch(current, operation.args.patch), revision: current.revision + 1, updated: time });
          this.store.putProject(project); result = { kind: "project", project }; break;
        }
        case "work.task.create": {
          const task = WorkTask.parse({ ...operation.args, schema_version: 2, type: "task", id: this.context.id("task"),
            description: operation.args.description ?? "", tags: operation.args.tags ?? [], assignee: operation.args.assignee ?? "human",
            status: operation.args.status ?? "todo", dependencies: operation.args.dependencies ?? [], references: operation.args.references ?? [],
            revision: 1, created: time, updated: time });
          this.checkTask(task); this.store.putTask(task); result = { kind: "task", task }; break;
        }
        case "work.task.update": {
          const current = this.task(operation.args.task);
          if (current.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", "任务已被修改，请重新读取后再保存");
          const task = WorkTask.parse({ ...patch(current, operation.args.patch), revision: current.revision + 1, updated: time });
          this.checkTask(task); this.store.putTask(task);
          if (["paused", "cancelled"].includes(task.status)) this.context.cancel?.(task.id);
          result = { kind: "task", task }; break;
        }
        case "work.task.comment": {
          this.task(operation.args.task);
          const comment = WorkComment.parse({ id: this.context.id("wmsg"), task: operation.args.task, author: actor, body: operation.args.body, created: time });
          this.store.putComment(comment); result = { kind: "comment", comment }; break;
        }
        case "work.task.dispatch": {
          const task = this.task(operation.args.task);
          if (operation.args.expected_revision !== undefined && task.revision !== operation.args.expected_revision) throw new WorkError("CONFLICT", "任务已被修改，请重新读取后再派出");
          if (["done", "cancelled", "paused"].includes(task.status)) throw new WorkError("CONFLICT", "任务已完成、已取消或已暂停");
          if (task.dependencies.some((id) => this.task(id).status !== "done")) throw new WorkError("CONFLICT", "依赖任务尚未完成");
          if ((operation.args.to ?? task.assignee) === "human") throw new WorkError("INVALID", "请指定 agent 负责人，例如 pi@server");
          const executions = this.store.executions(task.id);
          if (executions.some((execution) => !execution.applied)) throw new WorkError("CONFLICT", "这个任务已有一轮在执行或等待交回");
          if (!this.context.dispatch) throw new WorkError("INTERNAL", "执行能力尚未配置");
          const comments = this.store.comments(task.id);
          const snapshot = [`# ${task.title}`, "", task.description, ...comments.flatMap((comment) => ["", `## 讨论 ${comment.author} ${comment.created}`, comment.body])].join("\n");
          const round = executions.reduce((maximum, value) => Math.max(maximum, value.round), 0) + 1;
          const job = this.context.dispatch(task, snapshot, round, operation.args.to);
          this.store.putExecution(WorkExecution.parse({ task: task.id, job: job.spec.id, round, input_revision: task.revision,
            input_snapshot: snapshot, created: time, applied: false }));
          if (task.status === "todo") this.store.putTask(WorkTask.parse({ ...task, status: "active", revision: task.revision + 1, updated: time }));
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
      const body = [`第 ${execution.round} 轮：${job.status}`, job.result?.report ?? "", job.result?.question ? `问题：${job.result.question}` : "", job.result?.error ?? ""].filter(Boolean).join("\n\n");
      const shown = secret(body) ? `第 ${execution.round} 轮：${job.status}\n\n汇报疑似包含敏感信息，未写入任务讨论；请用 lumio job show ${job.spec.id} 查看。`
        : `${body.slice(0, 3000)}${body.length > 3000 ? "\n\n……（已截断）" : ""}`;
      this.store.putComment(WorkComment.parse({ id: this.context.id("wmsg"), task: execution.task, author: job.spec.runtime,
        body: shown, created: this.context.now().toISOString() }));
      this.store.putExecution({ ...execution, applied: true });
    });
  }
}

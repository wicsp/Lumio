import { expect, test } from "bun:test";
import { Job, WorkCommandResult, type WorkProject, type WorkTask, type WorkComment, type WorkExecution } from "@lumio/schema";
import { WorkService, type WorkStore } from "../src/index.ts";

const owner = "act_00000000000000000000000001";
const timestamp = "2026-10-31T00:00:00Z";
class MemoryStore implements WorkStore {
  data: { projects: WorkProject[]; tasks: WorkTask[]; comments: WorkComment[]; executions: WorkExecution[]; receipts: Record<string, { operation: string; result: WorkCommandResult }> } = {
    projects: [], tasks: [], comments: [], executions: [], receipts: {},
  };
  project(id: string) { return structuredClone(this.data.projects.find((value) => value.id === id)); }
  projects() { return structuredClone(this.data.projects); }
  putProject(value: WorkProject) { this.data.projects = [...this.data.projects.filter((item) => item.id !== value.id), structuredClone(value)]; }
  task(id: string) { return structuredClone(this.data.tasks.find((value) => value.id === id)); }
  tasks() { return structuredClone(this.data.tasks); }
  putTask(value: WorkTask) { this.data.tasks = [...this.data.tasks.filter((item) => item.id !== value.id), structuredClone(value)]; }
  comments(task: string) { return structuredClone(this.data.comments.filter((value) => value.task === task)); }
  putComment(value: WorkComment) { this.data.comments.push(structuredClone(value)); }
  executions(task?: string) { return structuredClone(this.data.executions.filter((value) => task === undefined || value.task === task)); }
  putExecution(value: WorkExecution) { this.data.executions = [...this.data.executions.filter((item) => item.job !== value.job), structuredClone(value)]; }
  receipt(actor: string, request: string) { return structuredClone(this.data.receipts[`${actor}:${request}`]); }
  putReceipt(actor: string, request: string, operation: string, result: WorkCommandResult) { this.data.receipts[`${actor}:${request}`] = { operation, result: structuredClone(result) }; }
  transaction<T>(action: () => T): T {
    const before = structuredClone(this.data);
    try { return action(); } catch (cause) { this.data = before; throw cause; }
  }
}
function fixture() {
  const store = new MemoryStore(); let sequence = 0, requests = 0, dispatches = 0, cancellations = 0;
  const id = (prefix: string) => `${prefix}_${String(++sequence).padStart(26, "0")}`;
  const service = new WorkService(store, { now: () => new Date(timestamp), id,
    dispatch(task, input, round) {
      dispatches++;
      return Job.parse({ spec: { id: id("job"), protocol_version: 2, source: { task: task.id, round }, runtime: owner,
        lease: "synthetic-lease-0000", run: { kind: "command", argv: ["/bin/echo", input] }, workdir: "~", timeout_seconds: 60, created: timestamp }, status: "queued" });
    }, cancel() { cancellations++; },
  });
  function command(op: string, args: Record<string, unknown>, request = `synthetic-request-${++requests}`, actor = owner) {
    return WorkCommandResult.parse(service.command({ request_id: request, operation: { op, args } }, actor));
  }
  function create(title: string, args: Record<string, unknown> = {}) {
    const result = command("work.task.create", { title, ...args });
    if (result.kind !== "task") throw new Error("fixture task expected");
    return result.task;
  }
  return { store, service, command, create, dispatches: () => dispatches, cancellations: () => cancellations };
}

test("Work operates without Knowledge, keeps owner separate from dispatch, snapshots input and applies each result once", () => {
  const f = fixture();
  const task = f.create("合成任务", { description: "第一版要求", assignee: "pi@server" });
  expect(f.dispatches()).toBe(0); expect(task.status).toBe("todo");
  const started = f.command("work.task.dispatch", { task: task.id }, "synthetic-dispatch-001");
  expect(started.kind).toBe("job");
  const details = f.service.detail(task.id);
  expect(details.task.status).toBe("active"); expect(details.task.assignee).toBe("pi@server");
  expect(details.executions[0]!.input_snapshot).toContain("第一版要求");
  f.command("work.task.update", { task: task.id, expected_revision: details.task.revision, patch: { description: "第二版要求" } });
  expect(f.service.detail(task.id).executions[0]!.input_snapshot).not.toContain("第二版要求");
  expect(f.command("work.task.dispatch", { task: task.id }, "synthetic-dispatch-001")).toEqual(started);
  expect(f.dispatches()).toBe(1);
  expect(() => f.command("work.task.dispatch", { task: task.id })).toThrow("已有一轮");
  const run = details.executions[0]!;
  const result = Job.parse({ spec: { id: run.job, protocol_version: 2, runtime: owner, lease: "synthetic-lease-0000",
    run: { kind: "command", argv: ["/bin/true"] }, workdir: "~", timeout_seconds: 60, created: timestamp }, status: "done",
    result: { job: run.job, lease: "synthetic-lease-0000", status: "done", finished: timestamp, report: "合成汇报" } });
  f.service.applyResult(result); f.service.applyResult(result);
  expect(f.service.detail(task.id).comments).toHaveLength(1);
  expect(f.service.task(task.id)).toMatchObject({ status: "active", assignee: "pi@server", description: "第二版要求" });
});

test("revision conflicts preserve descriptions; null clears optional fields and requests are actor-scoped", () => {
  const f = fixture(), task = f.create("合成任务", { due: timestamp });
  f.command("work.task.update", { task: task.id, expected_revision: 1, patch: { due: null } });
  expect(f.service.task(task.id).due).toBeUndefined();
  f.command("work.task.update", { task: task.id, expected_revision: 2, patch: { description: "保留的正文" } });
  expect(() => f.command("work.task.update", { task: task.id, expected_revision: 1, patch: { description: "陈旧修改" } })).toThrow("已被修改");
  expect(f.service.task(task.id).description).toBe("保留的正文");
  const first = f.command("work.task.create", { title: "相同输入" }, "synthetic-request-replay");
  expect(f.command("work.task.create", { title: "相同输入" }, "synthetic-request-replay")).toEqual(first);
  expect(() => f.command("work.task.create", { title: "不同输入" }, "synthetic-request-replay")).toThrow("不同的操作");
  expect(f.command("work.task.create", { title: "相同输入" }, "synthetic-request-replay", "act_00000000000000000000000002")).not.toEqual(first);
});

test("dependency and parent cycles are refused, incomplete dependencies block dispatch and completion", () => {
  const f = fixture(), a = f.create("依赖"), b = f.create("后续", { dependencies: [a.id], parent: a.id, assignee: "pi" });
  expect(() => f.command("work.task.dispatch", { task: b.id })).toThrow("依赖任务尚未完成");
  expect(() => f.command("work.task.update", { task: b.id, expected_revision: b.revision, patch: { status: "done" } })).toThrow("依赖任务尚未完成");
  expect(() => f.command("work.task.update", { task: a.id, expected_revision: a.revision, patch: { dependencies: [b.id] } })).toThrow("依赖不能形成循环");
  expect(() => f.command("work.task.update", { task: a.id, expected_revision: a.revision, patch: { parent: b.id } })).toThrow("父任务关系不能形成循环");
  f.command("work.task.update", { task: a.id, expected_revision: a.revision, patch: { status: "done" } });
  expect(f.command("work.task.dispatch", { task: b.id }).kind).toBe("job");
});

test("paused and cancelled tasks request cancellation; blocked statuses never dispatch and invalid input changes nothing", () => {
  const f = fixture(), task = f.create("合成任务");
  f.command("work.task.update", { task: task.id, expected_revision: 1, patch: { status: "paused" } });
  expect(f.cancellations()).toBe(1);
  expect(() => f.command("work.task.dispatch", { task: task.id })).toThrow("已暂停");
  const before = structuredClone(f.store.data);
  expect(() => f.command("work.task.update", { task: task.id, expected_revision: 2, patch: { id: task.id } })).toThrow("参数不合法");
  expect(f.store.data).toEqual(before);
});

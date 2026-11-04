import { expect, test } from "bun:test";
import { Job, WorkCommandResult, type WorkProject, type WorkTask, type WorkComment, type TaskTurnChange, type WorkExecution } from "@lumio/schema";
import { WorkService, type WorkStore } from "../src/index.ts";

const owner = "act_00000000000000000000000001";
const timestamp = "2026-10-31T00:00:00Z";
class MemoryStore implements WorkStore {
  data: { turns: TaskTurnChange[]; projects: WorkProject[]; tasks: WorkTask[]; comments: WorkComment[]; executions: WorkExecution[]; receipts: Record<string, { operation: string; result: WorkCommandResult }> } = {
    turns: [], projects: [], tasks: [], comments: [], executions: [], receipts: {},
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
  turns(task: string) { return structuredClone(this.data.turns.filter(value => value.task === task)); }
  putTurn(value: TaskTurnChange) { this.data.turns.push(structuredClone(value)); }
  receipt(actor: string, request: string) { return structuredClone(this.data.receipts[`${actor}:${request}`]); }
  putReceipt(actor: string, request: string, operation: string, result: WorkCommandResult) { this.data.receipts[`${actor}:${request}`] = { operation, result: structuredClone(result) }; }
  transaction<T>(action: () => T): T {
    const before = structuredClone(this.data);
    try { return action(); } catch (cause) { this.data = before; throw cause; }
  }
}
function fixture() {
  const store = new MemoryStore(); let sequence = 0, requests = 0, dispatches = 0, cancellations = 0, clock = Date.parse(timestamp);
  const jobs = new Map<string, Job>();
  const id = (prefix: string) => `${prefix}_${String(++sequence).padStart(26, "0")}`;
  const service = new WorkService(store, { now: () => new Date(++clock), id, systemActor: owner, job: id => jobs.get(id),
    agentForJob: () => "pi@server",
    dispatch(task, input, round) {
      dispatches++;
      const job = Job.parse({ spec: { id: id("job"), protocol_version: 2, source: { task: task.id, round }, runtime: "act_00000000000000000000000002",
        lease: "synthetic-lease-0000", run: { kind: "command", argv: ["/bin/echo", input] }, workdir: "~", timeout_seconds: 60, created: timestamp }, status: "queued" });
      jobs.set(job.spec.id, job); return job;
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
  function result(job: Job, status: "done" | "waiting_for_human" | "failed" | "unknown" | "cancelled", report = "Synthetic report") {
    const value = Job.parse({ ...job, status, ...(status === "cancelled" ? {} : { result: { job: job.spec.id, lease: job.spec.lease, status,
      finished: new Date(++clock).toISOString(), report, ...(status === "waiting_for_human" ? { question: "Synthetic question?" } : {}) } }) });
    jobs.set(job.spec.id, value); service.applyResult(value); return value;
  }
  return { store, service, command, create, result, dispatches: () => dispatches, cancellations: () => cancellations };
}

test("Work operates without Knowledge, keeps owner separate from dispatch, snapshots input and applies each result once", () => {
  const f = fixture();
  const task = f.create("合成任务", { description: "第一版要求" });
  expect(f.dispatches()).toBe(0); expect(task.turn.reason).toBe("todo");
  const started = f.command("work.task.dispatch", { to: "pi@server", task: task.id }, "synthetic-dispatch-001");
  expect(started.kind).toBe("job");
  const details = f.service.detail(task.id);
  expect(details.task.turn.reason).toBe("working"); expect(details.task.turn.holder).toBe("pi@server");
  expect(details.executions[0]!.input_snapshot).toContain("第一版要求");
  f.command("work.task.update", { task: task.id, expected_revision: details.task.revision, patch: { description: "第二版要求" } });
  expect(f.service.detail(task.id).executions[0]!.input_snapshot).not.toContain("第二版要求");
  expect(f.command("work.task.dispatch", { to: "pi@server", task: task.id }, "synthetic-dispatch-001")).toEqual(started);
  expect(f.dispatches()).toBe(1);
  expect(() => f.command("work.task.dispatch", { to: "pi@server", task: task.id })).toThrow("CONFLICT");
  const run = details.executions[0]!;
  const result = Job.parse({ spec: { id: run.job, protocol_version: 2, runtime: owner, lease: "synthetic-lease-0000",
    run: { kind: "command", argv: ["/bin/true"] }, workdir: "~", timeout_seconds: 60, created: timestamp }, status: "done",
    result: { job: run.job, lease: "synthetic-lease-0000", status: "done", finished: timestamp, report: "合成汇报" } });
  f.service.applyResult(result); f.service.applyResult(result);
  expect(f.service.detail(task.id).comments).toHaveLength(1);
  expect(f.service.task(task.id)).toMatchObject({ outcome: "open", turn: { holder: "human", reason: "review" }, description: "第二版要求" });
});

test("revision conflicts preserve descriptions; null clears optional fields and requests are actor-scoped", () => {
  const f = fixture(), task = f.create("合成任务", { due: timestamp });
  f.command("work.task.update", { task: task.id, expected_revision: 1, patch: { due: null } });
  expect(f.service.task(task.id).due).toBeUndefined();
  f.command("work.task.update", { task: task.id, expected_revision: 2, patch: { description: "保留的正文" } });
  expect(() => f.command("work.task.update", { task: task.id, expected_revision: 1, patch: { description: "陈旧修改" } })).toThrow("CONFLICT");
  expect(f.service.task(task.id).description).toBe("保留的正文");
  const first = f.command("work.task.create", { title: "相同输入" }, "synthetic-request-replay");
  expect(f.command("work.task.create", { title: "相同输入" }, "synthetic-request-replay")).toEqual(first);
  expect(() => f.command("work.task.create", { title: "不同输入" }, "synthetic-request-replay")).toThrow("CONFLICT");
  expect(f.command("work.task.create", { title: "相同输入" }, "synthetic-request-replay", "act_00000000000000000000000002")).not.toEqual(first);
});

test("dependency and parent cycles are refused, incomplete dependencies block dispatch and completion", () => {
  const f = fixture(), a = f.create("依赖"), b = f.create("后续", { dependencies: [a.id], parent: a.id });
  expect(() => f.command("work.task.dispatch", { to: "pi@server", task: b.id })).toThrow("CONFLICT");
  expect(() => f.command("work.task.finish", { task: b.id, expected_revision: b.revision, outcome: "done" })).toThrow("CONFLICT");
  expect(() => f.command("work.task.update", { task: a.id, expected_revision: a.revision, patch: { dependencies: [b.id] } })).toThrow("CONFLICT");
  expect(() => f.command("work.task.update", { task: a.id, expected_revision: a.revision, patch: { parent: b.id } })).toThrow("CONFLICT");
  f.command("work.task.finish", { task: a.id, expected_revision: a.revision, outcome: "done" });
  expect(f.command("work.task.dispatch", { to: "pi@server", task: b.id }).kind).toBe("job");
});

test("paused and cancelled tasks request cancellation; blocked statuses never dispatch and invalid input changes nothing", () => {
  const f = fixture(), task = f.create("合成任务");
  f.command("work.task.hand", { task: task.id, expected_revision: 1, to: "nobody" });
  expect(f.cancellations()).toBe(0);
  expect(() => f.command("work.task.dispatch", { to: "pi@server", task: task.id })).toThrow("CONFLICT");
  const before = structuredClone(f.store.data);
  expect(() => f.command("work.task.update", { task: task.id, expected_revision: 2, patch: { id: task.id } })).toThrow("INVALID");
  expect(f.store.data).toEqual(before);
});

for (const [status, reason] of [["done", "review"], ["waiting_for_human", "answer"], ["failed", "failed"], ["unknown", "failed"], ["cancelled", "todo"]] as const) {
  test(`round ${status} hands to human ${reason} exactly once with an append-only event`, () => {
    const f = fixture(), task = f.create("Synthetic task");
    const started = f.command("work.task.dispatch", { task: task.id, to: "pi@server" });
    if (started.kind !== "job") throw new Error("job expected");
    expect(f.service.task(task.id).turn).toMatchObject({ holder: "pi@server", reason: "working", round: 1, job: started.job.spec.id });
    expect(() => f.command("work.task.dispatch", { task: task.id, to: "pi@server" })).toThrow("CONFLICT");
    const result = f.result(started.job, status);
    f.service.applyResult(result);
    const detail = f.service.detail(task.id);
    expect(detail.task).toMatchObject({ outcome: "open", turn: { holder: "human", reason, round: 1, job: result.spec.id } });
    expect(detail.turns).toHaveLength(3);
    expect(detail.turns[1]!.to).toEqual(detail.turns[2]!.from);
    expect(detail.turns[2]!.by).toBe(owner);
  });
}

test("finish cancels the current round, late delivery cannot reclaim the turn, and reopen records the new outcome", () => {
  const f = fixture(), task = f.create("Synthetic task");
  const started = f.command("work.task.dispatch", { task: task.id, to: "pi@server" });
  if (started.kind !== "job") throw new Error("job expected");
  f.command("work.task.finish", { task: task.id, expected_revision: 2, outcome: "done" });
  expect(f.cancellations()).toBe(1);
  f.result(started.job, "done");
  expect(f.service.task(task.id)).toMatchObject({ outcome: "done", turn: { holder: "nobody", reason: "on_hold" } });
  f.command("work.task.reopen", { task: task.id, expected_revision: 3 });
  expect(f.service.task(task.id)).toMatchObject({ outcome: "open", turn: { holder: "human", reason: "todo" } });
  expect(f.service.detail(task.id).turns.map(change => change.outcome)).toEqual(["open", undefined, "done", "open"]);
});

test("Inline & Spill carries recent comments, bounded summaries and IDs instead of full historical discussion", () => {
  const f = fixture(), task = f.create("Synthetic context", { description: "Durable instructions", references: [{ module: "knowledge", id: "pap_00000000000000000000000001", label: "Synthetic paper" }] });
  f.command("work.task.comment", { task: task.id, body: "OLD DISCUSSION ".repeat(200) });
  const first = f.command("work.task.dispatch", { task: task.id, to: "pi@server" });
  if (first.kind !== "job") throw new Error("job expected");
  f.result(first.job, "done", "LONG REPORT ".repeat(200));
  const second = f.command("work.task.dispatch", { task: task.id, comment: "Recent answer" });
  if (second.kind !== "job") throw new Error("job expected");
  const input = f.service.detail(task.id).executions[1]!.input_snapshot;
  expect(input).toContain(task.id); expect(input).toContain("Durable instructions"); expect(input).toContain("Recent answer");
  expect(input).toContain("LONG REPORT"); expect(input).not.toContain("LONG REPORT ".repeat(100));
  expect(input).not.toContain("OLD DISCUSSION"); expect(input).toContain(first.job.spec.id);
  expect(input).toContain("pap_00000000000000000000000001: Synthetic paper"); expect(input).toContain("Lumio skill");
  f.result(second.job, "done", "Second report");
  f.command("work.task.dispatch", { task: task.id, to: "pi@server" });
  const third = f.service.detail(task.id).executions[2]!.input_snapshot;
  expect(third).toContain(first.job.spec.id); expect(third).toContain(second.job.spec.id);
  expect(third).not.toContain("Recent answer");
});

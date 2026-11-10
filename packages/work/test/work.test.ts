import { expect, test } from "bun:test";
import { Job, WorkCommandResult, type TrashItem, type HandoffPlan, type PlanTemplate, type WorkProject, type WorkTask, type WorkComment, type TaskTurnChange, type WorkExecution } from "@lumio/schema";
import { WorkService, type PendingStageGrant, type WorkCaller, type WorkStore } from "../src/index.ts";

const owner = "act_00000000000000000000000001";
const timestamp = "2026-10-31T00:00:00Z";
class MemoryStore implements WorkStore {
  data: { grants: Record<string, PendingStageGrant>; trash: TrashItem[]; templates: PlanTemplate[]; turns: TaskTurnChange[]; projects: WorkProject[]; tasks: WorkTask[]; comments: WorkComment[]; executions: WorkExecution[]; receipts: Record<string, { operation: string; result: WorkCommandResult }> } = {
    grants: {}, trash: [], templates: [], turns: [], projects: [], tasks: [], comments: [], executions: [], receipts: {},
  };
  project(id: string) { return structuredClone(this.data.projects.find((value) => value.id === id)); }
  projects() { return structuredClone(this.data.projects); }
  putProject(value: WorkProject) { this.data.projects = [...this.data.projects.filter((item) => item.id !== value.id), structuredClone(value)]; }
  task(id: string) { return structuredClone(this.data.tasks.find((value) => value.id === id)); }
  tasks() { return structuredClone(this.data.tasks); }
  putTask(value: WorkTask) { this.data.tasks = [...this.data.tasks.filter((item) => item.id !== value.id), structuredClone(value)]; }
  pendingGrant(id: string) { return structuredClone(this.data.grants[id]); }
  putPendingGrant(id: string, grant?: PendingStageGrant) {
    if (grant) this.data.grants[id] = structuredClone(grant);
    else delete this.data.grants[id];
  }
  comments(task: string) { return structuredClone(this.data.comments.filter((value) => value.task === task)); }
  putComment(value: WorkComment) { this.data.comments.push(structuredClone(value)); }
  executions(task?: string) { return structuredClone(this.data.executions.filter((value) => task === undefined || value.task === task)); }
  latestJobs() {
    return new Map([...this.data.executions].sort((a, b) => a.round - b.round).map(run => [run.task, run.job]));
  }
  putExecution(value: WorkExecution) { this.data.executions = [...this.data.executions.filter((item) => item.job !== value.job), structuredClone(value)]; }
  turns(task: string) { return structuredClone(this.data.turns.filter(value => value.task === task)); }
  putTurn(value: TaskTurnChange) { this.data.turns.push(structuredClone(value)); }
  planTemplates() { return structuredClone(this.data.templates); }
  putPlanTemplate(value: PlanTemplate) { this.data.templates = [...this.data.templates.filter(item => item.id !== value.id), structuredClone(value)]; }
  deletePlanTemplate(id: string) { this.data.templates = this.data.templates.filter(value => value.id !== id); }
  receipt(actor: string, request: string) { return structuredClone(this.data.receipts[`${actor}:${request}`]); }
  putReceipt(actor: string, request: string, operation: string, result: WorkCommandResult) { this.data.receipts[`${actor}:${request}`] = { operation, result: structuredClone(result) }; }
  trash(id: string) { return this.data.trash.find(item => item.id === id); }
  trashed() { return this.data.trash; }
  putTrash(item: TrashItem) { this.data.trash.push(item); }
  removeTrash(id: string) { this.data.trash = this.data.trash.filter(item => item.id !== id); }
  transaction<T>(action: () => T): T {
    const before = structuredClone(this.data);
    try { return action(); } catch (cause) { this.data = before; throw cause; }
  }
}
function fixture(systemActor = owner) {
  const store = new MemoryStore(); let sequence = 0, requests = 0, dispatches = 0, cancellations = 0, clock = Date.parse(timestamp);
  const jobs = new Map<string, Job>();
  const targets = new Map<string, string>();
  const id = (prefix: string) => `${prefix}_${String(++sequence).padStart(26, "0")}`;
  const service = new WorkService(store, { now: () => new Date(++clock), id, systemActor, job: id => jobs.get(id),
    text: (key, ...args) => key === "work.plan_max_rounds" ? `Reached ${args[0]} rounds; human review required` : key,
    agentsForJobs: ids => new Map(ids.map(job => [job, targets.get(job) ?? "pi@server"])),
    dispatch(task, input, round, to) {
      dispatches++;
      const job = Job.parse({ spec: { id: id("job"), protocol_version: 2, source: { task: task.id, round }, runtime: "act_00000000000000000000000002",
        lease: "synthetic-lease-0000", run: { kind: "command", argv: ["/bin/echo", input] }, workdir: "~", timeout_seconds: 60, created: timestamp }, status: "queued" });
      jobs.set(job.spec.id, job); targets.set(job.spec.id, to!); return job;
    }, cancel() { cancellations++; },
  });
  function command(op: string, args: Record<string, unknown>, request = `synthetic-request-${++requests}`, actor = owner, caller?: WorkCaller) {
    return WorkCommandResult.parse(service.command({ request_id: request, operation: { op, args } }, actor, undefined, caller));
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
  return { store, service, command, create, result, job: (id: string) => jobs.get(id)!, dispatches: () => dispatches, cancellations: () => cancellations };
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


for (const role of ["agent", "runtime"] as const) for (const to of ["human", "external"] as const) {
  test(`${role} hands its own executing round to ${to} without cancellation; the final report preserves the handoff`, () => {
    const f = fixture(), task = f.create("Synthetic self-handoff");
    const started = f.command("work.task.dispatch", { task: task.id, to: "pi@server" });
    if (started.kind !== "job") throw new Error("job expected");
    const actor = role === "runtime" ? started.job.spec.runtime : "act_00000000000000000000000003";
    const changed = f.command("work.task.hand", { task: task.id, expected_revision: 2, to, ...(to === "external" ? { note: "Waiting for synthetic CI" } : {}) },
      `synthetic-self-hand-${role}-${to}`, actor, { role, job: started.job.spec.id });
    if (changed.kind !== "task") throw new Error("task expected");
    expect(changed.task.turn).toMatchObject({ holder: to, reason: to === "human" ? "todo" : "waiting" });
    expect(f.cancellations()).toBe(0);
    expect(f.service.detail(task.id).turns.at(-1)).toMatchObject({ by: actor, from: { holder: "pi@server" }, to: changed.task.turn });
    const result = f.result(started.job, "done", "Synthetic final report after handoff");
    f.service.applyResult(result);
    const detail = f.service.detail(task.id);
    expect(detail.task).toEqual(changed.task); expect(detail.turns).toHaveLength(3);
    expect(detail.executions[0]!.applied).toBe(true);
    expect(detail.comments).toHaveLength(1); expect(detail.comments[0]!.body).toContain("Synthetic final report after handoff");
  });
}

for (const job of [undefined, "job_00000000000000000000000999"]) test(`another agent cannot hand over a pending round (${job ?? "manual token"})`, () => {
  const f = fixture(), task = f.create("Synthetic protected round");
  f.command("work.task.dispatch", { task: task.id, to: "pi@server" });
  const before = structuredClone(f.store.data);
  expect(() => f.command("work.task.hand", { task: task.id, expected_revision: 2, to: "human" }, "synthetic-foreign-hand", "act_00000000000000000000000003", { role: "agent", job }))
    .toThrow("CONFLICT");
  expect(f.store.data).toEqual(before); expect(f.cancellations()).toBe(0);
});

for (const to of ["human", "external", "nobody"] as const) test(`a human hand to ${to} still cancels the executing round`, () => {
  const f = fixture(), task = f.create("Synthetic human takeover");
  const started = f.command("work.task.dispatch", { task: task.id, to: "pi@server" });
  if (started.kind !== "job") throw new Error("job expected");
  const changed = f.command("work.task.hand", { task: task.id, expected_revision: 2, to, ...(to === "external" ? { note: "Synthetic wait" } : {}) });
  expect(f.cancellations()).toBe(1);
  if (changed.kind !== "task") throw new Error("task expected");
  f.result(started.job, "cancelled");
  expect(f.service.task(task.id)).toEqual(changed.task);
  expect(f.service.detail(task.id).turns.at(-1)!.by).toBe(owner);
});

const handoffPlan: HandoffPlan = { stages: [
  { kind: "agent", id: "implement", agent: "codex@mac", instruction: "Implement the synthetic change" },
  { kind: "agent", id: "review", agent: "claude-code@mac", instruction: "Review the synthetic change", back_to: "implement" },
  { kind: "checkpoint", id: "approve", prompt: "Merge this synthetic change?" },
  { kind: "agent", id: "merge", agent: "claude-code@mac", instruction: "Merge the synthetic change" },
] };
function planned(f: ReturnType<typeof fixture>, plan = handoffPlan, from?: string) {
  const task = f.create("Synthetic planned task");
  f.command("work.task.plan.set", { task: task.id, expected_revision: task.revision, plan, from });
  expect(f.dispatches()).toBe(0);
  return task.id;
}
function deliver(f: ReturnType<typeof fixture>, task: string, report = "Synthetic delivery", status: "done" | "waiting_for_human" | "failed" | "unknown" | "cancelled" = "done") {
  return f.result(f.job(f.service.task(task).turn.job!), status, report);
}

test("approved plan hands implement → review → implement → review → checkpoint → merge → end with five rounds", () => {
  const system = "act_00000000000000000000000999", f = fixture(system), task = planned(f);
  f.command("work.task.dispatch", { task });
  expect(f.service.task(task)).toMatchObject({ plan: { stage: "implement", rounds: 1 }, turn: { holder: "codex@mac", stage: "implement" } });
  const first = deliver(f, task);
  f.service.applyResult(first);
  expect(f.dispatches()).toBe(2);
  expect(f.service.task(task)).toMatchObject({ plan: { stage: "review", rounds: 2 }, turn: { holder: "claude-code@mac", stage: "review" } });
  deliver(f, task, "Fix the synthetic edge case.\n<lumio-outcome>changes</lumio-outcome>");
  expect(f.service.task(task)).toMatchObject({ plan: { stage: "implement", rounds: 3 } });
  deliver(f, task); deliver(f, task);
  expect(f.service.task(task)).toMatchObject({ plan: { stage: "approve", rounds: 4 }, turn: { holder: "human", reason: "review", stage: "approve", note: "Merge this synthetic change?" } });
  const continued = f.command("work.task.checkpoint", { task, stage: "approve", action: "continue" }, "synthetic-checkpoint-continue");
  expect(f.command("work.task.checkpoint", { task, stage: "approve", action: "continue" }, "synthetic-checkpoint-continue")).toEqual(continued);
  expect(f.service.task(task)).toMatchObject({ plan: { stage: "merge", rounds: 5 }, turn: { holder: "claude-code@mac", stage: "merge" } });
  deliver(f, task);
  const detail = f.service.detail(task);
  expect(detail.task).toMatchObject({ outcome: "open", plan: { stage: "end", rounds: 5 }, turn: { holder: "human", reason: "review", stage: "end" } });
  expect(detail.executions.map(run => run.round)).toEqual([1, 2, 3, 4, 5]);
  expect(detail.executions.map(run => run.input_snapshot.match(/## Plan stage: (\w+)/)?.[1])).toEqual(["implement", "review", "implement", "review", "merge"]);
  expect(detail.executions[2]!.input_snapshot).toContain("Fix the synthetic edge case");
  expect(detail.turns.filter(turn => turn.by === system)).toHaveLength(5);
  expect(detail.turns.every((turn, i) => i === 0 || JSON.stringify(turn.from) === JSON.stringify(detail.turns[i - 1]!.to))).toBe(true);
  expect(detail.turns[2]!.to.note).toContain("Plan ");
  expect(() => f.command("work.task.checkpoint", { task, stage: "end", action: "continue" })).toThrow("INVALID");
  expect(() => f.command("work.task.checkpoint", { task, stage: "approve", action: "finish" })).toThrow("CONFLICT");
  f.command("work.task.checkpoint", { task, stage: "end", action: "finish" });
  expect(f.service.task(task).outcome).toBe("done");
});

test("round input explains send-back immediately after the instruction only when the stage declares back_to", () => {
  const f = fixture(), task = planned(f);
  f.command("work.task.dispatch", { task });
  const guidance = "If changes are needed, explain what must change and put <lumio-outcome>changes</lumio-outcome> on a separate line at the end of your report to send work back.";
  expect(f.service.detail(task).executions[0]!.input_snapshot).not.toContain(guidance);
  deliver(f, task);
  expect(f.service.detail(task).executions[1]!.input_snapshot).toContain(`Review the synthetic change\n${guidance}\n`);
});

test("quoting the changes marker in a report does not send work back", () => {
  for (const report of [
    "The instructions mention <lumio-outcome>changes</lumio-outcome>; no changes are needed.",
    "The marker is:\n`<lumio-outcome>changes</lumio-outcome>`\nNo changes are needed.",
    "Quoted instruction:\n> <lumio-outcome>changes</lumio-outcome>\nNo changes are needed.",
  ]) {
    const f = fixture(), task = planned(f, handoffPlan, "review");
    f.command("work.task.dispatch", { task }); deliver(f, task, report);
    expect(f.service.task(task)).toMatchObject({ plan: { stage: "approve", rounds: 1 }, turn: { holder: "human", reason: "review" } });
    expect(f.dispatches()).toBe(1);
  }
});

test("a standalone changes marker sends work back with LF or CRLF and surrounding whitespace", () => {
  for (const report of [
    "Fix the synthetic edge case.\n<lumio-outcome>changes</lumio-outcome>",
    "Fix the synthetic edge case.\r\n \t<lumio-outcome>changes</lumio-outcome> \t\r\n",
  ]) {
    const f = fixture(), task = planned(f, handoffPlan, "review");
    f.command("work.task.dispatch", { task }); deliver(f, task, report);
    expect(f.service.task(task)).toMatchObject({ plan: { stage: "implement", rounds: 2 }, turn: { holder: "codex@mac", reason: "working" } });
    expect(f.service.detail(task).executions[1]!.input_snapshot).toContain("Fix the synthetic edge case.");
  }
});

test("send-back carries the human comment to an approved agent; stale, unknown and blank decisions are rejected", () => {
  const f = fixture(), task = planned(f, handoffPlan, "review");
  f.command("work.task.dispatch", { task }); deliver(f, task);
  const before = structuredClone(f.store.data);
  for (const args of [
    { stage: "review", action: "continue" },
    { stage: "approve", action: "send_back", back_to: "approve", comment: "Synthetic feedback" },
    { stage: "approve", action: "send_back", back_to: "missing", comment: "Synthetic feedback" },
    { stage: "approve", action: "send_back", back_to: "implement" },
    { stage: "approve", action: "send_back", back_to: "implement", comment: "   " },
  ]) expect(() => f.command("work.task.checkpoint", { task, ...args })).toThrow();
  expect(f.store.data).toEqual(before);
  f.command("work.task.checkpoint", { task, stage: "approve", action: "send_back", back_to: "implement", comment: "Please fix the synthetic edge case" });
  expect(f.service.task(task)).toMatchObject({ plan: { stage: "implement", rounds: 2 }, turn: { holder: "codex@mac" } });
  expect(f.service.detail(task).executions.at(-1)!.input_snapshot).toContain("Please fix the synthetic edge case");
  expect(() => f.command("work.task.checkpoint", { task, stage: "approve", action: "hold" })).toThrow("CONFLICT");
});

for (const [status, reason] of [["waiting_for_human", "answer"], ["failed", "failed"], ["unknown", "failed"], ["cancelled", "todo"]] as const) {
  test(`planned ${status} returns to the human at the same stage without automatic delegation`, () => {
    const f = fixture(), task = planned(f);
    f.command("work.task.dispatch", { task }); deliver(f, task, "<lumio-outcome>changes</lumio-outcome>", status);
    expect(f.service.task(task)).toMatchObject({ plan: { stage: "implement", rounds: 1 }, turn: { holder: "human", reason, stage: "implement" } });
    expect(f.dispatches()).toBe(1);
    f.command("work.task.dispatch", { task, comment: "Synthetic answer or retry" });
    expect(f.service.task(task)).toMatchObject({ plan: { stage: "implement", rounds: 2 }, turn: { holder: "codex@mac" } });
  });
}

for (const max_rounds of [2, undefined]) test(`plan round limit ${max_rounds ?? "default 8"} also applies to retries and checkpoint continue`, () => {
  const f = fixture(), plan: HandoffPlan = { max_rounds, stages: [{ kind: "agent", id: "loop", agent: "codex@mac", instruction: "Synthetic review", back_to: "loop" }] };
  const task = planned(f, plan); f.command("work.task.dispatch", { task });
  for (let i = 0; i < (max_rounds ?? 8); i++) deliver(f, task, "<lumio-outcome>changes</lumio-outcome>");
  expect(f.service.task(task)).toMatchObject({ plan: { rounds: max_rounds ?? 8 }, turn: { holder: "human", reason: "review", stage: "loop" } });
  expect(f.service.task(task).turn.note).toContain(String(max_rounds ?? 8));
  f.command("work.task.checkpoint", { task, stage: "loop", action: "continue" });
  f.command("work.task.dispatch", { task });
  expect(f.dispatches()).toBe(max_rounds ?? 8);
});

for (const action of ["hold", "finish", "clear"] as const) test(`${action} prevents a late delivery from automatically delegating`, () => {
  const f = fixture(), task = planned(f); f.command("work.task.dispatch", { task });
  const job = f.job(f.service.task(task).turn.job!);
  const current = f.service.task(task);
  if (action === "finish") f.command("work.task.finish", { task, expected_revision: current.revision, outcome: "done" });
  else {
    f.command("work.task.hand", { task, expected_revision: current.revision, to: action === "hold" ? "nobody" : "human" });
    if (action === "clear") f.command("work.task.plan.set", { task, expected_revision: f.service.task(task).revision, plan: null });
  }
  const stopped = f.service.task(task); f.result(job, "done");
  expect(f.service.task(task)).toEqual(stopped); expect(f.dispatches()).toBe(1);
});

test("checkpoint hold gives nobody the turn; starting a plan on a checkpoint can continue without implicit delegation", () => {
  const f = fixture(), task = planned(f, handoffPlan, "approve");
  f.command("work.task.checkpoint", { task, stage: "approve", action: "hold" });
  expect(f.service.task(task).turn.holder).toBe("nobody");
  expect(() => f.command("work.task.checkpoint", { task, stage: "approve", action: "continue" })).toThrow("CONFLICT");
  f.command("work.task.hand", { task, expected_revision: f.service.task(task).revision, to: "human" });
  f.command("work.task.checkpoint", { task, stage: "approve", action: "continue" });
  expect(f.service.task(task)).toMatchObject({ plan: { stage: "merge", rounds: 1 }, turn: { holder: "claude-code@mac" } });
});

test("delegation cannot substitute another stage's agent or an unapproved agent; a changes marker without back_to advances normally", () => {
  const f = fixture(), task = planned(f);
  for (const to of ["pi@server", "claude-code@mac"]) expect(() => f.command("work.task.dispatch", { task, to })).toThrow("CONFLICT");
  f.command("work.task.dispatch", { task }); deliver(f, task, "<lumio-outcome>changes</lumio-outcome>");
  expect(f.service.task(task).plan?.stage).toBe("review");
});

test("only humans handle checkpoints and templates; templates can be saved, overwritten, listed and deleted idempotently", () => {
  const f = fixture(), task = planned(f, handoffPlan, "approve");
  for (const role of ["agent", "runtime"] as const) for (const [op, args] of [
    ["work.task.checkpoint", { task, stage: "approve", action: "finish" }],
    ["work.plan_template.save", { name: "Synthetic template", plan: handoffPlan }],
    ["work.plan_template.delete", { template: "wft_00000000000000000000000001" }],
  ] as const) expect(() => f.command(op, args, `synthetic-${role}-${op}`, owner, { role })).toThrow("INVALID");
  const saved = f.command("work.plan_template.save", { name: "Synthetic template", plan: handoffPlan }, "synthetic-template-save");
  if (saved.kind !== "template") throw new Error("template expected");
  expect(f.command("work.plan_template.save", { name: "Synthetic template", plan: handoffPlan }, "synthetic-template-save")).toEqual(saved);
  const id = saved.template.id;
  f.command("work.plan_template.save", { template: id, name: "Renamed", plan: handoffPlan });
  expect(f.service.planTemplates()).toMatchObject([{ id, name: "Renamed", created: saved.template.created }]);
  f.command("work.plan_template.delete", { template: id }, "synthetic-template-delete");
  f.command("work.plan_template.delete", { template: id }, "synthetic-template-delete");
  expect(f.service.planTemplates()).toEqual([]);
  expect(() => f.command("work.plan_template.delete", { template: id })).toThrow("NOT_FOUND");
});

test("delegation proposals freeze the current plan stage agent even before any round exists", () => {
  const f = fixture(), task = planned(f);
  expect(f.service.proposalRequest({ request_id: "synthetic-proposed-plan-dispatch", operation: { op: "work.task.dispatch", args: { task } } }))
    .toMatchObject({ request: { operation: { args: { task, to: "codex@mac", expected_revision: 2 } } }, source: "plan" });
  expect(() => f.service.proposalRequest({ request_id: "synthetic-proposed-outside-agent", operation: { op: "work.task.dispatch", args: { task, to: "pi@server" } } })).toThrow("CONFLICT");
});

test("long checkpoint comments are retained even when holding or blocked by the round limit", () => {
  const f = fixture(), task = planned(f, handoffPlan, "approve"), comment = "Synthetic feedback. ".repeat(40);
  f.command("work.task.checkpoint", { task, stage: "approve", action: "hold", comment });
  expect(f.service.detail(task).comments.at(-1)?.body).toBe(comment);
  expect(f.service.task(task).turn.note).toHaveLength(200);
  const limited = planned(f, { ...handoffPlan, max_rounds: 1 });
  f.command("work.task.dispatch", { task: limited }); deliver(f, limited);
  f.command("work.task.checkpoint", { task: limited, stage: "review", action: "send_back", back_to: "implement", comment });
  expect(f.service.detail(limited).comments.at(-1)?.body).toBe(comment);
  expect(f.service.task(limited)).toMatchObject({ plan: { rounds: 1 }, turn: { holder: "human", reason: "review" } });
});

test("plan rounds start at zero independently of the task's historical round numbers", () => {
  const f = fixture(), task = f.create("Synthetic task with history");
  f.command("work.task.dispatch", { task: task.id, to: "pi@server" }); deliver(f, task.id);
  f.command("work.task.plan.set", { task: task.id, expected_revision: f.service.task(task.id).revision, plan: { ...handoffPlan, max_rounds: 2 } });
  expect(f.service.task(task.id).plan?.rounds).toBe(0);
  f.command("work.task.dispatch", { task: task.id }); deliver(f, task.id);
  expect(f.service.task(task.id)).toMatchObject({ plan: { stage: "review", rounds: 2 }, turn: { round: 3, holder: "claude-code@mac" } });
  deliver(f, task.id);
  expect(f.service.task(task.id)).toMatchObject({ plan: { stage: "approve", rounds: 2 }, turn: { holder: "human", reason: "review" } });
});

test("readiness is derived in all read and command results; filtering is batched and composable", async () => {
  const seed = await Bun.file(new URL("../../../fixtures/work/readiness.json", import.meta.url)).json();
  const f = fixture(), a = f.create(seed.title), b = f.create("Second prerequisite"), parent = f.create("Parent");
  const project = f.command("work.project.create", { title: "Synthetic project" });
  if (project.kind !== "project") throw new Error("project expected");
  const args = { title: "Synthetic blocked child", dependencies: [b.id, a.id], parent: parent.id, tags: seed.tags, project: project.project.id };
  const created = f.command("work.task.create", args, "synthetic-readiness-create");
  if (created.kind !== "task") throw new Error("task expected");
  const child = created.task;
  expect(child.blocked_by).toEqual([b.id, a.id]);
  expect(f.service.task(child.id).blocked_by).toEqual([b.id, a.id]);
  expect(f.service.detail(child.id).task.blocked_by).toEqual([b.id, a.id]);
  expect(f.service.detail(parent.id).children).toEqual([child.id]);
  expect(f.service.detail(a.id).dependents).toEqual([child.id]);
  const original = f.store.task.bind(f.store); let singleReads = 0, batchReads = 0;
  const batch = f.store.tasks.bind(f.store);
  f.store.task = id => { singleReads++; return original(id); };
  f.store.tasks = () => { batchReads++; return batch(); };
  expect(f.service.tasks({ readiness: "blocked", tag: "infra", parent: parent.id, project: project.project.id, query: "BLOCKED" }).map(task => task.id)).toEqual([child.id]);
  expect(singleReads).toBe(0); expect(batchReads).toBe(1);
  for (const filter of [{ tag: "inf" }, { parent: a.id }, { query: "absent" }]) expect(f.service.tasks(filter)).toEqual([]);
  expect(f.service.tasks({ readiness: "ready" }).map(task => task.id)).not.toContain(child.id);
  for (const op of ["work.task.dispatch", "work.task.finish"]) {
    try {
      f.command(op, { task: child.id, ...(op.endsWith("dispatch") ? { to: "pi@server" } : { expected_revision: child.revision, outcome: "done" }) });
      throw new Error("expected conflict");
    } catch (error) {
      const failure = error as { code: string; params: { key: string; args: string[] } };
      expect(failure.code).toBe("CONFLICT"); expect(failure.params.key).toBe("work.blocked_dependencies");
      expect(failure.params.args[0]).toContain(`${b.id}: ${b.title}`);
      expect(failure.params.args[0]).toContain(`${a.id}: ${a.title}`);
    }
  }
  for (const task of [a, b]) f.command("work.task.finish", { task: task.id, expected_revision: task.revision, outcome: "done" });
  expect(f.service.tasks({ readiness: "ready", parent: parent.id }).map(task => task.id)).toEqual([child.id]);
  expect(f.service.tasks({ readiness: "blocked" })).toEqual([]);
  expect(f.command("work.task.create", args, "synthetic-readiness-create")).toMatchObject({ task: { blocked_by: [] } });
  expect(f.service.tasks({ readiness: "ready" }).map(task => task.id)).not.toContain(a.id);
  f.command("work.task.finish", { task: child.id, expected_revision: child.revision, outcome: "done" });
  f.command("work.task.reopen", { task: a.id, expected_revision: 2 });
  expect(f.service.tasks({ readiness: "blocked" })).toEqual([]); // closed children are not blocked tasks
});

for (const change of ["cancelled", "trashed", "purged"] as const) test(`${change} prerequisites allow dispatch and completion; restoring open prerequisites blocks again`, async () => {
  const seed = await Bun.file(new URL("../../../fixtures/work/readiness.json", import.meta.url)).json();
  const f = fixture(), a = f.create(seed.title), b = f.create("Synthetic dependent", { dependencies: [a.id], parent: a.id });
  if (change === "cancelled") f.command("work.task.finish", { task: a.id, expected_revision: 1, outcome: "cancelled" });
  else {
    const deleted = f.command("work.task.delete", { task: a.id, expected_revision: 1 });
    if (deleted.kind !== "trashed") throw new Error("trash expected");
    expect(f.service.task(b.id).blocked_by).toEqual([]);
    f.service.restore(deleted.item, owner);
    expect(f.service.task(b.id).blocked_by).toEqual([a.id]);
    f.command("work.task.delete", { task: a.id, expected_revision: 2 });
    if (change === "purged") { f.store.data.tasks = f.store.data.tasks.filter(task => task.id !== a.id); f.store.removeTrash(a.id); }
  }
  expect(f.service.detail(b.id).task).toMatchObject({ blocked_by: [], dependencies: [a.id], parent: a.id });
  f.command("work.task.dispatch", { task: b.id, to: "pi@server" });
  f.command("work.task.finish", { task: b.id, expected_revision: 2, outcome: "done" });
  expect(f.service.task(b.id).outcome).toBe("done");
});

test("reverse relationships exclude trash and parent alone never implies a dependency", () => {
  const f = fixture(), a = f.create("Synthetic parent"), child = f.create("Synthetic child", { parent: a.id }), dependent = f.create("Synthetic dependent", { dependencies: [a.id] });
  expect(child.blocked_by).toEqual([]);
  f.command("work.task.delete", { task: child.id, expected_revision: 1 });
  f.command("work.task.delete", { task: dependent.id, expected_revision: 1 });
  expect(f.service.detail(a.id)).toMatchObject({ children: [], dependents: [] });
});

const parallelPlan: HandoffPlan = { stages: [
  { kind: "agent", id: "implement", agent: "codex@mac", instruction: "Implement" },
  { kind: "agent", id: "first-review", agent: "claude-code@mac", instruction: "First review", access: "read", back_to: "implement" },
  { kind: "agent", id: "second-review", agent: "claude-code@mac", instruction: "Second review", access: "read", after: ["implement"] },
  { kind: "checkpoint", id: "approve", prompt: "Approve?", after: ["first-review", "second-review"] },
  { kind: "agent", id: "merge", agent: "codex@mac", instruction: "Merge" },
] };
function fanOut(f: ReturnType<typeof fixture>, task: string) {
  f.command("work.task.dispatch", { task });
  deliver(f, task);
  const { turn, plan } = f.service.task(task);
  expect(turn.holder).toBe("agents");
  expect(turn.parallel?.map(branch => branch.stage)).toEqual(["first-review", "second-review"]);
  expect(plan).toMatchObject({ stage: "first-review", active: ["first-review", "second-review"], done: ["implement"], rounds: 3 });
  return turn.parallel!.map(branch => f.job(branch.job));
}

test("a parallel send-back waits for all reports, resets descendants and runs both reviews again", () => {
  const f = fixture(), task = planned(f, parallelPlan);
  const [first, second] = fanOut(f, task);
  const changes = f.result(first!, "done", "Correct synthetic finding A\n<lumio-outcome>changes</lumio-outcome>");
  expect(f.service.task(task)).toMatchObject({ plan: { stage: "second-review", rounds: 3 }, turn: { holder: "claude-code@mac", stage: "second-review", job: second!.spec.id } });
  expect(f.service.task(task).plan?.active).toBeUndefined();
  f.service.applyResult(changes);
  f.result(second!, "done", "Synthetic finding B");
  const rerun = f.service.detail(task);
  expect(rerun.task).toMatchObject({ plan: { stage: "implement", done: [], rounds: 4 }, turn: { holder: "codex@mac" } });
  expect(rerun.executions.at(-1)?.input_snapshot).toContain("Correct synthetic finding A");
  expect(rerun.executions.at(-1)?.input_snapshot).toContain("Synthetic finding B");
  deliver(f, task);
  const next = f.service.task(task);
  expect(next.plan?.active).toEqual(["first-review", "second-review"]);
  f.result(f.job(next.turn.parallel![1]!.job), "done");
  expect(f.service.task(task).turn.stage).toBe("first-review");
  f.result(f.job(next.turn.parallel![0]!.job), "done");
  expect(f.service.task(task)).toMatchObject({ plan: { stage: "approve", rounds: 6 }, turn: { holder: "human", reason: "review" } });
});

test("parallel questions and failures are surfaced after peers drain and each retry is isolated", () => {
  const f = fixture(), task = planned(f, parallelPlan), [first, second] = fanOut(f, task);
  f.result(first!, "waiting_for_human");
  expect(f.service.task(task).turn).toMatchObject({ reason: "working", stage: "second-review" });
  f.result(second!, "failed");
  expect(f.service.task(task).turn).toMatchObject({ reason: "answer", stage: "first-review", job: first!.spec.id });
  f.command("work.task.dispatch", { task, comment: "Synthetic answer" });
  expect(f.service.task(task).turn).toMatchObject({ reason: "working", stage: "first-review", round: 4 });
  expect(f.service.detail(task).executions.at(-1)?.input_snapshot).toContain("Synthetic answer");
  deliver(f, task);
  expect(f.service.task(task).turn).toMatchObject({ reason: "failed", stage: "second-review", job: second!.spec.id });
  f.command("work.task.checkpoint", { task, stage: "second-review", action: "continue" });
  deliver(f, task);
  expect(f.service.task(task).turn).toMatchObject({ reason: "review", stage: "approve" });
});

test("a ready dependent can start while an unrelated branch continues", () => {
  const f = fixture(), task = planned(f, { stages: [
    { kind: "agent", id: "slow", agent: "codex@mac", instruction: "Slow", access: "read" },
    { kind: "agent", id: "fast", agent: "codex@mac", instruction: "Fast", access: "read", after: [] },
    { kind: "agent", id: "dependent", agent: "claude-code@mac", instruction: "Depends on fast" },
  ] });
  f.command("work.task.dispatch", { task });
  const [slow, fast] = f.service.task(task).turn.parallel!;
  f.result(f.job(fast!.job), "done");
  const overlap = f.service.task(task).turn.parallel!;
  expect(overlap.map(branch => branch.stage)).toEqual(["slow", "dependent"]);
  f.result(f.job(overlap[1]!.job), "done");
  expect(f.service.task(task).turn.stage).toBe("slow");
  f.result(f.job(slow!.job), "done");
  expect(f.service.task(task).turn.stage).toBe("end");
});

test("parallel rounds share the cap and write concurrency is rejected by the approved contract", () => {
  const f = fixture(), task = planned(f, { ...parallelPlan, max_rounds: 2 });
  f.command("work.task.dispatch", { task });
  deliver(f, task);
  expect(f.service.task(task).turn).toMatchObject({ reason: "working", stage: "first-review" });
  deliver(f, task);
  expect(f.service.task(task)).toMatchObject({ turn: { reason: "review", stage: "second-review" }, plan: { rounds: 2 } });
  const revision = f.service.task(task).revision;
  const invalid = { ...parallelPlan, stages: parallelPlan.stages.map(stage => stage.kind === "agent" ? { ...stage, access: "write" } : stage) };
  expect(() => f.command("work.task.plan.set", { task, expected_revision: revision, plan: invalid })).toThrow("INVALID");
});

test("auto finish requires human checkpoint clearance and successful remaining stages", () => {
  const system = "act_00000000000000000000000999";
  const f = fixture(system), task = planned(f, { ...parallelPlan, finish: "auto" });
  const [first, second] = fanOut(f, task);
  f.result(first!, "done"); f.result(second!, "done");
  expect(f.service.task(task)).toMatchObject({ outcome: "open", turn: { reason: "review", stage: "approve" } });
  f.command("work.task.checkpoint", { task, stage: "approve", action: "continue" });
  deliver(f, task, "Synthetic failure", "failed");
  expect(f.service.task(task)).toMatchObject({ outcome: "open", turn: { reason: "failed", stage: "merge" } });
  f.command("work.task.dispatch", { task }); deliver(f, task);
  expect(f.service.task(task)).toMatchObject({ outcome: "done", plan: { stage: "end", done: parallelPlan.stages.map(stage => stage.id) }, turn: { holder: "nobody" } });
  expect(f.service.detail(task).turns.at(-1)).toMatchObject({ by: system, outcome: "done" });
  const next = f.create("Synthetic task");
  expect(() => f.command("work.task.plan.set", { task: next.id, expected_revision: next.revision, plan: { ...parallelPlan, finish: "auto" }, from: "merge" })).toThrow("INVALID");
  expect(() => f.command("work.task.plan.set", { task: next.id, expected_revision: next.revision, plan: { finish: "auto", stages: [parallelPlan.stages[0]] } })).toThrow("INVALID");
});

test("a project default validates the template and can be cleared explicitly or on deletion", () => {
  const f = fixture(), saved = f.command("work.plan_template.save", { name: "Synthetic template", plan: parallelPlan });
  if (saved.kind !== "template") throw new Error("template expected");
  const id = saved.template.id;
  const created = f.command("work.project.create", { title: "Synthetic project", default_plan: id });
  if (created.kind !== "project") throw new Error("project expected");
  const project = created.project.id;
  expect(f.service.project(project).default_plan).toBe(id);
  f.command("work.project.update", { project, expected_revision: 1, patch: { default_plan: null } });
  expect(f.service.project(project).default_plan).toBeUndefined();
  f.command("work.project.update", { project, expected_revision: 2, patch: { default_plan: id } });
  f.command("work.plan_template.delete", { template: id });
  expect(f.service.project(project)).toMatchObject({ revision: 4 });
  expect(f.service.project(project).default_plan).toBeUndefined();
  expect(() => f.command("work.project.create", { title: "Invalid default", default_plan: id })).toThrow("NOT_FOUND");
});

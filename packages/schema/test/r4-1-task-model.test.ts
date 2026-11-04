import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  CONTRACTS, HandoffPlan, NotificationEvent, Operation, PlanRun, Proposal, ProposalOperation, PushDevice, PushSubscriptionInput,
  RESPONSE_REASONS, TaskTurnChange, Turn, WorkAttention, WorkCommandRequest, WorkCommandResult, WorkTaskDetail, WorkTask, capability,
} from "../src/index.ts";

const TASK = "task_01JABCDEFGHJKMNPQRSTVWXYZ0", ACT = "act_01JABCDEFGHJKMNPQRSTVWXYZ0", JOB = "job_01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = "2026-11-04T21:00:00+08:00";
const turn = (holder: string, reason: string, extra: object = {}) => ({ holder, reason, since: NOW, ...extra });
const task = (extra: object = {}) => ({ schema_version: 3, type: "task", id: TASK, title: "Renew domain", description: "", revision: 1,
  outcome: "open", turn: turn("human", "todo"), created: NOW, updated: NOW, tags: [], dependencies: [], references: [], ...extra });

/** 作者的开发方式（ADR 0032 第 5 节）。 */
const develop = { stages: [
  { kind: "agent", id: "implement", agent: "codex@mac", instruction: "Implement the task and open a PR." },
  { kind: "agent", id: "review", agent: "claude-code@mac", instruction: "Review the PR.", back_to: "implement" },
  { kind: "checkpoint", id: "merge", prompt: "Merge the PR?" },
  { kind: "agent", id: "do-merge", agent: "claude-code@mac", instruction: "Merge the PR." },
] };

describe("three questions: outcome, turn, history (ADR 0032 §1–2)", () => {
  test("holders and reasons must match", () => {
    for (const [holder, reason] of [["human", "todo"], ["human", "answer"], ["human", "review"], ["human", "failed"], ["codex@mac", "working"], ["external", "waiting"], ["nobody", "on_hold"]]) {
      expect(Turn.safeParse(turn(holder!, reason!)).success).toBe(true);
    }
    for (const [holder, reason] of [["human", "working"], ["codex@mac", "review"], ["external", "todo"], ["nobody", "waiting"], ["someone", "todo"]]) {
      expect(Turn.safeParse(turn(holder!, reason!)).success).toBe(false);
    }
    expect([...RESPONSE_REASONS].sort()).toEqual(["answer", "failed", "review"]);
  });
  test("v3 tasks have no status or assignee; finished tasks are held by nobody", () => {
    expect(WorkTask.safeParse(task()).success).toBe(true);
    expect(WorkTask.safeParse(task({ status: "todo" })).success).toBe(false);
    expect(WorkTask.safeParse(task({ assignee: "human" })).success).toBe(false);
    expect(WorkTask.safeParse(task({ outcome: "done", turn: turn("nobody", "on_hold") })).success).toBe(true);
    expect(WorkTask.safeParse(task({ outcome: "done" })).success).toBe(false);
    expect(WorkTask.safeParse(task({ turn: turn("codex@mac", "working", { round: 2, job: JOB }) })).success).toBe(true);
  });
  test("history records each hand-over, append-only", () => {
    const change = { task: TASK, at: NOW, by: ACT, from: turn("codex@mac", "working", { round: 1 }), to: turn("human", "review", { round: 1, job: JOB }) };
    expect(TaskTurnChange.safeParse(change).success).toBe(true);
    expect(WorkTaskDetail.safeParse({ task: task(), comments: [], executions: [], turns: [change] }).success).toBe(true);
  });
});

describe("moving the turn (ADR 0032 §3)", () => {
  const command = (op: string, args: object) => WorkCommandRequest.safeParse({ request_id: "req_turn_command_01", operation: { op, args } }).success;
  test("hand back to you, to someone outside (with a note), or put on hold", () => {
    expect(command("work.task.hand", { task: TASK, expected_revision: 2, to: "human" })).toBe(true);
    expect(command("work.task.hand", { task: TASK, expected_revision: 2, to: "external", note: "Waiting for my advisor" })).toBe(true);
    expect(command("work.task.hand", { task: TASK, expected_revision: 2, to: "external" })).toBe(false);
    expect(command("work.task.hand", { task: TASK, expected_revision: 2, to: "codex@mac" })).toBe(false);
  });
  test("finish and reopen change the outcome", () => {
    expect(command("work.task.finish", { task: TASK, expected_revision: 2, outcome: "done" })).toBe(true);
    expect(command("work.task.finish", { task: TASK, expected_revision: 2, outcome: "open" })).toBe(false);
    expect(command("work.task.reopen", { task: TASK, expected_revision: 3 })).toBe(true);
  });
  test("none of the human-only commands is an agent capability", () => {
    for (const name of ["work.task.finish", "work.task.reopen", "work.task.plan.set", "work.task.checkpoint", "work.task.dispatch"]) expect(capability(name)).toBeUndefined();
  });
});

describe("handoff plans (ADR 0032 §5)", () => {
  test("the author's development flow", () => {
    expect(HandoffPlan.safeParse(develop).success).toBe(true);
    expect(PlanRun.safeParse({ plan: develop, approved: { at: NOW, by: ACT }, stage: "review", rounds: 1 }).success).toBe(true);
    expect(WorkTask.safeParse(task({ plan: { plan: develop, approved: { at: NOW, by: ACT }, stage: "end", rounds: 4 } })).success).toBe(true);
  });
  test("send-back must target an agent stage; ids unique; at least one agent stage", () => {
    expect(HandoffPlan.safeParse({ stages: [{ kind: "agent", id: "a", agent: "codex", instruction: "x", back_to: "merge" }, { kind: "checkpoint", id: "merge", prompt: "?" }] }).success).toBe(false);
    expect(HandoffPlan.safeParse({ stages: [{ kind: "agent", id: "a", agent: "codex", instruction: "x" }, { kind: "agent", id: "a", agent: "pi", instruction: "y" }] }).success).toBe(false);
    expect(HandoffPlan.safeParse({ stages: [{ kind: "checkpoint", id: "only", prompt: "?" }] }).success).toBe(false);
    expect(HandoffPlan.safeParse({ ...develop, max_rounds: 31 }).success).toBe(false);
  });
  test("checkpoint actions are fixed; sending back needs a target and a reason", () => {
    const checkpoint = (args: object) => WorkCommandRequest.safeParse({ request_id: "req_checkpoint_001", operation: { op: "work.task.checkpoint", args: { task: TASK, stage: "merge", ...args } } }).success;
    expect(checkpoint({ action: "continue" })).toBe(true);
    expect(checkpoint({ action: "finish" })).toBe(true);
    expect(checkpoint({ action: "hold" })).toBe(true);
    expect(checkpoint({ action: "send_back", back_to: "implement", comment: "The button is misaligned." })).toBe(true);
    expect(checkpoint({ action: "send_back", back_to: "implement" })).toBe(false);
    expect(checkpoint({ action: "send_back" })).toBe(false);
    expect(checkpoint({ action: "continue", back_to: "implement" })).toBe(false);
    expect(WorkCommandRequest.safeParse({ request_id: "req_checkpoint_002", operation: { op: "work.task.checkpoint", args: { task: TASK, stage: "end", action: "finish" } } }).success).toBe(true);
  });
  test("plan.set and templates", () => {
    expect(WorkCommandRequest.safeParse({ request_id: "req_plan_set_00001", operation: { op: "work.task.plan.set", args: { task: TASK, expected_revision: 2, plan: develop, from: "review" } } }).success).toBe(true);
    expect(WorkCommandRequest.safeParse({ request_id: "req_plan_set_00002", operation: { op: "work.task.plan.set", args: { task: TASK, expected_revision: 2, plan: null } } }).success).toBe(true);
    expect(WorkCommandRequest.safeParse({ request_id: "req_plan_template1", operation: { op: "work.plan_template.save", args: { name: "Develop", plan: develop } } }).success).toBe(true);
  });
});

describe("delegation needs approval (ADR 0031 §2)", () => {
  test("an agent's delegation or plan is carried only by proposals", () => {
    const dispatch = { op: "work.command", args: { request_id: "req_delegate_0001", operation: { op: "work.task.dispatch", args: { task: TASK, to: "codex@mac", expected_revision: 3 } } } };
    const plan = { op: "work.command", args: { request_id: "req_delegate_0002", operation: { op: "work.task.plan.set", args: { task: TASK, expected_revision: 3, plan: develop } } } };
    expect(ProposalOperation.safeParse(dispatch).success).toBe(true);
    expect(ProposalOperation.safeParse(plan).success).toBe(true);
    expect(ProposalOperation.safeParse({ op: "work.command", args: { request_id: "req_delegate_0003", operation: { op: "work.task.finish", args: { task: TASK, expected_revision: 3, outcome: "done" } } } }).success).toBe(false);
    expect(Operation.safeParse(dispatch).success).toBe(false);
    expect(Proposal.safeParse({ id: "prop_01JABCDEFGHJKMNPQRSTVWXYZ0", operation: dispatch, reason: "Claude wants codex@mac to implement this.", author: ACT, status: "pending", created: NOW }).success).toBe(true);
    expect(WorkCommandResult.safeParse({ kind: "proposal", proposal: "prop_01JABCDEFGHJKMNPQRSTVWXYZ0" }).success).toBe(true);
  });
});

describe("needs you = your turn with a reason to respond", () => {
  test("attention mirrors answer / review / failed and carries checkpoint prompts", () => {
    const base = { task: TASK, title: "T", job: JOB, round: 2, since: NOW };
    expect(WorkAttention.safeParse({ ...base, kind: "review", stage: "merge", prompt: "Merge the PR?" }).success).toBe(true);
    expect(WorkAttention.safeParse({ ...base, kind: "decision" }).success).toBe(false);
    expect(WorkAttention.safeParse({ task: TASK, title: "T", kind: "review", since: NOW }).success).toBe(false);
  });
});

describe("notifications (ADR 0031 §4)", () => {
  test("only your turn (answer, review, failed) and pending proposals notify", () => {
    const event = { id: `turn:${TASK}:3:review`, kind: "turn.review", owner: ACT, title: "Renew domain", path: `#work/${TASK}`, created: NOW };
    expect(NotificationEvent.safeParse(event).success).toBe(true);
    expect(NotificationEvent.safeParse({ ...event, kind: "turn.todo" }).success).toBe(false);
    expect(NotificationEvent.safeParse({ ...event, path: "https://evil.example/" }).success).toBe(false);
  });
  test("https-only subscriptions; devices never expose endpoints", () => {
    const sub = { endpoint: "https://web.push.apple.com/QGuQyavXutnMH", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" }, expirationTime: null };
    expect(PushSubscriptionInput.safeParse(sub).success).toBe(true);
    expect(PushSubscriptionInput.safeParse({ ...sub, endpoint: "http://push.example/x" }).success).toBe(false);
    const device = { id: "pdev_01JABCDEFGHJKMNPQRSTVWXYZ0", owner: ACT, label: "iPhone", events: ["turn.answer"], created: NOW };
    expect(PushDevice.safeParse(device).success).toBe(true);
    expect(PushDevice.safeParse({ ...device, endpoint: sub.endpoint }).success).toBe(false);
  });
  test("all contracts export to JSON Schema", () => {
    for (const schema of Object.values(CONTRACTS)) expect(() => z.toJSONSchema(schema, { io: "input" })).not.toThrow();
  });
});

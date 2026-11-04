import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  CONTRACTS, NotificationEvent, Operation, Proposal, ProposalOperation, PushDevice, PushSubscriptionInput, Workflow, WorkflowRun, WorkAttention,
  WorkCommandRequest, WorkCommandResult, WorkTask, capability,
} from "../src/index.ts";

const TASK = "task_01JABCDEFGHJKMNPQRSTVWXYZ0", ACT = "act_01JABCDEFGHJKMNPQRSTVWXYZ0", JOB = "job_01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = "2026-11-04T20:00:00+08:00";

/** 作者描述的开发流程：实现 → review（可打回）→ 人决定是否合并 → 合并 → 人验收。 */
const develop = {
  steps: [
    { kind: "agent", id: "implement", agent: "codex@mac", instruction: "Implement the task and open a PR." },
    { kind: "agent", id: "review", agent: "claude-code@mac", instruction: "Review the PR.", on_changes: "implement" },
    { kind: "ask", id: "merge", question: "Merge the PR?", options: [{ label: "Merge", next: "do-merge" }, { label: "Not yet", next: "implement" }] },
    { kind: "agent", id: "do-merge", agent: "claude-code@mac", instruction: "Merge the PR." },
    { kind: "accept", id: "accept" },
  ],
};

describe("workflows (ADR 0031 §3)", () => {
  test("the development flow is valid; default max rounds applies", () => {
    expect(Workflow.parse(develop).max_rounds).toBeUndefined();
  });
  test("references must exist, ids are unique, 'end' is reserved", () => {
    expect(Workflow.safeParse({ steps: [{ kind: "agent", id: "a", agent: "codex", instruction: "x", on_changes: "nope" }, { kind: "accept", id: "b" }] }).success).toBe(false);
    expect(Workflow.safeParse({ steps: [{ kind: "accept", id: "a" }, { kind: "accept", id: "a" }] }).success).toBe(false);
    expect(Workflow.safeParse({ steps: [{ kind: "accept", id: "end" }] }).success).toBe(false);
    expect(Workflow.safeParse({ steps: [{ kind: "ask", id: "q", question: "?", options: [{ label: "Stop", next: "end" }, { label: "Again", next: "q" }] }] }).success).toBe(true);
  });
  test("a workflow needs at least one human step and a bounded round count", () => {
    expect(Workflow.safeParse({ steps: [{ kind: "agent", id: "a", agent: "codex", instruction: "x" }] }).success).toBe(false);
    expect(Workflow.safeParse({ ...develop, max_rounds: 31 }).success).toBe(false);
  });
  test("tasks without a workflow still parse; a run records approval and position", () => {
    const task = { schema_version: 2, type: "task", id: TASK, title: "T", description: "", revision: 1, status: "active", assignee: "human",
      created: NOW, updated: NOW, tags: [], dependencies: [], references: [] };
    expect(WorkTask.safeParse(task).success).toBe(true);
    const run = { workflow: develop, approved: { at: NOW, by: ACT }, current: "review", rounds: 1 };
    expect(WorkflowRun.safeParse(run).success).toBe(true);
    expect(WorkTask.safeParse({ ...task, workflow: run }).success).toBe(true);
    expect(WorkflowRun.safeParse({ ...run, stopped: { at: NOW, reason: "max_rounds" } }).success).toBe(true);
  });
  test("set, decide and templates are Work commands; none is an agent capability", () => {
    const set = { request_id: "req_workflow_set_01", operation: { op: "work.task.workflow.set", args: { task: TASK, expected_revision: 2, workflow: develop } } };
    expect(WorkCommandRequest.safeParse(set).success).toBe(true);
    expect(WorkCommandRequest.safeParse({ ...set, operation: { ...set.operation, args: { task: TASK, expected_revision: 2, workflow: null } } }).success).toBe(true);
    const decide = (args: object) => WorkCommandRequest.safeParse({ request_id: "req_workflow_decide", operation: { op: "work.task.workflow.decide", args: { task: TASK, step: "merge", ...args } } }).success;
    expect(decide({ option: 0 })).toBe(true);
    expect(decide({ back_to: "implement", comment: "The button is misaligned." })).toBe(true);
    expect(decide({})).toBe(false);
    expect(decide({ option: 0, back_to: "implement" })).toBe(false);
    for (const name of ["work.task.workflow.set", "work.task.workflow.decide", "work.workflow_template.save"]) expect(capability(name)).toBeUndefined();
  });
});

describe("delegation needs approval (ADR 0031 §2)", () => {
  test("an agent's dispatch or workflow becomes a proposable operation", () => {
    const dispatch = { op: "work.command", args: { request_id: "req_delegate_0001", operation: { op: "work.task.dispatch", args: { task: TASK, to: "codex@mac", expected_revision: 3 } } } };
    expect(ProposalOperation.safeParse(dispatch).success).toBe(true);
    expect(ProposalOperation.safeParse({ op: "work.command", args: { request_id: "req_delegate_0002", operation: { op: "work.task.workflow.set", args: { task: TASK, expected_revision: 3, workflow: develop } } } }).success).toBe(true);
    expect(ProposalOperation.safeParse({ op: "work.command", args: { request_id: "req_delegate_0003", operation: { op: "work.task.update", args: { task: TASK, expected_revision: 3, patch: { status: "done" } } } } }).success).toBe(false);
    // v1 POST /v1/operations does not accept it; only proposals carry it.
    expect(Operation.safeParse(dispatch).success).toBe(false);
    const proposal = { id: "prop_01JABCDEFGHJKMNPQRSTVWXYZ0", operation: dispatch, reason: "Claude wants codex@mac to implement this.", author: ACT, status: "pending", created: NOW };
    expect(Proposal.safeParse(proposal).success).toBe(true);
    expect(WorkCommandResult.safeParse({ kind: "proposal", proposal: "prop_01JABCDEFGHJKMNPQRSTVWXYZ0" }).success).toBe(true);
  });
});

describe("attention for workflow steps", () => {
  test("decision items carry step, question and options instead of a round", () => {
    const decision = { task: TASK, title: "T", kind: "decision", since: NOW, step: "merge", question: "Merge the PR?", options: ["Merge", "Not yet"] };
    expect(WorkAttention.safeParse(decision).success).toBe(true);
    expect(WorkAttention.safeParse({ ...decision, options: undefined }).success).toBe(false);
    expect(WorkAttention.safeParse({ task: TASK, title: "T", kind: "review", since: NOW }).success).toBe(false);
    expect(WorkAttention.safeParse({ task: TASK, title: "T", kind: "review", since: NOW, job: JOB, round: 4, step: "accept" }).success).toBe(true);
  });
});

describe("notifications (ADR 0031 §4)", () => {
  test("events carry only a title and an in-app path", () => {
    const event = { id: `attention:${TASK}:3:review`, kind: "attention.review", owner: ACT, title: "Renew domain", path: `#work/${TASK}`, created: NOW };
    expect(NotificationEvent.safeParse(event).success).toBe(true);
    expect(NotificationEvent.safeParse({ ...event, path: "https://evil.example/" }).success).toBe(false);
    expect(NotificationEvent.safeParse({ ...event, body: "report text" }).success).toBe(false);
  });
  test("subscriptions must use https push endpoints; devices never expose them", () => {
    const sub = { endpoint: "https://web.push.apple.com/QGuQyavXutnMH...", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" }, expirationTime: null };
    expect(PushSubscriptionInput.safeParse(sub).success).toBe(true);
    expect(PushSubscriptionInput.safeParse({ ...sub, endpoint: "http://push.example/x" }).success).toBe(false);
    const device = { id: "pdev_01JABCDEFGHJKMNPQRSTVWXYZ0", owner: ACT, label: "iPhone", events: ["attention.question"], created: NOW };
    expect(PushDevice.safeParse(device).success).toBe(true);
    expect(PushDevice.safeParse({ ...device, endpoint: sub.endpoint }).success).toBe(false);
  });
  test("all new contracts export to JSON Schema", () => {
    for (const schema of Object.values(CONTRACTS)) expect(() => z.toJSONSchema(schema, { io: "input" })).not.toThrow();
  });
});

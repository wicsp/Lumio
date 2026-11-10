import { describe, expect, test } from "bun:test";
import {
  AgentRun, HandoffPlan, JobResult, PlanRun, RuntimeRegistration, Turn, WorkCommand, WorkCommandProposal, WorkProject, WorkProjectPatch,
  planAncestors, planPredecessors, planSinks,
} from "../src/index.ts";

const U = "01J00000000000000000000000";
const now = "2026-11-10T00:00:00Z";
const agent = (id: string, extra: Record<string, unknown> = {}) => ({ kind: "agent", id, agent: "codex@macsp", instruction: `do ${id}`, ...extra });
const checkpoint = (id: string, extra: Record<string, unknown> = {}) => ({ kind: "checkpoint", id, prompt: "试用通过？", ...extra });
const issues = (plan: unknown) => {
  const parsed = HandoffPlan.safeParse(plan);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("ADR 0049 handoff graph", () => {
  test("plans without after stay linear and keep parsing as before", () => {
    const stages = [agent("implement"), agent("review", { back_to: "implement", access: "read" }), checkpoint("trial"), agent("merge")];
    expect(issues({ stages })).toEqual([]);
    expect([...planPredecessors(stages)]).toEqual([["implement", []], ["review", ["implement"]], ["trial", ["review"]], ["merge", ["trial"]]]);
    expect(planSinks(stages)).toEqual(["merge"]);
  });

  test("read-only stages may run in parallel and join", () => {
    const stages = [
      agent("implement", { git: true }),
      agent("review-claude", { agent: "claude-code@macsp", access: "read", back_to: "implement" }),
      agent("review-codex", { access: "read", back_to: "implement", after: ["implement"] }),
      checkpoint("trial", { after: ["review-claude", "review-codex"] }),
      agent("merge", { git: true, secrets: ["github-merge"], hooks: { before: { argv: ["gh", "pr", "checks", "--watch"], timeout_minutes: 120 } } }),
    ];
    expect(issues({ stages, finish: "auto" })).toEqual([]);
    expect([...planAncestors(stages).get("merge")!].sort()).toEqual(["implement", "review-claude", "review-codex", "trial"]);
  });

  test("two writing stages cannot run in parallel; full counts as writing", () => {
    const stages = [agent("a"), agent("b", { after: ["a"] }), agent("c", { after: ["a"], access: "full" })];
    expect(issues({ stages }).some((message) => message.includes("最多一个可写阶段"))).toBe(true);
    expect(issues({ stages: [agent("a"), agent("b", { after: ["a"] }), agent("c", { after: ["a"], access: "read" })] })).toEqual([]);
  });

  test("checkpoints never run alongside other nodes", () => {
    const stages = [agent("a"), agent("b", { after: ["a"], access: "read" }), checkpoint("c", { after: ["a"] })];
    expect(issues({ stages }).some((message) => message.includes("检查点不能与其他节点并行"))).toBe(true);
  });

  test("after must reference existing stages without cycles", () => {
    expect(issues({ stages: [agent("a", { after: ["missing"] })] }).some((m) => m.includes("不存在"))).toBe(true);
    expect(issues({ stages: [agent("a", { after: ["a"] })] }).some((m) => m.includes("自己"))).toBe(true);
    expect(issues({ stages: [agent("a", { after: ["b"] }), agent("b", { after: ["a"] })] }).some((m) => m.includes("环"))).toBe(true);
  });

  test("finish auto requires a checkpoint", () => {
    expect(issues({ stages: [agent("a")], finish: "auto" }).some((m) => m.includes("finish: auto"))).toBe(true);
    expect(issues({ stages: [agent("a"), checkpoint("ok")], finish: "auto" })).toEqual([]);
    expect(issues({ stages: [agent("a")], finish: "review" })).toEqual([]);
  });

  test("stage permissions and hooks are validated", () => {
    expect(issues({ stages: [agent("a", { access: "admin" })] }).length).toBeGreaterThan(0);
    expect(issues({ stages: [agent("a", { secrets: ["GitHub Token"] })] }).length).toBeGreaterThan(0);
    expect(issues({ stages: [agent("a", { hooks: { before: { argv: [] } } })] }).length).toBeGreaterThan(0);
    expect(issues({ stages: [agent("a", { hooks: { after: { argv: ["true"], timeout_minutes: 0 } } })] }).length).toBeGreaterThan(0);
  });
});

describe("ADR 0049 runs, turns and grants", () => {
  const plan = { stages: [agent("implement"), agent("r1", { access: "read" }), agent("r2", { access: "read", after: ["implement"] }), checkpoint("trial", { after: ["r1", "r2"] })] };

  test("plan runs may list parallel active stages and done stages", () => {
    const run = { plan, approved: { at: now, by: `act_${U}` }, stage: "r1", active: ["r1", "r2"], done: ["implement"], rounds: 3 };
    expect(PlanRun.safeParse(run).success).toBe(true);
    expect(PlanRun.safeParse({ ...run, active: ["r1"] }).success).toBe(false);
    const { active: _active, done: _done, ...legacy } = run;
    expect(PlanRun.safeParse(legacy).success).toBe(true);
  });

  test("agents holder carries parallel branches and only then", () => {
    const branch = (stage: string, n: number) => ({ stage, agent: "codex@macsp", job: `job_01J0000000000000000000000${n}`, round: n });
    const parallel = { holder: "agents", reason: "working", since: now, parallel: [branch("r1", 1), branch("r2", 2)] };
    expect(Turn.safeParse(parallel).success).toBe(true);
    expect(Turn.safeParse({ ...parallel, parallel: undefined }).success).toBe(false);
    expect(Turn.safeParse({ ...parallel, reason: "review" }).success).toBe(false);
    expect(Turn.safeParse({ holder: "codex@macsp", reason: "working", since: now, parallel: parallel.parallel }).success).toBe(false);
  });

  test("grant command approves permissions for the next round or the task", () => {
    const grant = (args: Record<string, unknown>) => WorkCommand.safeParse({ op: "work.task.grant", args: { task: `task_${U}`, expected_revision: 2, ...args } }).success;
    expect(grant({ permissions: { git: true }, scope: "next_round" })).toBe(true);
    expect(grant({ permissions: { secrets: ["github-merge"] }, scope: "task", continue: false })).toBe(true);
    expect(grant({ permissions: {}, scope: "task" })).toBe(false);
    expect(grant({ permissions: { git: true }, scope: "forever" })).toBe(false);
  });

  test("agents may propose saving a plan template", () => {
    const proposal = { op: "work.command", args: { request_id: "req-template-000001", operation: { op: "work.plan_template.save", args: { name: "PR 开发", plan } } } };
    expect(WorkCommandProposal.safeParse(proposal).success).toBe(true);
  });

  test("projects can name a default plan template", () => {
    const project = { schema_version: 2, type: "project", id: `prj_${U}`, title: "P", description: "", revision: 1, status: "active", created: now, updated: now, tags: [] };
    expect(WorkProject.parse({ ...project, default_plan: `wft_${U}` }).default_plan).toBe(`wft_${U}`);
    expect(WorkProjectPatch.parse({ default_plan: null }).default_plan).toBeNull();
    expect(WorkProject.safeParse({ ...project, default_plan: "codex@macsp" }).success).toBe(false);
  });
});

describe("ADR 0049 job protocol additions", () => {
  test("agent runs may carry permissions and hooks; results may carry a permission request", () => {
    expect(AgentRun.safeParse({ kind: "agent", engine: "codex", prompt: "p", permissions: { access: "write", git: true }, hooks: { after: { argv: ["bun", "run", "check"] } } }).success).toBe(true);
    const result = { job: `job_${U}`, lease: "lease-0123456789abcdef", status: "waiting_for_human", finished: now, report: "需要写 Git", permission: { git: true } };
    expect(JobResult.safeParse(result).success).toBe(true);
  });

  test("runtimes may declare optional features; old registrations still parse", () => {
    const registration = { protocol_version: 2, name: "macsp", engines: [], tags: [], max_concurrent: 1 };
    expect(RuntimeRegistration.safeParse(registration).success).toBe(true);
    expect(RuntimeRegistration.safeParse({ ...registration, features: ["stage_permissions", "hooks", "permission_request"] }).success).toBe(true);
    expect(RuntimeRegistration.safeParse({ ...registration, features: ["teleport"] }).success).toBe(false);
  });
});

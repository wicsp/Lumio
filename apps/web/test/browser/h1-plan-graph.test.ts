import { describe, expect, test } from "bun:test";
import { HandoffPlan, WorkCommandRequest, type PlanRun, type WorkTask } from "@lumio/schema";
import {
  draftPlan, formatArgv, parseArgv, planProblem, planRows, roleDraft, rowsAfter, stageStates, toDraft, unenforced, type DraftStage,
} from "../../src/client/plan.ts";
import { turnText, workingAgent } from "../../src/client/turn.ts";
import { continueTarget, describeTurn } from "../../src/client/panes/work-editor.ts";
import { proposalTitle, type WorkProposal } from "../../src/client/proposal-card.ts";
import { setLang } from "../../src/client/i18n.ts";

setLang("en", false);
const at = "2026-11-10T00:00:00Z", ACT = "act_01JABCDEFGHJKMNPQRSTVWXYZ0", ID = "task_01JABCDEFGHJKMNPQRSTVWXYZ0";
const job = (n: number) => `job_01JABCDEFGHJKMNPQRSTVWXY${n}0`;
const agent = (id: string, extra: object = {}) => ({ kind: "agent" as const, id, agent: "codex@macsp", instruction: id, ...extra });

describe("rows ⇄ after (ADR 0049)", () => {
  test("linear plans are one stage per row and need no after", () => {
    const rows = planRows([agent("a"), agent("b"), agent("c")]);
    expect(rows).toEqual([["a"], ["b"], ["c"]]);
    expect(rowsAfter(rows!)).toBeUndefined();
  });
  test("parallel rows join on the whole previous row", () => {
    const stages = [agent("impl"), agent("r1", { after: ["impl"] }), agent("r2", { after: ["impl"] }), { kind: "checkpoint" as const, id: "trial", prompt: "?", after: ["r1", "r2"] }];
    expect(planRows(stages)).toEqual([["impl"], ["r1", "r2"], ["trial"]]);
    expect(Object.fromEntries(rowsAfter([["impl"], ["r1", "r2"], ["trial"]])!)).toEqual({ impl: [], r1: ["impl"], r2: ["impl"], trial: ["r1", "r2"] });
  });
  test("graphs that are not rows are reported, not reshaped", () => {
    expect(planRows([agent("a"), agent("b", { after: [] }), agent("c", { after: ["a"] })])).toBeUndefined();
  });
});

describe("hook commands", () => {
  test("split like a shell without running one", () => {
    expect(parseArgv("gh pr checks --watch")).toEqual(["gh", "pr", "checks", "--watch"]);
    expect(parseArgv(`bash -lc "echo 'hi there'" x\\ y`)).toEqual(["bash", "-lc", "echo 'hi there'", "x y"]);
    expect(parseArgv(`echo "open`)).toBeUndefined();
    const argv = ["bash", "-lc", "a && b", 'say "x"'];
    expect(parseArgv(formatArgv(argv))).toEqual(argv);
  });
});

describe("drafts become valid plans", () => {
  const rows = (stages: DraftStage[][]) => draftPlan(stages, { finish: "auto" });
  test("roles produce the author's development flow", () => {
    const built = rows([
      [roleDraft("implement", "implement", "codex@macsp")],
      [roleDraft("review", "review-claude", "claude-code@macsp", "implement"), roleDraft("review", "review-codex", "codex@macsp", "implement")],
      [roleDraft("deploy", "deploy", "codex@macsp")],
      [roleDraft("trial", "trial", "")],
      [roleDraft("merge", "merge", "codex@macsp")],
    ]);
    if (!("plan" in built)) throw Error(built.problem);
    expect(planProblem(built.plan)).toBeUndefined();
    const plan = HandoffPlan.parse(built.plan);
    expect(plan.finish).toBe("auto");
    const merge = plan.stages.find(stage => stage.id === "merge")!;
    expect(merge.kind === "agent" && merge.hooks?.before?.argv).toEqual(["gh", "pr", "checks", "--watch"]);
    expect(plan.stages.find(stage => stage.id === "review-codex")).toMatchObject({ access: "read", back_to: "implement", after: ["implement"] });
    const command: WorkCommandRequest = { request_id: "synthetic-h1-7-plan-0001", operation: { op: "work.task.plan.set", args: { task: ID, expected_revision: 1, plan } } };
    expect(WorkCommandRequest.safeParse(command).success).toBe(true);
  });
  test("round trips keep permissions, hooks and timeouts", () => {
    const stage = agent("ship", { access: "full", git: true, secrets: ["github-merge"], hooks: { before: { argv: ["gh", "pr", "checks", "--watch"], timeout_minutes: 120 } } });
    const built = draftPlan([[toDraft(stage)]]);
    expect("plan" in built && built.plan.stages[0]).toEqual(stage);
  });
  test("problems are explained in the interface language", () => {
    expect(draftPlan([[{ ...roleDraft("merge", "m", "codex@macsp"), before: `echo "x` }]])).toEqual({ problem: "Step 1: the hook command has an unclosed quote." });
    const writers = draftPlan([[roleDraft("implement", "a", "codex@macsp")], [roleDraft("implement", "b", "codex@macsp"), roleDraft("deploy", "c", "codex@macsp")]]);
    expect("plan" in writers && planProblem(writers.plan)).toMatch(/^This plan isn't valid: /);
    const noCheck = draftPlan([[roleDraft("implement", "a", "codex@macsp")]], { finish: "auto" });
    expect("plan" in noCheck && planProblem(noCheck.plan)).toMatch(/at least one checkpoint/);
  });
  test("permissions that a sandbox-less engine cannot enforce are flagged", () => {
    expect(unenforced(roleDraft("review", "r", "claude-code@macsp"), "none")).toBe(true);
    expect(unenforced(roleDraft("review", "r", "codex@macsp"), "os")).toBe(false);
    expect(unenforced({ kind: "agent", access: "full", git: true }, "none")).toBe(false);
  });
});

describe("progress and turns", () => {
  const plan = HandoffPlan.parse({ stages: [agent("impl"), agent("r1", { access: "read", after: ["impl"] }), agent("r2", { access: "read", after: ["impl"] }), { kind: "checkpoint", id: "trial", prompt: "?", after: ["r1", "r2"] }] });
  const run = (extra: Partial<PlanRun>): PlanRun => ({ plan, approved: { at, by: ACT }, stage: "impl", rounds: 1, ...extra });
  test("done and active stages come from the run, with a linear fallback", () => {
    expect([...stageStates(run({ stage: "r1", active: ["r1", "r2"], done: ["impl"] }))]).toEqual([["impl", "done"], ["r1", "current"], ["r2", "current"], ["trial", "next"]]);
    expect(stageStates(run({ stage: "r2" })).get("impl")).toBe("done");
    expect(stageStates(run({ stage: "end", done: ["impl", "r1", "r2", "trial"] })).get("trial")).toBe("done");
  });
  test("parallel turns name every agent and pick the right branch", () => {
    const parallel = { holder: "agents" as const, reason: "working" as const, since: at, stage: "r1",
      parallel: [{ stage: "r1", agent: "claude-code@macsp", job: job(1), round: 2 }, { stage: "r2", agent: "codex@macsp", job: job(2), round: 3 }] };
    const task = { schema_version: 3, type: "task", id: ID, title: "T", description: "", revision: 4, outcome: "open", turn: parallel, created: at, updated: at, tags: [], dependencies: [], references: [] } as WorkTask;
    expect(turnText(task)).toBe("2 agents are working in parallel: claude-code@macsp, codex@macsp");
    expect(workingAgent(parallel, "r2")).toBe("codex@macsp");
    expect(describeTurn({ task: ID, at, by: ACT, from: parallel, to: { holder: "human", reason: "answer", since: at, stage: "r2" } })).toEqual(["help", "codex@macsp asked a question"]);
    expect(describeTurn({ task: ID, at, by: ACT, from: { holder: "human", reason: "todo", since: at }, to: parallel })[1]).toMatch(/^Running in parallel: claude-code@macsp \(step r1, round 2\)/);
    const answered = { ...task, turn: { holder: "human" as const, reason: "answer" as const, since: at, stage: "r2" } };
    expect(continueTarget({ task: answered, dependents: [], children: [], comments: [], executions: [], turns: [{ task: ID, at, by: ACT, from: { holder: "human", reason: "todo", since: at }, to: parallel }] })).toBe("codex@macsp");
  });
});

describe("template proposals", () => {
  test("have their own title without a task", () => {
    const proposal = { id: "prop_01JABCDEFGHJKMNPQRSTVWXYZ0", author: ACT, reason: "r", status: "pending", created: at,
      operation: { op: "work.command", args: { request_id: "synthetic-template-0001", operation: { op: "work.plan_template.save", args: { name: "PR flow", plan } } } } } as unknown as WorkProposal;
    expect(proposalTitle(proposal, "Codex", "")).toBe("Codex proposes saving a plan template “PR flow”");
  });
  const plan = { stages: [agent("impl")] };
});

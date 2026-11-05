import { describe, expect, test } from "bun:test";
import { WorkCommandRequest, type HandoffPlan, type WorkTask } from "@lumio/schema";
import { finishCommand, handCommand, reopenCommand, turnActionCommand, turnActions, turnGroup, turnText } from "../../src/client/turn.ts";
import { checkpointCommand, planProblem, planSetCommand, templateSaveCommand } from "../../src/client/plan.ts";
import { base64UrlBytes, pushBlocker } from "../../src/client/notification-settings.ts";
import { setLang } from "../../src/client/i18n.ts";
import { SERVICE_WORKER } from "../../src/sw.ts";

const ID = "task_01JABCDEFGHJKMNPQRSTVWXYZ0", JOB = "job_01JABCDEFGHJKMNPQRSTVWXYZ0", at = "2026-11-05T00:00:00Z";
const task = (turn: WorkTask["turn"], outcome: WorkTask["outcome"] = "open"): WorkTask => ({
  schema_version: 3, type: "task", id: ID, title: "T", description: "", revision: 5, outcome, turn,
  created: at, updated: at, tags: [], dependencies: [], references: [],
});
const valid = (request: WorkCommandRequest) => expect(WorkCommandRequest.parse(request)).toEqual(request);

describe("turn groups (ADR 0032)", () => {
  test("every holder and reason lands in exactly one group", () => {
    expect(turnGroup(task({ holder: "human", reason: "review", since: at, round: 1, job: JOB }))).toBe("needs");
    expect(turnGroup(task({ holder: "human", reason: "answer", since: at }))).toBe("needs");
    expect(turnGroup(task({ holder: "human", reason: "failed", since: at }))).toBe("needs");
    expect(turnGroup(task({ holder: "human", reason: "todo", since: at }))).toBe("todo");
    expect(turnGroup(task({ holder: "codex@mac", reason: "working", since: at, round: 2, job: JOB }))).toBe("agents");
    expect(turnGroup(task({ holder: "external", reason: "waiting", since: at, note: "CI" }))).toBe("external");
    expect(turnGroup(task({ holder: "nobody", reason: "on_hold", since: at }))).toBe("hold");
    expect(turnGroup(task({ holder: "nobody", reason: "on_hold", since: at }, "done"))).toBe("done");
    expect(turnGroup(task({ holder: "nobody", reason: "on_hold", since: at }, "cancelled"))).toBe("cancelled");
  });
  test("turn text names who has it, in both languages", () => {
    setLang("en", false);
    expect(turnText(task({ holder: "codex@mac", reason: "working", since: at, round: 3, job: JOB }))).toBe("codex@mac is working (round 3)");
    expect(turnText(task({ holder: "human", reason: "review", since: at }))).toBe("Your turn · Ready for review");
    setLang("zh", false);
    expect(turnText(task({ holder: "external", reason: "waiting", since: at, note: "CI" }))).toBe("在等外部：CI");
    setLang("en", false);
  });
  test("actions match the turn and every command satisfies the contract", () => {
    const todo = task({ holder: "human", reason: "todo", since: at });
    expect(turnActions(todo)).toEqual(["external", "hold", "done", "cancel"]);
    expect(turnActions(task({ holder: "nobody", reason: "on_hold", since: at }, "done"))).toEqual(["reopen"]);
    expect(turnActions(task({ holder: "human", reason: "review", since: at }))).toContain("mine");
    for (const action of turnActions(todo)) valid(turnActionCommand(todo, action, "Waiting for CI"));
    valid(handCommand(todo, "human")); valid(finishCommand(todo, "cancelled")); valid(reopenCommand(todo));
    expect(handCommand(todo, "external", "x".repeat(300)).operation.args).toMatchObject({ note: "x".repeat(200) });
  });
});

describe("handoff plans", () => {
  const plan: HandoffPlan = { stages: [
    { kind: "agent", id: "implement", agent: "codex@mac", instruction: "Implement" },
    { kind: "agent", id: "review", agent: "claude-code@mac", instruction: "Review", back_to: "implement" },
    { kind: "checkpoint", id: "merge-ok", prompt: "Merge it?" },
  ] };
  test("plan, checkpoint and template commands satisfy the contract", () => {
    valid(planSetCommand({ id: ID, revision: 2 }, plan, "review"));
    valid(planSetCommand({ id: ID, revision: 2 }, null));
    valid(checkpointCommand(ID, "merge-ok", "continue"));
    valid(checkpointCommand(ID, "end", "send_back", { backTo: "implement", comment: " fix tests " }));
    expect(checkpointCommand(ID, "merge-ok", "hold", { backTo: "implement" }).operation.args).not.toHaveProperty("back_to");
    valid(templateSaveCommand(" Dev loop ", plan));
  });
  test("problems are explained before the contract rejects the plan", () => {
    setLang("en", false);
    expect(planProblem(plan)).toBeUndefined();
    expect(planProblem({ stages: [{ kind: "checkpoint", id: "a", prompt: "?" }] })).toBe("A plan needs at least one agent step.");
    expect(planProblem({ stages: [{ kind: "agent", id: "Bad", agent: "codex", instruction: "x" }] })).toMatch(/^Step 1:/);
    expect(planProblem({ stages: [{ kind: "agent", id: "a", agent: "codex", instruction: "x", back_to: "b" }, { kind: "checkpoint", id: "b", prompt: "?" }] })).toMatch(/send work back/);
    expect(planProblem({ stages: [{ kind: "agent", id: "a", agent: "codex", instruction: " " }] })).toMatch(/describe/);
  });
});

describe("push", () => {
  test("blockers explain HTTPS, iOS Home Screen and support", () => {
    setLang("en", false);
    expect(pushBlocker({ secure: false, supported: true, ios: false, standalone: false })).toMatch(/HTTPS/);
    expect(pushBlocker({ secure: true, supported: true, ios: true, standalone: false })).toMatch(/Home Screen/);
    expect(pushBlocker({ secure: true, supported: false, ios: false, standalone: false })).toMatch(/doesn't support/);
    expect(pushBlocker({ secure: true, supported: true, ios: true, standalone: true })).toBeUndefined();
  });
  test("VAPID keys decode from base64url", () => {
    expect([...base64UrlBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });
  test("the service worker only handles push and clicks", () => {
    expect(SERVICE_WORKER).toContain('addEventListener("push"');
    expect(SERVICE_WORKER).toContain('addEventListener("notificationclick"');
    expect(SERVICE_WORKER).not.toContain('addEventListener("fetch"');
    expect(SERVICE_WORKER).not.toMatch(/caches\./);
    expect(() => new Function(SERVICE_WORKER)).not.toThrow();
  });
});

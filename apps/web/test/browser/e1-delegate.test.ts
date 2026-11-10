import { describe, expect, test } from "bun:test";
import { WorkCommandRequest, WorkTask } from "@lumio/schema";
import { nextTargetText, quickDelegateTarget, quickDispatchCommand, targetSourceLabel } from "../../src/client/delegate.ts";
import { setLang } from "../../src/client/i18n.ts";

const at = "2026-11-10T00:00:00Z";
const id = (n: number) => `task_01JABCDEFGHJKMNPQRSTVWXY${String(n).padStart(2, "0")}`;
const task = (extra: Partial<WorkTask> = {}): WorkTask => WorkTask.parse({
  schema_version: 3, type: "task", id: id(1), title: "T1", description: "", revision: 4, outcome: "open",
  turn: { holder: "human", reason: "todo", since: at }, created: at, updated: at, tags: [], dependencies: [], references: [], ...extra,
});
const next = { target: "codex@macsp", source: "project" } as const;

describe("E1-4 quick delegate (ADR 0044)", () => {
  test("only open, unblocked human to-dos with a derived target get the button", () => {
    expect(quickDelegateTarget(task({ next_target: next }))).toEqual(next);
    expect(quickDelegateTarget(task())).toBeUndefined();
    expect(quickDelegateTarget(task({ next_target: next, dependencies: [id(2)], blocked_by: [id(2)] }))).toBeUndefined();
    expect(quickDelegateTarget(task({ next_target: next, turn: { holder: "human", reason: "review", since: at } }))).toBeUndefined();
    expect(quickDelegateTarget(task({ next_target: next, turn: { holder: "codex@macsp", reason: "working", since: at, job: "job_01JABCDEFGHJKMNPQRSTVWXY00" } as WorkTask["turn"] }))).toBeUndefined();
    expect(quickDelegateTarget(task({ next_target: next, outcome: "done", turn: { holder: "nobody", reason: "on_hold", since: at } }))).toBeUndefined();
  });

  test("a click sends no target so the Hub resolves it; picking someone else sends an explicit one", () => {
    const implicit = WorkCommandRequest.parse(quickDispatchCommand(task(), undefined, "request-0000000001"));
    expect(implicit.operation).toEqual({ op: "work.task.dispatch", args: { task: id(1), expected_revision: 4 } });
    const explicit = WorkCommandRequest.parse(quickDispatchCommand(task(), "claude-code@macsp", "request-0000000002"));
    expect(explicit.operation.op === "work.task.dispatch" && explicit.operation.args.to).toBe("claude-code@macsp");
  });

  test("source labels are readable in both languages", () => {
    setLang("en", false);
    expect(nextTargetText(next)).toBe("codex@macsp (project default)");
    expect(targetSourceLabel("last_round")).toBe("last round");
    setLang("zh", false);
    expect(nextTargetText({ target: "codex@macsp", source: "last_round" })).toBe("codex@macsp（上一轮）");
    setLang("en", false);
  });
});

import { describe, expect, test } from "bun:test";
import { WorkCommandRequest, type WorkTask } from "@lumio/schema";
import { isBlocked, turnGroup } from "../../src/client/turn.ts";
import { allTags, blockingTitles, childProgress, normalizeTag, parentCandidates, prerequisiteCandidates, prerequisiteState } from "../../src/client/task-structure.ts";
import { taskCreateCommand, workPatchCommand } from "../../src/client/commands.ts";

const at = "2026-11-08T00:00:00Z";
const id = (n: number) => `task_01JABCDEFGHJKMNPQRSTVWXY${String(n).padStart(2, "0")}`;
const task = (n: number, extra: Partial<WorkTask> = {}): WorkTask => ({
  schema_version: 3, type: "task", id: id(n), title: `T${n}`, description: "", revision: 1, outcome: "open",
  turn: { holder: "human", reason: "todo", since: at }, created: at, updated: at, tags: [], dependencies: [], references: [], ...extra,
});

describe("T1-4 blocked group (ADR 0039)", () => {
  test("a human to-do with open prerequisites is waiting on prerequisites; other turns are unchanged", () => {
    const blocked = task(1, { dependencies: [id(2)], blocked_by: [id(2)] });
    expect(isBlocked(blocked)).toBe(true);
    expect(turnGroup(blocked)).toBe("blocked");
    expect(turnGroup(task(1, { dependencies: [id(2)], blocked_by: [] }))).toBe("todo");
    expect(turnGroup(task(1, { dependencies: [id(2)] }))).toBe("todo");
    // Needs-you still wins: a question or review must not hide behind prerequisites.
    expect(turnGroup(task(1, { blocked_by: [id(2)], turn: { holder: "human", reason: "review", since: at } }))).toBe("needs");
    expect(turnGroup(task(1, { blocked_by: [id(2)], turn: { holder: "external", reason: "waiting", since: at, note: "CI" } }))).toBe("external");
    expect(isBlocked(task(1, { blocked_by: [id(2)], outcome: "done", turn: { holder: "nobody", reason: "on_hold", since: at } }))).toBe(false);
  });
});

describe("T1-4 structure helpers", () => {
  const tasks = [
    task(1, { dependencies: [id(2), id(3), id(9)], blocked_by: [id(2)], tags: ["ui", "infra"] }),
    task(2, { title: "Schema", tags: ["infra"] }),
    task(3, { outcome: "cancelled", turn: { holder: "nobody", reason: "on_hold", since: at } }),
    task(4, { dependencies: [id(1)], parent: id(5) }),
    task(5),
    task(6, { parent: id(4), outcome: "done", turn: { holder: "nobody", reason: "on_hold", since: at } }),
  ];
  const byId = new Map(tasks.map(value => [value.id, value]));

  test("prerequisite states include deleted ones and blocking titles come from the list", () => {
    expect(prerequisiteState(id(2), byId)).toBe("open");
    expect(prerequisiteState(id(3), byId)).toBe("cancelled");
    expect(prerequisiteState(id(9), byId)).toBe("deleted");
    expect(blockingTitles(tasks[0]!, byId)).toEqual(["Schema"]);
    expect(blockingTitles(task(7, { blocked_by: [id(8)] }), byId)).toEqual([id(8)]);
  });

  test("prerequisite candidates exclude self, existing, cancelled and anything that would form a cycle", () => {
    const ids = prerequisiteCandidates(tasks[0]!, tasks).map(value => value.id);
    expect(ids).not.toContain(id(1));
    expect(ids).not.toContain(id(2));
    expect(ids).not.toContain(id(3));
    expect(ids).not.toContain(id(4)); // T4 depends on T1
    expect(ids).toEqual([id(5), id(6)]); // open before done
  });

  test("parent candidates exclude self and every descendant", () => {
    const ids = parentCandidates(tasks[4]!, tasks).map(value => value.id); // T5 is parent of T4, T4 of T6
    expect(ids).not.toContain(id(5));
    expect(ids).not.toContain(id(4));
    expect(ids).not.toContain(id(6));
    expect(ids).not.toContain(id(3));
    expect(ids).toContain(id(1));
  });

  test("tags, progress and normalization", () => {
    expect(allTags(tasks)).toEqual(["infra", "ui"]);
    expect(childProgress([id(4), id(6), id(3), id(9)], byId)).toEqual({ done: 1, total: 2 });
    expect(normalizeTag("  #paper ")).toBe("paper");
    expect(normalizeTag(" ## ")).toBeUndefined();
  });

  test("subtask creation and structure patches satisfy the contract", () => {
    const create = taskCreateCommand({ title: " Child ", project: "prj_01JABCDEFGHJKMNPQRSTVWXYZ0", parent: id(5) }, "req_t1_create_subtask");
    expect(WorkCommandRequest.parse(create)).toEqual(create);
    expect(create.operation).toMatchObject({ op: "work.task.create", args: { title: "Child", parent: id(5) } });
    const patch = workPatchCommand(tasks[0]!, { dependencies: [id(2), id(3), id(9), id(5)] }, "req_t1_patch_dependencies")!;
    expect(WorkCommandRequest.parse(patch)).toEqual(patch);
    expect(patch.operation).toMatchObject({ op: "work.task.update", args: { patch: { dependencies: [id(2), id(3), id(9), id(5)] } } });
    expect(workPatchCommand(tasks[0]!, { tags: ["ui", "infra"] })).toBeUndefined();
  });
});

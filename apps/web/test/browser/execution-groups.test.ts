import { describe, expect, test } from "bun:test";
import { Job, WorkAttention, WorkTask } from "@lumio/schema";
import { executionGroups } from "../../src/client/execution-groups.ts";

const at = "2026-11-05T00:00:00Z";
const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(26, "0")}`;
function run(n: number, status: Job["status"], task?: number, round = 1): Job {
  return Job.parse({ spec: {
    protocol_version: 2, id: id("job", n), runtime: id("act", 1), lease: "synthetic-lease-value",
    run: { kind: "agent", engine: "codex", prompt: "Synthetic test" }, workdir: "~/synthetic", timeout_seconds: 60,
    created: at, ...(task === undefined ? {} : { source: { task: id("task", task), round } }),
  }, status });
}
function task(n: number, turn: WorkTask["turn"], outcome: WorkTask["outcome"] = "open"): WorkTask {
  return WorkTask.parse({ schema_version: 3, type: "task", id: id("task", n), title: "Synthetic task", description: "",
    revision: 1, outcome, turn, created: at, updated: at, tags: [], dependencies: [], references: [] });
}
function attention(job: Job, kind: WorkAttention["kind"] = "review"): WorkAttention {
  return WorkAttention.parse({ task: job.spec.source!.task, title: "Synthetic task", kind, job: job.spec.id,
    round: job.spec.source!.round, since: at });
}
const human = (reason: "answer" | "review" | "failed" | "todo", job: Job): WorkTask["turn"] =>
  ({ holder: "human", reason, since: at, job: job.spec.id, round: job.spec.source!.round });

describe("execution attention follows the current turn", () => {
  test("the four handled historical questions leave attention without deleting their results", () => {
    const old = [1, 2, 3, 4].map(n => run(n, "waiting_for_human", n));
    const newer = [1, 2, 3, 4].map(n => run(n + 4, "done", n, 2));
    const tasks = newer.map((job, i) => task(i + 1, { holder: "nobody", reason: "on_hold", since: at }, "done"));
    const jobs = [...old, ...newer];
    const before = JSON.stringify(jobs);
    expect(executionGroups(jobs, tasks, [])).toEqual({ needs: [], live: [], history: jobs });
    expect(JSON.stringify(jobs)).toBe(before);
  });

  test("a current review or checkpoint needs attention even though the run is done", () => {
    const old = run(1, "waiting_for_human", 1), current = run(2, "done", 1, 3);
    const checkpoint = WorkAttention.parse({ ...attention(current), stage: "tag-ok", prompt: "Tag it?" });
    const groups = executionGroups([current, old], [task(1, human("review", current))], [checkpoint]);
    expect(groups.needs).toEqual([current]);
    expect(groups.history).toEqual([old]);
  });

  test("an empty attention response is authoritative rather than enabling the legacy fallback", () => {
    const waiting = run(1, "waiting_for_human", 1);
    expect(executionGroups([waiting], [task(1, human("answer", waiting))], []).needs).toEqual([]);
    expect(executionGroups([waiting], undefined, []).history).toEqual([waiting]);
  });

  test("answering or taking the task back removes attention without another run", () => {
    const job = run(1, "waiting_for_human", 1);
    expect(executionGroups([job], [task(1, human("answer", job))]).needs).toEqual([job]);
    const groups = executionGroups([job], [task(1, { holder: "human", reason: "todo", since: at })]);
    expect(groups.needs).toEqual([]);
    expect(groups.history).toEqual([job]);
  });

  test("old Hubs use task turns for current questions, failures and reviews", () => {
    for (const [status, reason] of [["waiting_for_human", "answer"], ["failed", "failed"], ["unknown", "failed"], ["done", "review"]] as const) {
      const job = run(1, status, 1);
      expect(executionGroups([job], [task(1, human(reason, job))]).needs).toEqual([job]);
    }
  });

  test("completed, cancelled, delegated, external and held tasks don't resurrect old problems", () => {
    const jobs = [run(1, "waiting_for_human", 1), run(2, "failed", 1), run(3, "unknown", 1)];
    const turns: WorkTask[] = [
      task(1, { holder: "nobody", reason: "on_hold", since: at }, "done"),
      task(1, { holder: "nobody", reason: "on_hold", since: at }, "cancelled"),
      task(1, { holder: "codex@mac", reason: "working", since: at, job: id("job", 4), round: 4 }),
      task(1, { holder: "external", reason: "waiting", since: at, note: "CI" }),
      task(1, { holder: "nobody", reason: "on_hold", since: at }),
    ];
    for (const current of turns) expect(executionGroups(jobs, [current])).toEqual({ needs: [], live: [], history: jobs });
  });

  test("matching the current job also checks the task id", () => {
    const job = run(1, "done", 1);
    expect(executionGroups([job], undefined, [{ ...attention(job), task: id("task", 2) }]).needs).toEqual([]);
  });

  test("legacy fallback ignores superseded rounds even with a status filter and tied timestamps", () => {
    const old = run(1, "waiting_for_human", 1), current = run(2, "done", 1, 2);
    for (const jobs of [[current, old], [old, current]]) {
      expect(executionGroups(jobs, undefined, undefined, "waiting_for_human")).toEqual({ needs: [], live: [], history: [old] });
    }
    expect(executionGroups([old]).needs).toEqual([old]);
  });

  test("status filtering preserves the classification of a current review", () => {
    const old = run(1, "failed", 1), current = run(2, "done", 1, 2);
    expect(executionGroups([old, current], undefined, [attention(current)], "failed")).toEqual({ needs: [], live: [], history: [old] });
    expect(executionGroups([old, current], undefined, [attention(current)], "done").needs).toEqual([current]);
  });

  test("physical live runs stay live and each run appears once", () => {
    const live = ["queued", "assigned", "running"].map((status, i) => run(i + 1, status as Job["status"], 1, i + 1));
    const done = run(4, "done", 2), cancelled = run(5, "cancelled", 2, 2);
    const groups = executionGroups([...live, done, cancelled], [], []);
    expect(groups).toEqual({ needs: [], live, history: [done, cancelled] });
    expect(new Set(Object.values(groups).flat()).size).toBe(5);
  });

  test("standalone and routine problem runs remain visible without a Work turn", () => {
    const standalone = run(1, "failed");
    const routine = Job.parse({ ...run(2, "unknown"), spec: { ...run(2, "unknown").spec,
      source: { routine: id("rtn", 1), round: 1 } } });
    expect(executionGroups([standalone, routine], [], []).needs).toEqual([standalone, routine]);
  });
});

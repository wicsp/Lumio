import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ExecutionOverview, Job, type JobStatus } from "@lumio/schema";
import { SqliteExecutionStore } from "../src/execution.ts";

const id = (prefix: string, n: number) => prefix + "_" + String(n).padStart(26, "0");
const created = "2026-11-25T00:00:00Z";
const lease = "synthetic-test-lease";
test("overview counts all current jobs and pages standalone issues without transferring reports", () => {
  using db = new Database(":memory:", { strict: true });
  const store = new SqliteExecutionStore(db, { runtimes: () => [], syncRuntime() {} });
  const note = "🧪".repeat(300);
  const history = "synthetic long result ".repeat(1000);
  const add = (n: number, status: JobStatus, task?: string) => {
    const job = id("job", n);
    store.save(Job.parse({
      spec: { id: job, protocol_version: 2, runtime: id("act", 1), lease, created, workdir: "~", timeout_seconds: 100,
        run: { kind: "command", argv: ["true", history] }, ...(task ? { source: { task, round: 1 } } : {}) },
      status, ...(status === "failed" ? { result: { job, lease, status, finished: created, error: note, report: history } } : {}),
    }));
    return job;
  };
  const task = id("task", 1), review = id("task", 2);
  const first = add(1, "running", task), parallel = add(2, "running", task);
  const pending = add(3, "done", review);
  add(4, "failed", review);
  const missing = add(5, "queued", id("task", 3));
  add(6, "done", id("task", 3));
  for (let i = 10; i < 55; i++) add(i, i < 35 ? "failed" : "done");
  const turns = { visible: [task, review], current: [first, parallel, pending], needs: [pending] };
  const overview = ExecutionOverview.parse(store.overview(turns));
  expect(overview.execution_count).toBe(29); // Three live, one current review, 25 standalone issues.
  expect(overview.activity_live_count).toBe(2);
  expect(overview.activity.map(row => row.id)).toEqual([missing, parallel, id("job", 54), id("job", 53), id("job", 52)]);
  expect(overview.standalone_attention.total).toBe(25);
  expect(overview.standalone_attention.items).toHaveLength(20);
  expect(overview.standalone_attention.items[0]?.preview).toBe("🧪".repeat(240));
  expect(JSON.stringify(overview)).not.toContain(history);
  const cursor = overview.standalone_attention.next_before!;
  add(56, "failed");
  const next = ExecutionOverview.parse(store.overview(turns, cursor)).standalone_attention;
  expect(next.items.map(row => row.id)).toEqual([14, 13, 12, 11, 10].map(n => id("job", n)));
  expect(next.total).toBe(26);
  expect(next.next_before).toBeUndefined();
  expect(store.overview(turns, id("job", 999))).toBeUndefined();
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ExecutionJobs, ExecutionRoutines, routineJobId } from "@lumio/execution";
import { RuntimeInfo, JobResult } from "@lumio/schema";
import { SqliteExecutionStore } from "../src/execution.ts";
import { SqliteRoutineStore } from "../src/routines.ts";
const actor = "act_00000000000000000000000001";
function fixture() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys=ON");
  let now = new Date("2026-11-01T00:00:00Z"), sequence = 0;
  const runtime = RuntimeInfo.parse({ actor, registration: { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "0.50.1", sandbox: "none" }], tags: [], max_concurrent: 1 }, last_seen: now.toISOString(), online: true });
  const registry = { runtimes: () => [runtime], syncRuntime() {} };
  let routines: ExecutionRoutines;
  const jobs = new ExecutionJobs(new SqliteExecutionStore(db, registry), { now: () => now,
    id: () => `job_${String(++sequence).padStart(26, "0")}`, lease: () => `synthetic-lease-${++sequence}` }, {
      plans: (actor) => routines.plans(actor), adopt: (actor, id, time, lease) => routines.adopt(actor, id, time, lease),
    });
  const store = new SqliteRoutineStore(db);
  routines = new ExecutionRoutines(store, jobs, { ...registry, now: () => now, timezone: "UTC", localRuntime: "server",
    id: () => `rtn_${String(++sequence).padStart(26, "0")}`, lease: () => `synthetic-lease-${++sequence}`,
    fingerprint: (value) => createHash("sha256").update(value).digest("hex") });
  return { db, store, jobs, routines, advance: (iso: string) => { now = new Date(iso); },
    command(op: string, args: object, request = `synthetic-command-${++sequence}`) { return routines.command({ request_id: request, operation: { op, args } }, actor); } };
}
test("database Routine needs neither Knowledge nor Task; explicit revisions, validation, idempotence and current plan replacement", () => {
  const f = fixture();
  try {
    const args = { title: "合成定时工作", description: "# 输入", schedule: "* * * * *", assignee: "pi@server" };
    const routine = f.command("execution.routine.create", args, "synthetic-create-0001");
    expect(f.command("execution.routine.create", args, "synthetic-create-0001")).toEqual(routine);
    expect(f.routines.list()[0]!.next).toBe("2026-11-01T00:01:00.000Z");
    const plan = f.routines.plans(actor)[0]!;
    expect(f.routines.plans(actor)[0]).toEqual(plan); expect(f.jobs.list()).toEqual([]);
    expect(f.routines.plans("act_00000000000000000000000002")).toEqual([]);
    expect(() => f.command("execution.routine.update", { routine: routine.id, expected_revision: 2, patch: { description: "冲突" } })).toThrow("修改");
    expect(() => f.command("execution.routine.create", { ...args, timezone: "bad/zone" })).toThrow("时区");
    expect(() => f.command("execution.routine.create", { ...args, schedule: "61 * * * *" })).toThrow("cron");
    f.command("execution.routine.update", { routine: routine.id, expected_revision: 1, patch: { status: "paused" } });
    expect(f.routines.plans(actor)).toEqual([]); expect(f.store.planHistory(routine.id)).toHaveLength(1);
    expect(f.db.query("SELECT name FROM sqlite_master WHERE name IN ('notes','work_tasks')").all()).toEqual([]);
  } finally { f.db.close(); }
});
test("offline results retain their historical input after a plan edit, using the original lease rather than today's template", () => {
  const f = fixture();
  try {
    const routine = f.command("execution.routine.create", { title: "旧输入", description: "第一次内容", schedule: "* * * * *", assignee: "pi@server" });
    const old = f.routines.plans(actor)[0]!;
    f.command("execution.routine.update", { routine: routine.id, expected_revision: 1, patch: { description: "第二次内容" } });
    const current = f.routines.plans(actor)[0]!; expect(current.lease).not.toBe(old.lease);
    const fired = new Date("2026-11-01T00:01:00Z"), id = routineJobId(routine.id, fired);
    f.advance("2026-11-01T00:02:00Z");
    f.jobs.sync(actor, { running: [id], queued: [], outbox: 1 }, new Date("2026-11-01T00:02:00Z"));
    expect(f.jobs.list()).toEqual([]); // A heartbeat has no lease, so ambiguous input must remain unresolved.
    expect(() => f.jobs.result(actor, JobResult.parse({ job: id, lease: "unknown-lease-0123456789", status: "done", finished: "2026-11-01T00:02:00Z" }))).toThrow("匹配");
    const result = JobResult.parse({ job: id, lease: old.lease, status: "done", finished: "2026-11-01T00:02:00Z", report: "合成结果" });
    f.jobs.result(actor, result); f.jobs.result(actor, result);
    const job = f.jobs.get(id); expect(job.spec.run).toEqual(old.template.run); expect(job.spec.run).not.toEqual(current.template.run);
    expect(f.jobs.list()).toHaveLength(1); expect(f.routines.list()[0]!.last?.job).toBe(id);
  } finally { f.db.close(); }
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routineJobId } from "@lumio/execution";
import { RoutineSpec } from "@lumio/schema";
import { Queue } from "../src/queue.ts";
import { RoutinePlans } from "../src/routines.ts";

// P2-5：执行器本地的例行任务计划（注入时钟）。
let temp: string, queue: Queue, plans: RoutinePlans;
const ACTOR = "act_01M5AAAAAAAAAAAAAAAAAAAAA1", R1 = "rtn_01M5AAAAAAAAAAAAAAAAAAAAR1", R2 = "rtn_01M5AAAAAAAAAAAAAAAAAAAAR2";
const at = (hm: string) => new Date(`2026-10-26T${hm}:00Z`);
const spec = (routine: string, schedule = "*/10 * * * *", revision = "r1") => RoutineSpec.parse({ routine, revision, schedule, timezone: "UTC",
  lease: `lease-${routine}-0123456789`, template: { run: { kind: "agent", engine: "pi", prompt: "日报" }, workdir: "/tmp/w", timeout_seconds: 60 } });
beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), "lumio-routines-")); queue = new Queue(temp); plans = new RoutinePlans(queue); });
afterEach(async () => { queue.close(); await rm(temp, { recursive: true, force: true }); });

test("a new plan starts counting from when it arrives; each due fire becomes exactly one acked job", () => {
  plans.replace([spec(R1)], ACTOR, at("10:05"));
  expect(plans.fire(at("10:09"))).toEqual([]);
  const fired = plans.fire(at("10:10"));
  expect(fired).toEqual([routineJobId(R1, at("10:10"))]);
  expect(plans.fire(at("10:10"))).toEqual([]);
  const [job] = queue.jobs();
  expect(job).toMatchObject({ state: "queued", acked: 1 });
  expect(job!.spec).toMatchObject({ runtime: ACTOR, lease: spec(R1).lease, source: { routine: R1, round: 1, fired_at: at("10:10").toISOString() },
    created: at("10:10").toISOString(), workdir: "/tmp/w", timeout_seconds: 60 });
  expect(job!.spec.run).toEqual({ kind: "agent", engine: "pi", prompt: "日报" }); // 每次都是新会话
});

test("after being offline through three fires only the latest runs", () => {
  plans.replace([spec(R1)], ACTOR, at("10:00"));
  expect(plans.fire(at("10:35"))).toEqual([routineJobId(R1, at("10:30"))]);
  expect(queue.jobs()).toHaveLength(1);
  // 重启后再算一遍，同一次不会重复生成。
  const again = new RoutinePlans(queue);
  expect(again.fire(at("10:39"))).toEqual([]);
});

test("replacing plans keeps the last fire time, applies new schedules and removes dropped routines", () => {
  plans.replace([spec(R1), spec(R2)], ACTOR, at("10:00"));
  expect(plans.fire(at("10:10"))).toHaveLength(2);
  plans.replace([spec(R1, "0 * * * *", "r2")], ACTOR, at("10:15"));
  expect(plans.list().map((p) => [p.spec.routine, p.spec.revision, p.last_fired])).toEqual([[R1, "r2", at("10:10").toISOString()]]);
  expect(plans.fire(at("10:50"))).toEqual([]);
  expect(plans.fire(at("11:00"))).toEqual([routineJobId(R1, at("11:00"))]);
  plans.replace([], ACTOR, at("11:01"));
  expect(plans.fire(at("12:00"))).toEqual([]);
});

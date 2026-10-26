import { expect, test } from "bun:test";
import { dueFires, idTime, nextFire, parseCron, routineJobId, validTimeZone } from "../src/index.ts";

const at = (iso: string) => new Date(iso);
const next = (expr: string, tz: string, after: string) => nextFire(parseCron(expr), tz, at(after))?.toISOString();

test("parses fields, ranges, lists and steps; rejects bad expressions and time zones", () => {
  const cron = parseCron("*/15 9-17/4 1,15 * 1-5");
  expect(cron.minutes).toEqual([0, 15, 30, 45]);
  expect(cron.hours).toEqual([9, 13, 17]);
  expect([...cron.days]).toEqual([1, 15]);
  expect(parseCron("0 0 * * 7").weekdays.has(0)).toBe(true);
  for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "5-1 * * * *", "*/0 * * * *", "a * * * *"]) {
    expect(() => parseCron(bad)).toThrow();
  }
  expect(validTimeZone("Asia/Singapore")).toBe(true);
  expect(validTimeZone("Mars/Base")).toBe(false);
});

test("next fire is strictly after, in the routine's time zone", () => {
  expect(next("0 9 * * *", "Asia/Singapore", "2026-10-26T00:59:00Z")).toBe("2026-10-26T01:00:00.000Z");
  expect(next("0 9 * * *", "Asia/Singapore", "2026-10-26T01:00:00Z")).toBe("2026-10-27T01:00:00.000Z");
  expect(next("*/10 * * * *", "UTC", "2026-10-26T10:05:30Z")).toBe("2026-10-26T10:10:00.000Z");
  expect(next("0 9 * * 1", "UTC", "2026-10-26T10:00:00Z")).toBe("2026-11-02T09:00:00.000Z"); // 周一
  expect(next("0 0 1 * 1", "UTC", "2026-10-26T10:00:00Z")).toBe("2026-11-01T00:00:00.000Z"); // 日或周满足其一
  expect(next("0 0 30 2 *", "UTC", "2026-01-01T00:00:00Z")).toBeUndefined();
});

test("daylight saving: skipped local times do not fire; repeated local times fire once", () => {
  // 2026-03-08 美东 02:00 → 03:00
  expect(next("30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z")).toBe("2026-03-09T06:30:00.000Z");
  // 2026-11-01 美东 02:00 → 01:00：01:30 只触发一次
  const first = next("30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z")!;
  expect(first).toBe("2026-11-01T05:30:00.000Z");
  expect(next("30 1 * * *", "America/New_York", first)).toBe("2026-11-02T06:30:00.000Z");
});

test("due fires count missed runs and keep only the latest", () => {
  const cron = parseCron("*/10 * * * *");
  expect(dueFires(cron, "UTC", at("2026-10-26T10:00:00Z"), at("2026-10-26T10:35:00Z"))).toEqual({ latest: at("2026-10-26T10:30:00Z"), count: 3 });
  expect(dueFires(cron, "UTC", at("2026-10-26T10:00:00Z"), at("2026-10-26T10:05:00Z"))).toEqual({ count: 0 });
  const many = dueFires(parseCron("* * * * *"), "UTC", at("2026-01-01T00:00:00Z"), at("2026-10-26T10:35:00Z"), 1000);
  expect(many).toEqual({ latest: at("2026-10-26T10:35:00Z"), count: 1000 });
});

test("routine job IDs are deterministic, carry the fire time and differ per routine", () => {
  const fired = at("2026-10-26T01:00:00Z");
  const id = routineJobId("rtn_01M5AAAAAAAAAAAAAAAAAAAAR1", fired);
  expect(id).toMatch(/^job_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(routineJobId("rtn_01M5AAAAAAAAAAAAAAAAAAAAR1", fired)).toBe(id);
  expect(routineJobId("rtn_01M5AAAAAAAAAAAAAAAAAAAAR2", fired)).not.toBe(id);
  expect(idTime(id)).toBe(fired.getTime());
});

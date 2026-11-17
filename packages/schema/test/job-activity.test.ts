import { expect, test } from "bun:test";
import { JobAction, JobActivityPage, JobActivitySync, JobHumanRequest } from "../src/index.ts";

const at = "2026-11-17T00:00:00.000Z";
const job = "job_00000000000000000000000001";
const target = { instance: "process-id", session: "session-id", turn: "turn-id" };

test("Job activity messages reject raw output, extra fields and oversized batches", () => {
  const event = { sequence: 1, event: { type: "phase" as const, at, phase: "engine" as const } };
  const base = { type: "job" as const, job, lease: "testing-lease-123456789", events: [event], receipts: [] };
  expect(JobActivitySync.parse(base)).toEqual(base);
  expect(JobActivitySync.safeParse({ ...base, events: [{ ...event, event: { ...event.event, stdout: "private" } }] }).success).toBe(false);
  expect(JobActivitySync.safeParse({ ...base, events: Array(65).fill(event) }).success).toBe(false);
  expect(JobActivityPage.parse({ first_available: 1, next_after: 1, gap: false, has_more: false, events: [event] }).events).toEqual([event]);
});

test("human decisions carry request and turn identities and cannot change permissions", () => {
  const prompt = { id: "prompt-id", kind: "approval" as const, target, expires: at, tool: "Bash", preview: "git status", sandbox: "os" as const, can_approve: true };
  expect(JobHumanRequest.parse(prompt)).toEqual(prompt);
  const action = { action: "approve" as const, target, request_id: "ff9d00a9-40de-4226-b1d0-368c5b83613f", prompt_id: prompt.id };
  expect(JobAction.parse(action)).toEqual(action);
  expect(JobAction.safeParse({ ...action, scope: "session" }).success).toBe(false);
  expect(JobAction.safeParse({ ...action, target: { ...target, turn: "" } }).success).toBe(false);
});

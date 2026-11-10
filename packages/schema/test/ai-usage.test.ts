import { expect, test } from "bun:test";
import { AIConnectionInput, AIQuotaSettings, AIQuotaSnapshot, ClaudeQuotaSample, NativeRuntimeMessage } from "../src/index.ts";

test("Claude subscription connections and samples reject provider secrets and raw session fields", () => {
  const connection = { name: "Fixture", kind: "claude-code-subscription", host: "fixture-mac" };
  expect(AIConnectionInput.safeParse(connection).success).toBe(true);
  for (const extra of [{ host: "hub" }, { api_key: "fixture" }, { base_url: "https://example.test" }, { clear_api_key: true }])
    expect(AIConnectionInput.safeParse({ ...connection, ...extra }).success).toBe(false);
  const sample = { connection: "aic_01ARZ3NDEKTSV4RRFFQ69G5FAV", generation: crypto.randomUUID(),
    sampled_at: "2026-11-10T01:00:00Z", windows: [{ id: "five_hour", used_percent: 35 }] };
  expect(ClaudeQuotaSample.safeParse(sample).success).toBe(true);
  expect(ClaudeQuotaSample.safeParse({ ...sample, transcript_path: "/synthetic" }).success).toBe(false);
  expect(ClaudeQuotaSample.safeParse({ ...sample, windows: [{ ...sample.windows[0], label: "synthetic" }] }).success).toBe(false);
  expect(ClaudeQuotaSample.safeParse({ ...sample, windows: [...sample.windows, ...sample.windows] }).success).toBe(false);
});

test("quota contracts preserve decimal amounts, validate ranges, and allow old native greetings", () => {
  const amount = { currency: "USD" as const, total: "9007199254740993.01", topped_up: "9007199254740993.01", granted: "0" };
  const balance = { source: "deepseek" as const, sampled_at: "2026-11-10T01:00:00+08:00", available: true, balances: [amount] };
  expect(AIQuotaSnapshot.parse(balance)).toEqual(balance);
  expect(AIQuotaSnapshot.safeParse({ ...balance, balances: [amount, amount] }).success).toBe(false);
  expect(AIQuotaSettings.safeParse({ monitor: true, thresholds: { CNY: "-1" } }).success).toBe(false);
  expect(AIQuotaSettings.safeParse({ monitor: true, thresholds: { remaining_percent: 100.1 } }).success).toBe(false);
  expect(NativeRuntimeMessage.safeParse({ type: "hello", protocol: 1, instance: "old", version: "1", isolation: "macos-seatbelt" }).success).toBe(true);
});

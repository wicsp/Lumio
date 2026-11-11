import { expect, test } from "bun:test";
import { AIConnectionInput, AIQuotaSettings, AIQuotaSnapshot, AIQuotaView, AliyunBillingUpdate, ClaudeQuotaSample, NativeRuntimeCommand, NativeRuntimeMessage, supportsAliyunBilling } from "../src/index.ts";

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

test("Claude background commands accept only the account fingerprint and normalized results", () => {
  const binding = { connection: "aic_01ARZ3NDEKTSV4RRFFQ69G5FAV", generation: crypto.randomUUID() };
  const command = { type: "claude_usage", command: crypto.randomUUID(), ...binding, account: "a".repeat(64) };
  expect(NativeRuntimeCommand.safeParse(command).success).toBe(true);
  expect(NativeRuntimeCommand.safeParse({ ...command, account: "fixture@example.test" }).success).toBe(false);
  const { account, ...envelope } = command;
  const result = { status: "ready", account, windows: [{ id: "five_hour", used_percent: 34 }] };
  expect(NativeRuntimeMessage.safeParse({ ...envelope, result }).success).toBe(true);
  expect(NativeRuntimeMessage.safeParse({ ...envelope, result: { ...result, raw: "synthetic" } }).success).toBe(false);
});

test("Alibaba Cloud billing accepts write-only configuration and decimal snapshots", () => {
  const binding = { site: "china", access_key_id: "fixture-id", access_key_secret: "fixture-secret" } as const;
  expect(AliyunBillingUpdate.parse(binding)).toEqual(binding);
  expect(AliyunBillingUpdate.parse({ clear: true })).toEqual({ clear: true });
  for (const invalid of [{ ...binding, clear: true }, { ...binding, site: "beijing" }, { ...binding, access_key_secret: " " }])
    expect(AliyunBillingUpdate.safeParse(invalid).success).toBe(false);
  const snapshot = {
    source: "aliyun-billing", sampled_at: "2026-11-10T01:00:00Z", currency: "JPY", cash_balance: "9007199254740993.01", available_amount: "-23.40",
  } as const;
  expect(AIQuotaSnapshot.parse(snapshot)).toEqual(snapshot);
  expect(AIQuotaSnapshot.safeParse({ ...snapshot, available_amount: -23.4 }).success).toBe(false);
  const view = { connection: "aic_01ARZ3NDEKTSV4RRFFQ69G5FAV", status: "ready", attention: false, settings: { monitor: false, thresholds: {} }, snapshot };
  expect(AIQuotaView.parse({ ...view, aliyun_billing_configured: true })).toMatchObject(view);
  expect(AIQuotaView.safeParse({ ...view, ...binding }).success).toBe(false);
});

test("Alibaba Cloud billing is restricted to official Hub connections", () => {
  const compatible = (base_url: string) => supportsAliyunBilling({ kind: "openai-compatible", host: "hub", base_url });
  expect(compatible("https://dashscope.aliyuncs.com/compatible-mode/v1/")).toBe(true);
  expect(compatible("https://llm-fixture.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1")).toBe(true);
  expect(supportsAliyunBilling({ kind: "dashscope", host: "hub", base_url: "https://dashscope.aliyuncs.com" })).toBe(true);
  for (const base of ["http://dashscope.aliyuncs.com", "https://dashscope.aliyuncs.com:3000", "https://dashscope.aliyuncs.com.example.test",
    "https://dashscope.aliyuncs.com@fixture.example.test"]) expect(compatible(`${base}/compatible-mode/v1`)).toBe(false);
  expect(compatible("https://dashscope.aliyuncs.com/v1")).toBe(false);
});

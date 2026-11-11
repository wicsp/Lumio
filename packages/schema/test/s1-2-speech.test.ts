import { test, expect } from "bun:test";
import { z } from "zod";
import {
  AIConnectionInput, AIProfile, CONTRACTS, SpeechTerm, DASHSCOPE_BASE_URLS, SPEECH_LIMITS, SPEECH_PROTOCOL,
  SpeechBinding, SpeechBindingUpdate, SpeechClientMessage, SpeechServerMessage, SpeechVocabulary, SpeechVocabularyUpdate,
} from "../src/index.ts";

const ulid = "0".repeat(26);
const profile = `aip_${ulid}`;
const connection = `aic_${ulid}`;
const owner = `act_${ulid}`;
const start = { type: "start", protocol: SPEECH_PROTOCOL, token: "synthetic-token-0000", request_id: "speech-request-0001", format: "pcm16le-16k-mono" };

test("start carries auth in the first message and defaults to using the vocabulary", () => {
  const parsed = SpeechClientMessage.parse(start);
  expect(parsed.type === "start" && parsed.vocabulary).toBe(true);
  expect(SpeechClientMessage.safeParse({ ...start, profile }).success).toBe(true);
  expect(SpeechClientMessage.safeParse({ ...start, token: undefined }).success).toBe(false);
  expect(SpeechClientMessage.safeParse({ ...start, protocol: 2 }).success).toBe(false);
  expect(SpeechClientMessage.safeParse({ ...start, format: "opus" }).success).toBe(false);
  expect(SpeechClientMessage.safeParse({ ...start, sample_rate: 48000 }).success).toBe(false);
  expect(SpeechClientMessage.safeParse({ type: "end" }).success).toBe(true);
  expect(SpeechClientMessage.safeParse({ type: "cancel" }).success).toBe(true);
  expect(SpeechClientMessage.safeParse({ type: "audio", data: "AAAA" }).success).toBe(false);
});

test("server messages: partial replaces, final may be truncated, errors use ApiError", () => {
  expect(SpeechServerMessage.safeParse({ type: "ready", protocol: SPEECH_PROTOCOL, profile, model: "fun-asr-realtime", vocabulary: true }).success).toBe(true);
  expect(SpeechServerMessage.safeParse({ type: "partial", seq: 0, text: "把任务交给" }).success).toBe(true);
  expect(SpeechServerMessage.safeParse({ type: "partial", seq: -1, text: "x" }).success).toBe(false);
  expect(SpeechServerMessage.safeParse({ type: "final", text: "x", duration_ms: 1200, truncated: false }).success).toBe(true);
  expect(SpeechServerMessage.safeParse({ type: "final", text: "x".repeat(SPEECH_LIMITS.max_text_chars + 1), duration_ms: 1, truncated: false }).success).toBe(false);
  expect(SpeechServerMessage.safeParse({ type: "error", error: { code: "FORBIDDEN", message: "Only people can use speech input", reason: "speech-human-only" } }).success).toBe(true);
  expect(SpeechServerMessage.safeParse({ type: "error", error: { code: "TEAPOT", message: "x" } }).success).toBe(false);
});

test("limits match ADR 0055", () => {
  expect(SPEECH_LIMITS).toMatchObject({ sample_rate: 16000, max_utterance_seconds: 120, max_frame_bytes: 8192, max_sessions_per_actor: 2, start_timeout_ms: 5000, idle_timeout_ms: 10000 });
  expect(SPEECH_LIMITS.max_frame_bytes % 2).toBe(0);
});

test("vocabulary rejects duplicates, control characters and oversize lists", () => {
  const update = { request_id: "speech-vocab-0001", expected_revision: 1, terms: ["Lumio", "Tailscale"], include_project_names: true };
  expect(SpeechVocabularyUpdate.safeParse(update).success).toBe(true);
  expect(SpeechVocabularyUpdate.safeParse({ ...update, terms: ["Lumio", "lumio"] }).success).toBe(false);
  expect(SpeechVocabularyUpdate.safeParse({ ...update, terms: ["a\nb"] }).success).toBe(false);
  expect(SpeechVocabularyUpdate.safeParse({ ...update, terms: Array.from({ length: 201 }, (_, i) => `t${i}`) }).success).toBe(false);
  expect(SpeechVocabularyUpdate.safeParse({ ...update, terms: ["x".repeat(41)] }).success).toBe(false);
  const now = "2026-11-11T12:00:00+08:00";
  expect(SpeechVocabulary.safeParse({ owner, terms: [], include_project_names: false, revision: 1, updated: now,
    sync: [{ connection, state: "synced", revision: 1, updated: now }] }).success).toBe(true);
});

test("speech bindings are separate from agent usage bindings", () => {
  expect(SpeechBinding.safeParse({ purpose: "speech.asr", profile, revision: 1 }).success).toBe(true);
  expect(SpeechBinding.safeParse({ purpose: "assistant", profile, revision: 1 }).success).toBe(false);
  expect(SpeechBinding.safeParse({ purpose: "speech.asr", profile, revision: 1, sandbox: "workspace-write" }).success).toBe(false);
  expect(SpeechBindingUpdate.safeParse({ request_id: "speech-bind-00001", purpose: "speech.asr", profile: null }).success).toBe(true);
});

test("DashScope connections only accept official region addresses on the Hub", () => {
  const base = { name: "阿里云语音", kind: "dashscope", host: "hub", api_key: "synthetic" };
  expect(AIConnectionInput.safeParse({ ...base, base_url: DASHSCOPE_BASE_URLS.beijing }).success).toBe(true);
  expect(AIConnectionInput.safeParse({ ...base, base_url: DASHSCOPE_BASE_URLS.singapore }).success).toBe(true);
  expect(AIConnectionInput.safeParse({ ...base, base_url: "https://evil.example.test" }).success).toBe(false);
  expect(AIConnectionInput.safeParse({ ...base, base_url: DASHSCOPE_BASE_URLS.beijing, host: "macsp" }).success).toBe(false);
  expect(AIProfile.shape.engine.safeParse("speech").success).toBe(true);
});

test("speech contracts are exported as JSON Schema", () => {
  for (const name of ["speech-client-message", "speech-server-message", "speech-vocabulary", "speech-vocabulary-update", "speech-binding", "speech-binding-update"] as const) {
    expect(() => z.toJSONSchema(CONTRACTS[name], { target: "draft-2020-12", io: "input" })).not.toThrow();
  }
});

test("term length follows the Fun-ASR vocabulary rules", () => {
  expect(SpeechTerm.safeParse("青岚计划").success).toBe(true);
  expect(SpeechTerm.safeParse("中".repeat(15)).success).toBe(true);
  expect(SpeechTerm.safeParse("中".repeat(16)).success).toBe(false);
  expect(SpeechTerm.safeParse("Lumio 青岚计划 with a very long English tail").success).toBe(false);
  expect(SpeechTerm.safeParse("one two three four five six seven").success).toBe(true);
  expect(SpeechTerm.safeParse("one two three four five six seven eight").success).toBe(false);
  expect(SpeechTerm.safeParse("vaswani2017attention").success).toBe(true);
  expect(SpeechTerm.safeParse("x".repeat(41)).success).toBe(false);
});

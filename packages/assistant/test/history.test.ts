import { expect, test } from "bun:test";
import { AssistantMessage, AssistantToolCall, AssistantModelRequest } from "@lumio/schema";
import { boundedHistory, type HistoryEntry } from "../src/history.ts";

const limit = 20 * 1024;
const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(26, "0")}`;
const created = "2026-11-12T00:00:00Z";

function entry(index: number, content = "Synthetic reply"): HistoryEntry {
  const records = ["user", "assistant"].map((role, offset) => AssistantMessage.parse({
    id: id("amsg", index * 2 + offset), conversation: id("conv", 1), turn: id("turn", index),
    role, content: role === "user" ? `Question ${index}` : content, created,
  }));
  return { index, records, status: "done", calls: [], messages: records.map(({ role, content }) => ({ role, content })) };
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

test("reserve every recent turn before spending the budget on complete older anchor matches", () => {
  const entries = Array.from({ length: 7 }, (_, index) => entry(index, `Answer ${index}: ${"x".repeat(8000)}`)).reverse();
  const result = boundedHistory(entries, limit);
  expect(result.included).toBe(7);
  expect(bytes({ messages: result.messages, compact_turns: result.compact_turns })).toBeLessThanOrEqual(limit);
  const transcript = JSON.stringify(result);
  for (let index = 0; index < 7; index++) expect(transcript).toContain(`Question ${index}`);
  expect(result.messages[0]?.content).toBe("Question 5");
  expect(result.compact_turns.map(turn => turn.user.text)).toEqual([0, 1, 2, 3, 4].map(index => `Question ${index}`));
  AssistantModelRequest.parse({ messages: result.messages, tools: [] });
});

test("huge multilingual results, escaped text and provider state do not erase the three latest turns", () => {
  const entries = [2, 1, 0].map(index => entry(index, "🧪研究\n\"\\".repeat(8000)));
  for (const value of entries) value.messages.at(-1)!.continuation = { encrypted_content: "opaque".repeat(10000) };
  const result = boundedHistory(entries, limit);
  expect(result.included).toBe(3);
  expect(result.compact_turns).toHaveLength(3);
  expect(result.messages).toEqual([]);
  expect(result.compact_turns.every(turn => turn.assistant_reply?.truncated)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("opaque");
  expect(bytes(result)).toBeLessThanOrEqual(limit);
});

test("failed and uncertain effects remain factual even if the assistant claimed success", () => {
  const value = entry(1, "Everything completed successfully");
  value.calls = Array.from({ length: 12 }, (_, index) => AssistantToolCall.parse({
    id: id("tool", index), turn: id("turn", 1), name: "fixture_write", args: { id: id("task", 1) },
    status: index === 0 ? "unknown" : index === 1 ? "failed" : "succeeded", created,
    result: { text: "large response ".repeat(500) },
  }));
  const result = boundedHistory([value], limit);
  expect(result.messages).toEqual([]);
  const compact = result.compact_turns[0]!;
  expect(compact.tool_status_counts).toEqual({ unknown: 1, failed: 1, succeeded: 10 });
  expect(compact.tool_outcomes[0]?.status).toBe("failed");
  expect(compact.tool_outcomes[1]?.status).toBe("unknown");
  expect(compact.omitted_tool_outcomes).toBeGreaterThan(0);
  expect(compact.assistant_reply?.text).toBe("Everything completed successfully");
});

test("orphaned tool messages are summarized as data, never sent as an invalid provider exchange", () => {
  const value = entry(1);
  value.messages.push({ role: "tool", tool_call_id: id("tool", 1), content: "Orphan result" });
  const result = boundedHistory([value], limit);
  expect(result.messages).toEqual([]);
  expect(result.compact_turns).toHaveLength(1);
});

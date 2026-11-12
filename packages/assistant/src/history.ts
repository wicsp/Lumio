import type { AssistantMessage, AssistantModelMessage, AssistantToolCall, AssistantTurn } from "@lumio/schema";

export interface HistoryEntry {
  index: number;
  records: readonly AssistantMessage[];
  messages: AssistantModelMessage[];
  status: AssistantTurn["status"];
  calls: readonly AssistantToolCall[];
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Excerpts are data, never provider continuation or reconstructed tool messages. */
function excerpt(text: string, limit: number) {
  const encoder = new TextEncoder();
  let value = text.slice(0, encoder.encodeInto(text, new Uint8Array(limit)).read);
  while (bytes(value) > limit) value = text.slice(0, encoder.encodeInto(text, new Uint8Array(Math.floor(encoder.encode(value).length / 2))).read);
  return { text: value, truncated: value.length !== text.length };
}

function compact(entry: HistoryEntry) {
  const first = entry.records[0]!;
  const final = entry.messages.findLast(message => message.role === "assistant" && message.content.trim() && !message.tool_calls?.length);
  const counts: Record<string, number> = {};
  for (const call of entry.calls) counts[call.status] = (counts[call.status] ?? 0) + 1;
  // Uncertain/failed effects precede successful ones when only a few outcomes fit.
  const ordered = [...entry.calls].reverse().sort((a, b) => Number(a.status === "succeeded") - Number(b.status === "succeeded"));
  const outcomes = ordered.slice(0, 4).map(call => ({
    id: call.id, name: excerpt(call.name, 100).text, status: call.status,
    arguments: excerpt(JSON.stringify(call.args), 200),
    ...(call.result === undefined ? {} : { result: excerpt(JSON.stringify(call.result), 300) }),
    ...(call.error ? { error: excerpt(call.error, 160) } : {}),
  }));
  const data = {
    turn: first.turn, created: first.created, firstMessage: first.id, lastMessage: entry.records.at(-1)!.id,
    status: entry.status, user: excerpt(first.content, 500),
    ...(final ? { assistant_reply: excerpt(final.content, 500) } : {}),
    tool_status_counts: counts, tool_outcomes: outcomes, omitted_tool_outcomes: 0,
  };
  data.omitted_tool_outcomes = entry.calls.length - data.tool_outcomes.length;
  while (bytes(data) > 2400 && data.tool_outcomes.length) {
    data.tool_outcomes.pop(); data.omitted_tool_outcomes++;
  }
  return data;
}

function completePairs(messages: readonly AssistantModelMessage[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) return false;
    } else {
      if (pending.size) return false;
      for (const call of message.tool_calls ?? []) {
        if (pending.has(call.id)) return false;
        pending.add(call.id);
      }
    }
  }
  return pending.size === 0;
}

/** Input is authorized and ordered by priority (recent turns first). Reserve summaries before upgrading whole turns. */
export function boundedHistory(entries: readonly HistoryEntry[], limit: number) {
  const selected = entries.map(entry => ({ entry, summary: compact(entry), full: false }));
  const render = () => {
    const chronological = [...selected].sort((a, b) => a.entry.index - b.entry.index);
    return {
      messages: chronological.flatMap(item => item.full ? item.entry.messages : []),
      compact_turns: chronological.flatMap(item => item.full ? [] : [item.summary]),
    };
  };
  while (bytes(render()) > limit && selected.length) selected.pop();
  for (const item of selected) {
    if (item.entry.status !== "done" || item.entry.calls.some(call => call.status !== "succeeded") || !completePairs(item.entry.messages)) continue;
    item.full = true;
    if (bytes(render()) > limit) item.full = false;
  }
  return { ...render(), included: selected.length };
}

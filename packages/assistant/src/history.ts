import { WorkCommandResult, capabilityFromTool, type AssistantMessage, type AssistantModelMessage, type AssistantToolCall, type AssistantTurn } from "@lumio/schema";

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

/** These are outcomes of a call at the time it finished, not a live status query. */
export function workReceipt(call: AssistantToolCall) {
  const capability = call.capability ?? capabilityFromTool(call.name)?.name;
  if (call.status !== "succeeded" || !capability?.startsWith("work.task.")) return;
  const parsed = WorkCommandResult.safeParse(call.result);
  if (!parsed.success) return;
  const result = parsed.data;
  if (result.kind === "proposal") return { kind: result.kind, id: result.proposal };
  if (result.kind === "task") return { kind: result.kind, id: result.task.id, title: excerpt(result.task.title, 260).text };
  if (result.kind === "job") return { kind: result.kind, id: result.job.spec.id, status: result.job.status };
}

export function compactTurn(entry: HistoryEntry, preceding = false) {
  const first = entry.records[0]!;
  const final = entry.status === "done" ? entry.messages.findLast(message => message.role === "assistant" && message.content.trim() && !message.tool_calls?.length) : undefined;
  const counts: Record<string, number> = {};
  for (const call of entry.calls) counts[call.status] = (counts[call.status] ?? 0) + 1;
  // Preserve failures and write receipts before successful reads when space is limited.
  const ordered = entry.calls.map(call => ({ call, receipt: workReceipt(call) })).reverse();
  const priority = ({ call, receipt }: typeof ordered[number]) => call.status !== "succeeded" ? 0 : receipt ? 1 : 2;
  ordered.sort((a, b) => priority(a) - priority(b));
  const outcomes = ordered.slice(0, 4).map(({ call, receipt }) => ({
    id: call.id, name: excerpt(call.name, 100).text, status: call.status,
    arguments: excerpt(JSON.stringify(call.args), 200),
    ...(receipt ? { receipt } : call.result === undefined ? {} : { result: excerpt(JSON.stringify(call.result), 300) }),
    ...(call.error ? { error: excerpt(call.error, 160) } : {}),
  }));
  const data = {
    turn: first.turn, created: first.created, firstMessage: first.id, lastMessage: entry.records.at(-1)!.id,
    status: entry.status, user: excerpt(first.content, preceding ? 2000 : 500),
    ...(final ? { assistant_reply: excerpt(final.content, preceding ? 6000 : 500) } : {}),
    tool_status_counts: counts, tool_outcomes: outcomes, omitted_tool_outcomes: 0,
  };
  data.omitted_tool_outcomes = entry.calls.length - data.tool_outcomes.length;
  while (bytes(data) > (preceding ? 9600 : 2400) && data.tool_outcomes.length) {
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
export function boundedHistory(entries: readonly HistoryEntry[], limit: number, precedingTurn?: string) {
  const selected = entries.map(entry => ({
    entry, summary: compactTurn(entry, precedingTurn !== undefined && entry.records[0]!.turn === precedingTurn), full: false,
  }));
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

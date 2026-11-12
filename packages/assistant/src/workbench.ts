import {
  MODULE_ID_PREFIXES, ResourceRef, toolName, WorkbenchAction,
  type AssistantConversation, type AssistantMessage, type AssistantModelMessage, type AssistantModelRequest, type FocusSnapshot,
} from "@lumio/schema";
import { boundedHistory, type HistoryEntry } from "./history.ts";

export interface AssistantWorkbenchScope {
  owner: string;
  conversation: string;
  turn: string;
}

interface ResourceSummary {
  ref: ResourceRef;
  summary: string;
}

export interface AssistantAnchorResource {
  title: string;
  summary: string;
  content?: string;
  related?: readonly ResourceSummary[];
}

export interface AssistantWorkbenchContext {
  isMain(conversation: AssistantConversation): boolean;
  instructions?: string;
  /** The adapter must authorize the subject and each related resource as this agent. */
  readResource(ref: ResourceRef, actor: string, signal: AbortSignal, scope: AssistantWorkbenchScope): Promise<AssistantAnchorResource | undefined>;
  pendingNotices?(owner: string, actor: string, signal: AbortSignal, scope: AssistantWorkbenchScope): Promise<readonly ResourceSummary[]>;
  /** Projects an authorized read result for chained recall. Related resources must contain only IDs and summaries. */
  expandReadResult?(tool: string, args: Record<string, unknown>, result: unknown, actor: string, signal: AbortSignal, scope: AssistantWorkbenchScope): Promise<unknown>;
}

export interface AssistantFragmentSource {
  conversation: string;
  firstMessage: string;
  lastMessage: string;
  anchors: readonly ResourceRef[];
}

/** Each source range can reserve at most three provider calls, including failed or interrupted calls. */
export const ASSISTANT_FRAGMENT_MAX_ATTEMPTS = 3;

export interface AssistantFragment extends AssistantFragmentSource {
  attempts: number;
  summary?: string;
}

export interface AssistantWorkbenchStore {
  messageAnchors(conversation: string): ReadonlyMap<string, readonly ResourceRef[]>;
  putMessageAnchors(message: string, anchors: readonly ResourceRef[]): void;
  enqueueFragment(source: AssistantFragmentSource, now: string): void;
  recentFragments(conversation: string, anchors: readonly ResourceRef[]): AssistantFragment[];
  nextFragment(now: string): AssistantFragment | undefined;
  deferFragment(fragment: AssistantFragment, retryAt: string): void;
  startFragment(fragment: AssistantFragment, request: AssistantModelRequest, actor: string, now: string, retryAt: string): boolean;
  finishFragment(fragment: AssistantFragment, summary: string): void;
}

// UTF-8 byte limits keep optional context bounded across providers without assuming a tokenizer.
const budgets = {
  anchorBytes: 12 * 1024,
  anchorContentBytes: 2500,
  relatedBytes: 3500,
  historyBytes: 20 * 1024,
  memoryBytes: 16 * 1024,
  summaryBytes: 6 * 1024,
  noticeBytes: 2 * 1024,
  summaryInputBytes: 32 * 1024,
  summaryOutputBytes: 1500,
  recentTurns: 3,
  anchorTurns: 4,
  anchors: 8,
} as const;

export const workbenchBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

function excerpt(text: string, bytes: number): string {
  const encoder = new TextEncoder();
  const output = new Uint8Array(bytes);
  const { read } = encoder.encodeInto(text, output);
  return text.slice(0, read);
}

function bare(ref: ResourceRef): ResourceRef {
  return { module: ref.module, id: ref.id };
}

function unique(refs: readonly ResourceRef[]): ResourceRef[] {
  return [...new Map(refs.map(ref => [ref.id, bare(ref)])).values()];
}

function referencedIds(message: string): ResourceRef[] {
  const refs: ResourceRef[] = [];
  for (const match of message.matchAll(/(?<![a-zA-Z0-9_])([a-z]+)_[0-9A-HJKMNP-TV-Z]{26}(?![a-zA-Z0-9_])/g)) {
    for (const [module, prefixes] of Object.entries(MODULE_ID_PREFIXES)) {
      if ((prefixes as readonly string[]).includes(match[1]!)) {
        refs.push(ResourceRef.parse({ module, id: match[0] }));
        break;
      }
    }
  }
  return unique(refs);
}

function compactSummary(entry: ResourceSummary): ResourceSummary {
  return { ref: bare(entry.ref), summary: excerpt(entry.summary, 320) };
}

function takeWithin<T>(values: readonly T[], bytes: number): T[] {
  const included: T[] = [];
  let remaining = bytes - 2;
  for (const value of values) {
    const cost = workbenchBytes(value) + 1;
    if (cost > remaining) continue;
    included.push(value);
    remaining -= cost;
  }
  return included;
}

export function workbenchMemories(values: readonly string[]): string[] {
  return takeWithin([...values].reverse(), budgets.memoryBytes).reverse();
}

interface HistoricalTurn extends Pick<HistoryEntry, "status" | "calls"> {
  records: AssistantMessage[];
  anchors: readonly ResourceRef[];
  messages: AssistantModelMessage[];
}

/** Resources actually discussed/read, including old turns whose original page anchor was unrelated. */
function discussedRefs(turn: HistoricalTurn): ResourceRef[] {
  const refs: ResourceRef[] = [];
  for (const call of turn.calls) {
    if (call.status !== "succeeded" || call.private_read) continue;
    if (["knowledge.note.show", "work.task.show", "work.project.show"].some(name => toolName(name) === call.name)) {
      for (const key of ["ref", "task", "project"]) {
        const value = call.args[key];
        if (typeof value === "string") refs.push(...referencedIds(value));
      }
      // Knowledge reads may have been requested by title/path; their returned stable ID is authoritative.
      const result = call.result as { item?: { id?: unknown }; note?: { id?: unknown }; id?: unknown } | undefined;
      const id = result?.item?.id ?? result?.note?.id ?? result?.id;
      if (typeof id === "string") refs.push(...referencedIds(id));
    }
    const shown = navigatedTopic(call.name, call.args);
    if (shown) refs.push(shown);
  }
  for (const message of turn.records) if (message.role !== "tool") refs.push(...referencedIds(message.content));
  return unique([...refs, ...turn.anchors]).slice(0, budgets.anchors);
}

export function navigatedTopic(name: string, args: Record<string, unknown>): ResourceRef | undefined {
  if (name !== toolName("ui.navigate")) return;
  const parsed = WorkbenchAction.safeParse({ ...args, action: "navigate" });
  return parsed.success && parsed.data.action === "navigate" && parsed.data.target ? bare(parsed.data.target) : undefined;
}

export function workbenchTurns(
  records: readonly AssistantMessage[],
  anchors: ReadonlyMap<string, readonly ResourceRef[]>,
  settled: ReadonlySet<string>,
  history: (records: AssistantMessage[]) => AssistantModelMessage[],
  facts?: (turn: string) => Pick<HistoryEntry, "status" | "calls">,
): HistoricalTurn[] {
  const turns = new Map<string, AssistantMessage[]>();
  for (const message of records) {
    if (!message.turn) continue;
    const turn = turns.get(message.turn) ?? [];
    turn.push(message);
    turns.set(message.turn, turn);
  }
  return [...turns.entries()].flatMap(([id, entries]) => {
    const user = entries[0]!;
    if (user.role !== "user" || !settled.has(id)) return [];
    const latest = entries.findLast(entry => anchors.get(entry.id)?.length);
    return [{ records: entries, anchors: anchors.get(latest?.id ?? user.id) ?? [], messages: history(entries), ...(facts?.(id) ?? { status: "done" as const, calls: [] }) }];
  });
}

function sameAnchors(left: readonly ResourceRef[], right: readonly ResourceRef[]): boolean {
  return left.length === right.length && left.every(ref => right.some(other => other.id === ref.id));
}

/** Only a changed primary or selected object set is a topic signal. */
export function sameWorkbenchFocus(left?: FocusSnapshot, right?: FocusSnapshot): boolean {
  return left?.primary?.id === right?.primary?.id &&
    sameAnchors(unique(left?.selected ?? []), unique(right?.selected ?? []));
}

export function fragmentOnSwitch(
  conversation: string,
  history: readonly HistoricalTurn[],
  previous: readonly ResourceRef[],
  anchors: readonly ResourceRef[],
): AssistantFragmentSource | undefined {
  if (!previous.length || !anchors.length || sameAnchors(previous, anchors)) return undefined;
  const previousIndex = history.findLastIndex(turn => turn.anchors.length > 0);
  const segment: HistoricalTurn[] = [];
  let remaining = budgets.summaryInputBytes - 2;
  for (let index = previousIndex; index >= 0; index--) {
    const turn = history[index]!;
    if (turn.status !== "done" || !sameAnchors(previous, turn.anchors)) break;
    const cost = workbenchBytes(summaryMessages(turn.messages)) + 1;
    if (cost > remaining) break;
    segment.unshift(turn);
    remaining -= cost;
  }
  if (!segment.length) return undefined;
  return {
    conversation,
    firstMessage: segment[0]!.records[0]!.id,
    lastMessage: segment.at(-1)!.records.at(-1)!.id,
    anchors: previous,
  };
}

function summaryMessages(messages: readonly AssistantModelMessage[]) {
  const transcript = messages.map(({ role, content, tool_calls, tool_call_id }) => ({
    role,
    content: excerpt(content, role === "tool" ? 700 : 2500),
    tool_calls: tool_calls?.map(({ id, name }) => ({ id, name })),
    tool_call_id,
  }));
  if (workbenchBytes(transcript) <= budgets.summaryInputBytes / 2) return transcript;
  // Oversized turns still get a fragment. Preserve their user's question and final assistant response.
  return [transcript[0]!, transcript.at(-1)!];
}

export function fragmentMessages(fragment: AssistantFragmentSource, history: readonly HistoricalTurn[]): ReturnType<typeof summaryMessages> {
  const start = history.findIndex(turn => turn.records[0]!.id === fragment.firstMessage);
  const end = history.findIndex(turn => turn.records.at(-1)!.id === fragment.lastMessage);
  if (start < 0 || end < start) return [];
  const segment = history.slice(start, end + 1);
  if (segment.some(turn => turn.status !== "done" || !sameAnchors(turn.anchors, fragment.anchors))) return [];
  const messages = segment.flatMap(turn => summaryMessages(turn.messages));
  return workbenchBytes(messages) <= budgets.summaryInputBytes ? messages : [];
}

export const fragmentSummary = (value: string): string => excerpt(value.trim(), budgets.summaryOutputBytes);

interface Resolution {
  anchors: ResourceRef[];
  focus?: FocusSnapshot;
  clarify: boolean;
}

const pointsToObject = /\b(?:this|that|these|those|it)\b|这个|那个|这些|那些|它|该任务|该笔记/iu;
const requestsMultiple = /\b(?:compare|both|these|those|all)\b|对比|比较|这[些俩两]|那[些俩两]|这几个|那几个/u;
const changesTopic = /\b(?:switch topics?|another topic|change (?:the )?subject)\b|换[个一]?(?:话题|主题)|接下来聊|转而聊/iu;

function mentionsTitle(message: string, rawTitle: string): boolean {
  const title = rawTitle.trim().toLowerCase();
  if (title.length < 2) return false;
  if (/[^\x00-\x7F]/u.test(title)) return message.includes(title);
  const words = new Set(message.split(/[^a-z0-9]+/u));
  return /^[a-z0-9]+$/u.test(title) ? words.has(title) : message.includes(title);
}

export class WorkbenchResources {
  private readonly reads = new Map<string, Promise<AssistantAnchorResource | undefined>>();

  constructor(
    private readonly adapter: AssistantWorkbenchContext,
    private readonly actor: string,
    private readonly signal: AbortSignal,
    private readonly scope: AssistantWorkbenchScope,
  ) {}

  read(ref: ResourceRef): Promise<AssistantAnchorResource | undefined> {
    const existing = this.reads.get(ref.id);
    if (existing) return existing;
    const result = (async () => {
      this.signal.throwIfAborted();
      try {
        return await this.adapter.readResource(bare(ref), this.actor, this.signal, this.scope);
      } catch {
        this.signal.throwIfAborted();
        return undefined;
      }
    })();
    this.reads.set(ref.id, result);
    return result;
  }

  async visible(refs: readonly ResourceRef[]): Promise<boolean> {
    const resources = await Promise.all(refs.map(ref => this.read(ref)));
    return resources.every(value => value !== undefined);
  }

  /** Bounded recall index, not a second conversation or a source of action authority. */
  async topics(history: readonly HistoricalTurn[], query: string) {
    const groups = new Map<string, { ref: ResourceRef; turn: HistoricalTurn }>();
    for (const turn of [...history].reverse()) {
      for (const ref of discussedRefs(turn)) if (!groups.has(ref.id)) groups.set(ref.id, { ref, turn });
    }
    // Exact text overlap only ranks candidates; the model selects the intended topic using the existing tools.
    const normalized = query.toLowerCase();
    const boilerplate = /^(?:继续|刚才|刚刚|上次|那个|这个|话题|讨论|看看|我们|一下|关于)$/u;
    const terms = [...new Set([...normalized.slice(0, 2000).matchAll(/[a-z0-9]{3,}|[\p{Script=Han}]+/gu)].flatMap(([word]) => {
      if (/^[a-z0-9]/u.test(word)) return [word];
      const characters = Array.from(word);
      return characters.slice(1).map((character, index) => characters[index]! + character);
    }))].filter(term => !boilerplate.test(term)).slice(0, 32);
    const score = (turn: HistoricalTurn) => terms.reduce((total, term) => total + Number(turn.records.some(message => message.role === "user" && message.content.toLowerCase().includes(term))), 0);
    const candidates = [...groups.values()].sort((a, b) => score(b.turn) - score(a.turn)).slice(0, 16);
    const topics = [];
    for (const { ref, turn } of candidates) {
      if (!(await this.visible(discussedRefs(turn)))) continue;
      const resource = await this.read(ref);
      if (!resource) continue;
      const reply = turn.records.findLast(message => message.role === "assistant" && message.content.trim());
      topics.push({ ref, title: excerpt(resource.title, 200), last_discussed_at: turn.records[0]!.created,
        first_message: turn.records[0]!.id, last_message: turn.records.at(-1)!.id,
        question: excerpt(turn.records[0]!.content, 500), reply: reply && excerpt(reply.content, 700) });
    }
    return takeWithin(topics, 12 * 1024);
  }

  async observation(focus: FocusSnapshot | undefined, capturedAt: string, previous: FocusSnapshot | undefined, previousAt?: string) {
    const prior = previous && (await this.resolve("", [], previous, true)).focus;
    return { captured_at: capturedAt, source: "client_message_snapshot", live: false,
      change: !previousAt ? "first_observation" : sameWorkbenchFocus(prior, focus) && prior?.section === focus?.section ? "unchanged" : "changed",
      previous: previousAt ? { captured_at: previousAt, focus: prior } : undefined };
  }

  async resolve(message: string, previous: readonly ResourceRef[], focus: FocusSnapshot | undefined, focusChanged: boolean): Promise<Resolution> {
    const explicit = referencedIds(message);
    const candidates = unique([...(focus?.selected ?? []), ...(focus?.primary ? [focus.primary] : []), ...previous, ...explicit.slice(0, budgets.anchors)]);
    const visible = new Map<string, AssistantAnchorResource>();
    for (const ref of candidates) {
      const resource = await this.read(ref);
      if (resource) visible.set(ref.id, resource);
    }
    const available = (refs: readonly ResourceRef[]) => unique(refs).filter(ref => visible.has(ref.id));
    const primary = focus?.primary && available([focus.primary])[0];
    const selected = available(focus?.selected ?? []);
    const selectedVisible = selected.length === unique(focus?.selected ?? []).length;
    const safeFocus: FocusSnapshot | undefined = focus && {
      section: focus.section,
      primary,
      selected,
      selection_text: primary && selectedVisible ? focus.selection_text : undefined,
    };

    if (explicit.length) {
      const anchors = available(explicit);
      const ambiguous = anchors.length !== explicit.length || anchors.length > budgets.anchors;
      return { anchors: ambiguous ? [] : anchors, focus: safeFocus, clarify: ambiguous };
    }
    const titled = candidates.filter(ref => {
      const resource = visible.get(ref.id);
      return resource && mentionsTitle(message.toLowerCase(), resource.title);
    });
    if (titled.length === 1 || (titled.length > 1 && requestsMultiple.test(message) && titled.length <= budgets.anchors)) {
      return { anchors: titled, focus: safeFocus, clarify: false };
    }
    if (titled.length) return { anchors: [], focus: safeFocus, clarify: true };
    const preferFocus = focusChanged || !previous.length;
    if (preferFocus && focus?.selected.length) {
      const ambiguous = !selectedVisible || selected.length > budgets.anchors || (selected.length > 1 && !requestsMultiple.test(message));
      return { anchors: ambiguous ? [] : selected, focus: safeFocus, clarify: ambiguous };
    }
    if (preferFocus && focus?.primary) return { anchors: primary ? [primary] : [], focus: safeFocus, clarify: !primary };
    if (changesTopic.test(message)) return { anchors: [], focus: safeFocus, clarify: true };

    const anchors = available(previous);
    const clarify = anchors.length !== previous.length || (pointsToObject.test(message) &&
      (!anchors.length || (anchors.length > 1 && !requestsMultiple.test(message))));
    return { anchors: clarify ? [] : anchors, focus: safeFocus, clarify };
  }

  async context(resolution: Resolution, history: readonly HistoricalTurn[], fragments: readonly AssistantFragment[]) {
    const anchors = [];
    const related = [];
    const contentLimit = Math.min(budgets.anchorContentBytes, Math.floor(budgets.anchorBytes / Math.max(1, resolution.anchors.length)) - 900);
    for (const ref of resolution.anchors) {
      const resource = await this.read(ref);
      if (!resource) continue;
      const { title, summary, content } = resource;
      anchors.push({
        ref, title: excerpt(title, 200), summary: excerpt(summary, 500),
        ...(content === undefined ? {} : workbenchBytes(content) <= contentLimit
          ? { content } : { read_by_id: true }),
      });
      for (const neighbor of resource.related ?? []) related.push(compactSummary(neighbor));
    }

    const positions = new Map<string, number>();
    history.forEach((turn, index) => {
      positions.set(turn.records[0]!.id, index);
      positions.set(turn.records.at(-1)!.id, index);
    });
    const active = new Set(anchors.map(value => value.ref.id));
    const matches = (refs: readonly ResourceRef[]) => refs.some(ref => active.has(ref.id));
    const summarized: { start: number; end: number; firstMessage: string; lastMessage: string; summary: string }[] = [];
    for (const fragment of fragments) {
      if (!fragment.summary || !matches(fragment.anchors) || !(await this.visible(fragment.anchors))) continue;
      const start = positions.get(fragment.firstMessage);
      const end = positions.get(fragment.lastMessage);
      if (start === undefined || end === undefined) continue;
      summarized.push({ start, end, firstMessage: fragment.firstMessage, lastMessage: fragment.lastMessage, summary: fragment.summary });
    }
    const summaries = takeWithin(summarized, budgets.summaryBytes);
    const byRecency = history.map((turn, index) => ({ turn, index })).reverse();
    const recent = byRecency.slice(0, budgets.recentTurns);
    const matching = byRecency.filter(({ turn, index }) => matches(discussedRefs(turn)) &&
      !summaries.some(summary => summary.start <= index && index <= summary.end)).slice(0, budgets.anchorTurns);
    const eligible = [];
    for (const { turn, index } of new Map([...recent, ...matching].map(item => [item.index, item])).values()) {
      if (await this.visible(discussedRefs(turn))) eligible.push({ ...turn, index });
    }
    const included = boundedHistory(eligible, budgets.historyBytes);
    const notices = await this.adapter.pendingNotices?.(this.scope.owner, this.actor, this.signal, this.scope) ?? [];
    const visibleNotices = [];
    for (const notice of notices.slice(0, 20)) if (await this.read(notice.ref)) visibleNotices.push(compactSummary(notice));
    return {
      messages: included.messages,
      data: {
        compact_turns: included.compact_turns,
        history: { complete: included.included === history.length && !included.compact_turns.length,
          included_turns: included.included, compacted_turns: included.compact_turns.length, omitted_turns: history.length - included.included },
        focus: resolution.focus,
        anchors: takeWithin(anchors, budgets.anchorBytes),
        related: takeWithin([...new Map(related.map(value => [value.ref.id, value])).values()], budgets.relatedBytes),
        summaries: summaries.map(({ firstMessage, lastMessage, summary }) => ({ firstMessage, lastMessage, summary })),
        notices: takeWithin(visibleNotices, budgets.noticeBytes),
      },
    };
  }
}

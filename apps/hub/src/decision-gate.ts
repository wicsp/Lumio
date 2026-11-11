import {
  DECISION_GATE_DEFAULTS, DECISION_GATE_DISCLOSURE, NoticeSourceKind, type NoticeGrader, type NoticeLevel,
} from "@lumio/schema";
import type { DecisionGateConfiguration } from "./decision-gate-config.ts";
import { askJev, isCount, isRecord, NOTICE_QUESTION, PROGRESS_QUESTION, type JevFetch, type JevRequest } from "./jev.ts";
import { containsSecret } from "./tasks.ts";

const NOTICE_STATES = [
  "delivered", "waiting_for_human", "failed", "pending", "ready", "report", "found", "nothing", "stopped", "cancelled",
] as const;
const PROGRESS_ERRORS = ["authorization", "timeout", "command", "model", "network", "validation", "other"] as const;

type Provenance = { source: "hub" | "external"; visibility: "public" | "private" };
type NoticeSummary = {
  status: typeof NOTICE_STATES[number];
  count?: number;
  dependent_tasks?: number;
  days_until_due?: number;
};
type ProgressSummary = {
  tool_calls: number;
  files_changed: number;
  error_kind?: typeof PROGRESS_ERRORS[number];
};

export type NoticeDecisionInput = Provenance & {
  event_kind: NoticeSourceKind;
  subject_title?: string;
  structured_summary: NoticeSummary;
};

/** The caller selects consecutive observations of the same round before constructing the input. */
export type ProgressDecisionInput = Provenance & {
  structured_summary: { previous: ProgressSummary; current: ProgressSummary };
};

type Fallback = Extract<NoticeGrader, { by: "fallback" }>;
type NoticeDecision = { level: NoticeLevel; graded: Exclude<NoticeGrader, { by: "rule" }> };
type ProgressDecision =
  | Fallback
  | { by: "gate"; model: string; made_progress: boolean; confidence: number };

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key));

function validNoticeSummary(value: unknown): value is NoticeSummary {
  return isRecord(value) && onlyKeys(value, ["status", "count", "dependent_tasks", "days_until_due"]) &&
    NOTICE_STATES.some(status => status === value.status) && (value.count === undefined || isCount(value.count)) &&
    (value.dependent_tasks === undefined || isCount(value.dependent_tasks)) &&
    (value.days_until_due === undefined || Number.isSafeInteger(value.days_until_due));
}

function validProgressSummary(value: unknown): value is ProgressSummary {
  return isRecord(value) && onlyKeys(value, ["tool_calls", "files_changed", "error_kind"]) &&
    isCount(value.tool_calls) && isCount(value.files_changed) &&
    (value.error_kind === undefined || PROGRESS_ERRORS.some(kind => kind === value.error_kind));
}

/** Provenance covers the subject title too. Callers derive it from the source and visibility of the Hub record. */
export function buildDecisionGateRequest(kind: "notice" | "progress", value: unknown): JevRequest | undefined {
  if (!isRecord(value) || value.source !== "hub" || value.visibility !== "public") return undefined;
  const summary = value.structured_summary;
  if (kind === "progress") {
    if (!onlyKeys(value, ["source", "visibility", "structured_summary"]) || !isRecord(summary) ||
        !onlyKeys(summary, ["previous", "current"]) || !validProgressSummary(summary.previous) ||
        !validProgressSummary(summary.current)) return undefined;
    const snapshot = ({ tool_calls, files_changed, error_kind }: ProgressSummary) => ({ tool_calls, files_changed, error_kind });
    return {
      state: {
        event_kind: "watchdog",
        structured_summary: { previous: snapshot(summary.previous), current: snapshot(summary.current) },
      },
      questions: PROGRESS_QUESTION,
    };
  }

  if (!onlyKeys(value, [...DECISION_GATE_DISCLOSURE, "source", "visibility"]) || !validNoticeSummary(summary)) return undefined;
  const event = NoticeSourceKind.safeParse(value.event_kind);
  const title = value.subject_title;
  if (!event.success || (title !== undefined &&
      (typeof title !== "string" || !title.trim() || title.length > 240 || /[\r\n\0]/.test(title) || containsSecret(title)))) {
    return undefined;
  }
  return {
    state: {
      event_kind: event.data,
      ...(title === undefined ? {} : { subject_title: title }),
      structured_summary: { status: summary.status, count: summary.count,
        dependent_tasks: summary.dependent_tasks, days_until_due: summary.days_until_due },
    },
    questions: NOTICE_QUESTION,
  };
}

export class DecisionGate {
  constructor(
    private readonly configuration: DecisionGateConfiguration,
    private readonly options: {
      signal: AbortSignal;
      timeoutMs?: number;
      minConfidence?: number;
      fetch?: JevFetch;
      meter: (record: { owner: string; connection: string; model: string; input_tokens: number; output_tokens: number }) => void;
    },
  ) {}

  private async ask(owner: string, kind: "notice" | "progress", input: NoticeDecisionInput | ProgressDecisionInput) {
    try {
      const request = buildDecisionGateRequest(kind, input);
      if (!request) return { by: "fallback", reason: "error" } satisfies Fallback;
      const resolved = this.configuration.resolve(owner);
      if (!resolved) return { by: "fallback", reason: "unconfigured" } satisfies Fallback;

      const { binding, credential } = resolved;
      const response = await askJev(request, binding.model, credential,
        this.options.timeoutMs ?? DECISION_GATE_DEFAULTS.timeout_ms, this.options.signal, this.options.fetch);
      if (response.status !== "response") return { by: "fallback", reason: response.status } satisfies Fallback;

      this.options.meter({
        owner, connection: binding.connection, model: response.model,
        input_tokens: response.input_tokens, output_tokens: response.output_tokens,
      });
      const current = this.configuration.resolve(owner);
      if (!current) return { by: "fallback", reason: "unconfigured" } satisfies Fallback;
      if (!response.answer || current.binding.revision !== binding.revision || current.credential !== credential) {
        return { by: "fallback", reason: "error" } satisfies Fallback;
      }
      return { by: "gate", model: response.model, answer: response.answer } as const;
    } catch {
      return { by: "fallback", reason: "error" } satisfies Fallback;
    }
  }

  private low(confidence: number): boolean {
    return confidence < (this.options.minConfidence ?? DECISION_GATE_DEFAULTS.min_confidence);
  }

  async gradeNotice(owner: string, input: NoticeDecisionInput): Promise<NoticeDecision> {
    const decision = await this.ask(owner, "notice", input);
    if (decision.by === "fallback") return { level: "digest", graded: decision };
    const { answer, model } = decision;
    if (answer.type !== "choice") return { level: "digest", graded: { by: "fallback", reason: "error" } };
    if (this.low(answer.confidence)) return { level: "digest", graded: { by: "fallback", reason: "low_confidence" } };
    return { level: answer.choice, graded: { by: "gate", model, confidence: answer.confidence } };
  }

  async assessProgress(owner: string, input: ProgressDecisionInput): Promise<ProgressDecision> {
    const decision = await this.ask(owner, "progress", input);
    if (decision.by === "fallback") return decision;
    const { answer, model } = decision;
    if (answer.type !== "noul") return { by: "fallback", reason: "error" };
    const confidence = Math.max(answer.probability, 1 - answer.probability);
    if (answer.probability === 0.5 || this.low(confidence)) return { by: "fallback", reason: "low_confidence" };
    return { by: "gate", model, made_progress: answer.probability > 0.5, confidence };
  }
}

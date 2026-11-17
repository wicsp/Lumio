import { randomUUID } from "node:crypto";
import { JobAction, JobControlTarget, JobHumanRequest, type JobActionReceipt } from "@lumio/schema";

type Choice = { action: JobAction } | { action: "expired" | "cancelled" | "unavailable" };
type Prompt = JobHumanRequest extends infer T ? T extends JobHumanRequest ? Omit<T, "id" | "target" | "expires"> : never : never;
type Close = Extract<import("@lumio/schema").JobActivityEvent, { type: "request_closed" }>["outcome"];
export class WorkerJobControl {
  private target: JobControlTarget | null = null;
  private pending?: { prompt: JobHumanRequest; resolve: (choice: Choice) => void; timer: ReturnType<typeof setTimeout> };
  private requests = 0;
  private changeHandler?: () => Promise<unknown>;
  private stopped = false;
  onSteer?: (text: string) => Promise<boolean>;
  private receive = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || !("kind" in raw)) return;
    if (raw.kind === "stop") { void this.stop(); return; }
    if (raw.kind !== "action" || !("action" in raw)) return;
    const parsed = JobAction.safeParse(raw.action);
    if (!parsed.success) return;
    void this.apply(parsed.data);
  };
  constructor() { process.on("message", this.receive); }
  onStop(action: () => Promise<unknown>) { this.changeHandler = action; if (this.stopped) void action().catch(() => {}); }
  private publish(outcome?: { prompt_id: string; outcome: Close }) {
    if (process.connected) process.send?.({ kind: "control", target: this.target, pending: this.pending?.prompt ?? null, ...(outcome ? { closed: outcome } : {}) });
  }
  bind(target: JobControlTarget) {
    if (this.stopped) return;
    this.target = JobControlTarget.parse(target);
    this.publish();
  }
  async request(input: Prompt, signal?: AbortSignal, engineTimeout?: number): Promise<Choice> {
    if (!this.target || this.pending || this.requests >= 64 || this.stopped || signal?.aborted) return { action: "unavailable" };
    const ttl = typeof engineTimeout === "number" && Number.isFinite(engineTimeout) ? Math.min(300_000, Math.max(1, engineTimeout)) : 300_000;
    const parsed = JobHumanRequest.safeParse({ ...input, id: randomUUID(), target: this.target, expires: new Date(Date.now() + ttl).toISOString() });
    if (!parsed.success) return { action: "unavailable" };
    this.requests++;
    const prompt = parsed.data;
    const abort = () => { if (this.pending?.prompt.id === prompt.id) this.resolve({ action: "cancelled" }, "cancelled"); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise(resolve => {
        this.pending = { prompt, resolve, timer: setTimeout(() => this.resolve({ action: "expired" }, "expired"), ttl) };
        this.publish();
      });
    } finally { signal?.removeEventListener("abort", abort); }
  }
  private resolve(choice: Choice, outcome: Close) {
    const active = this.pending;
    if (!active) return;
    this.pending = undefined;
    clearTimeout(active.timer);
    this.publish({ prompt_id: active.prompt.id, outcome });
    active.resolve(choice);
  }
  private async apply(action: JobAction) {
    let state: JobActionReceipt["state"] = "rejected";
    const target = this.target, prompt = this.pending?.prompt;
    if (!this.stopped && target && action.target.instance === target.instance && action.target.turn === target.turn && action.target.session === target.session) {
      if (action.action === "steer" && !this.pending && this.onSteer) {
        try { state = await this.onSteer(action.text) ? "applied" : "rejected"; } catch { state = "unknown"; }
      } else if ("prompt_id" in action && prompt?.id === action.prompt_id) {
        if (Date.parse(prompt.expires) <= Date.now()) {
          this.resolve({ action: "expired" }, "expired"); state = "expired";
        } else if (action.action === "deny" || (action.action === "approve" && prompt.kind === "approval" && prompt.can_approve)
          || (action.action === "answer" && prompt.kind === "question" && prompt.questions.every(question => {
            const values = action.answers.filter(answer => answer.question === question.id);
            return values.length === 1 && (question.multiple || values[0]!.values.length === 1)
              && (!question.options.length || values[0]!.values.every(value => question.options.includes(value)));
          }))) {
          // For an approval or answer, the adapter sends its own receipt after engine delivery.
          this.resolve({ action }, action.action === "approve" ? "approved" : action.action === "answer" ? "answered" : "denied");
          return;
        }
      }
    }
    this.receipt(action.request_id, state);
  }
  receipt(request_id: string, state: JobActionReceipt["state"]) {
    if (process.connected) process.send?.({ kind: "action-result", request_id, state });
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.resolve({ action: "cancelled" }, "cancelled");
    await this.changeHandler?.().catch(() => {});
  }
  close() {
    this.stopped = true;
    this.target = null;
    this.resolve({ action: "cancelled" }, "unknown");
    this.publish();
    process.off("message", this.receive);
  }
}

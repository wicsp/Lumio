import { timingSafeEqual } from "node:crypto";
import {
  JOB_ACTIVITY_MAX_BODY, JobAction, JobActivityAck, JobActivityCapabilities, JobActivityPage, JobActivityQuery, JobActivitySync, JobAttention, JobLiveView,
  type AgentRun, type Job, type JobActionReceipt, type JobControlTarget, type JobHumanRequest,
} from "@lumio/schema";
import { jobAccountCurrent, jobCodexConnections } from "./job-accounts.ts";
import type { HubStore, Identity } from "./store.ts";
import { HubError } from "./errors.ts";
import type { Notifications } from "./notifications.ts";

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
const issue = (code: "INVALID" | "CONFLICT" | "FORBIDDEN" | "NOT_FOUND") => new HubError(code, {
  key: code === "INVALID" ? "jobs.activity_invalid" : code === "CONFLICT" ? "jobs.activity_conflict"
    : code === "NOT_FOUND" ? "jobs.job_not_found" : "server.request_not_authorized", args: [],
});
const isLive = (job: Job) => !job.result && (job.status === "assigned" || job.status === "running");
const sameTarget = (a: JobControlTarget | null, b: JobControlTarget | null) => Boolean(a && b
  && a.instance === b.instance && a.session === b.session && a.turn === b.turn);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isSent = (state: JobActionReceipt["state"]) => state === "delivered";

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body || Number(request.headers.get("content-length")) > JOB_ACTIVITY_MAX_BODY) throw issue("INVALID");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return JSON.parse(buffer + decoder.decode());
      size += part.value.byteLength;
      if (size > JOB_ACTIVITY_MAX_BODY) throw issue("INVALID");
      buffer += decoder.decode(part.value, { stream: true });
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw issue("INVALID");
  } finally { reader.releaseLock(); }
}

function matchesAnswers(prompt: Extract<JobHumanRequest, { kind: "question" }>, action: Extract<JobAction, { action: "answer" }>) {
  return action.answers.length === prompt.questions.length && prompt.questions.every(question => {
    const answers = action.answers.filter(answer => answer.question === question.id);
    if (answers.length !== 1) return false;
    const values = answers[0]!.values;
    return (question.multiple || values.length === 1) && new Set(values).size === values.length
      && (question.options.length === 0 || values.every(value => question.options.includes(value)));
  });
}

export function checkJobInteraction(store: HubStore, runtime: string, run: AgentRun, now: Date, account = false): boolean {
  if (!run.interaction) return true;
  const device = store.runtimes(now).find(value => value.actor === runtime);
  const engine = device?.registration.engines.find(value => value.name === run.engine);
  const cap = store.jobActivity.engines(runtime).find(value => value.engine === run.engine && value.version === engine?.version);
  return Boolean(device?.online && (account ? cap?.account_reuse : cap?.approvals && cap.questions)
    && run.permissions?.access !== "full" && cap?.sandbox === "os");
}

export class JobActivity {
  private sweptAt = -Infinity;
  constructor(private readonly store: HubStore, private readonly notifications: Notifications) {}
  private job(id: string) {
    const job = this.store.executionStore.get(id);
    if (!job) throw issue("NOT_FOUND");
    return job;
  }
  private allowed(job: Job, now: Date) {
    if (!isLive(job) || this.store.executionStore.cancelRequested(job.spec.id)) return false;
    const binding = this.store.jobActivity.account(job.spec.id);
    if (!binding) return true;
    const runtime = this.store.runtimes(now).find(device => device.actor === job.spec.runtime);
    return !!runtime && jobAccountCurrent(this.store, binding, runtime);
  }
  private connected(job: Job, now: Date) {
    const last = job.last_seen ?? job.assigned;
    return Boolean(last && now.getTime() - Date.parse(last) <= 3 * MINUTE
      && this.store.runtimes(now).find(value => value.actor === job.spec.runtime)?.online);
  }
  private settle(job: Job, now: Date) {
    const active = this.allowed(job, now);
    for (const row of this.store.jobActivity.actions(job.spec.id)) {
      if (row.receipt.state !== "queued" && row.receipt.state !== "delivered") continue;
      if (active && Date.parse(row.expires) > now.getTime()) continue;
      this.store.jobActivity.updateAction(job.spec.id, {
        request_id: row.receipt.request_id,
        state: isSent(row.receipt.state) ? "unknown" : active ? "expired" : "rejected",
        at: now.toISOString(),
      });
    }
  }
  sweep(now: Date) {
    if (now.getTime() - this.sweptAt < DAY) return;
    this.store.jobActivity.prune(new Date(now.getTime() - 30 * DAY).toISOString());
    this.sweptAt = now.getTime();
  }
  private pending(job: Job, now: Date) {
    const state = this.store.jobActivity.state(job.spec.id);
    return this.allowed(job, now) && this.connected(job, now) && state.pending && Date.parse(state.pending.expires) > now.getTime()
      ? state.pending : null;
  }
  live(job: Job, now: Date, viewer?: string) {
    const id = job.spec.id, store = this.store.jobActivity, state = store.state(id);
    const events = store.events(id), active = this.allowed(job, now);
    const activeTools = new Map<string, Extract<import("@lumio/schema").JobActivityEvent, { type: "tool_started" }>["tool"]>();
    let phase: JobLiveView["phase"] = null, started = job.result?.started ?? null;
    for (const { event } of events) {
      if (event.type === "phase") {
        phase = event.phase;
        if (event.phase === "preparing") started ??= event.at;
      }
      if (event.type === "tool_started") activeTools.set(event.tool.id, event.tool);
      if (event.type === "tool_finished") activeTools.delete(event.tool.id);
    }
    const waiting = !job.result && !phase && !started && !job.last_seen
      && (job.status === "queued" || job.status === "assigned");
    const runtimeOnline = waiting && this.store.runtimes(now).some(value => value.actor === job.spec.runtime && value.online);
    const connected = waiting ? (runtimeOnline || (job.status === "queued" ? null : false))
      : isLive(job) ? this.connected(job, now) : null;
    const binding = store.account(id);
    const controlsVisible = !viewer || !binding || binding.owner === viewer;
    const run = job.spec.run;
    const cap = run.kind === "agent" ? store.engines(job.spec.runtime).find(value => value.engine === run.engine) : undefined;
    this.settle(job, now);
    return JobLiveView.parse({
      job: id, status: job.status, created: job.spec.created, assigned: job.assigned ?? null, started,
      last_heartbeat: job.last_seen ?? null, last_activity: events.at(-1)?.event.at ?? null,
      connected,
      capability: cap ? (cap.account_reuse && binding ? { ...cap, approvals: true, questions: true, steer: true } : cap) : null,
      phase,
      sequence: state.sequence, first_available: state.first,
      stop_requested: isLive(job) && !active,
      active_tools: active ? Array.from(activeTools.values()).slice(-32) : [],
      recent: events.slice(-8), target: controlsVisible && active && this.connected(job, now) ? state.target : null,
      pending: controlsVisible ? this.pending(job, now) : null, receipts: controlsVisible ? store.actions(id, 12).map(value => value.receipt) : [],
    });
  }
  async human(request: Request, identity: Identity, id: string | undefined, kind: "live" | "events" | "actions" | "attention" | "capabilities", now: Date) {
    if (identity.actor.role !== "human") throw issue("FORBIDDEN");
    if (kind === "capabilities") return Response.json(JobActivityCapabilities.parse(this.store.runtimes(now).map(runtime => {
      const codex_connections = jobCodexConnections(this.store, runtime, identity.actor.id);
      return { runtime: runtime.actor, name: runtime.registration.name, online: runtime.online, engines: this.store.jobActivity.engines(runtime.actor),
        ...(codex_connections ? { codex_connections } : {}) };
    })));
    if (kind === "attention") {
      const items = this.store.jobActivity.pendingJobs().flatMap(id => {
        const job = this.store.executionStore.get(id);
        const binding = this.store.jobActivity.account(id);
        const pending = job && (!binding || binding.owner === identity.actor.id) && this.pending(job, now);
        return job && pending ? [{ job: id, task: job.spec.source?.task ?? null, kind: pending.kind, expires: pending.expires }] : [];
      });
      return Response.json(JobAttention.parse(items));
    }
    const job = this.job(id!);
    if (kind === "live") return Response.json(this.live(job, now, identity.actor.id));
    if (kind === "events") {
      const params = new URL(request.url).searchParams;
      const number = (name: string) => {
        const value = params.get(name);
        return value === null ? undefined : /^\d+$/.test(value) ? Number(value) : NaN;
      };
      const input = JobActivityQuery.safeParse({ after: number("after"), limit: number("limit") });
      if (!input.success) throw issue("INVALID");
      const { after, limit } = input.data, store = this.store.jobActivity, state = store.state(job.spec.id);
      if (after > state.sequence) throw issue("INVALID");
      const rows = store.events(job.spec.id, after, limit + 1), events = rows.slice(0, limit);
      const gap = state.first === null ? state.sequence > after : state.first > after + 1;
      return Response.json(JobActivityPage.parse({
        first_available: state.first, next_after: events.at(-1)?.sequence ?? (gap ? state.sequence : after),
        has_more: rows.length > limit, events, gap,
      }));
    }
    const parsed = JobAction.safeParse(await boundedJson(request));
    if (!parsed.success) throw issue("INVALID");
    const action = parsed.data, store = this.store.jobActivity;
    return this.store.db.transaction(() => {
      const current = this.job(job.spec.id);
      const prior = store.action(current.spec.id, action.request_id);
      if (prior) {
        if (prior.owner !== identity.actor.id || !equal(prior.action, action)) throw issue("CONFLICT");
        this.settle(current, now);
        return Response.json(store.action(current.spec.id, action.request_id)!.receipt);
      }
      const binding = store.account(current.spec.id);
      if (binding && binding.owner !== identity.actor.id) throw issue("FORBIDDEN");
      const run = current.spec.run, state = store.state(current.spec.id);
      if (run.kind !== "agent" || !run.interaction || !this.allowed(current, now) || !this.connected(current, now)
        || !sameTarget(state.target, action.target)) throw issue("CONFLICT");
      this.settle(current, now);
      const rows = store.actions(current.spec.id);
      if (rows.length >= 256 || rows.filter(row => ["queued", "delivered"].includes(row.receipt.state)).length >= 8) throw issue("CONFLICT");
      let expires = new Date(now.getTime() + MINUTE).toISOString();
      if (action.action !== "steer") {
        const pending = this.pending(current, now);
        if (!pending || pending.id !== action.prompt_id || !sameTarget(pending.target, action.target)
          || rows.some(row => "prompt_id" in row.action && row.action.prompt_id === pending.id)) throw issue("CONFLICT");
        if (action.action === "approve" && (pending.kind !== "approval" || !pending.can_approve)) throw issue("INVALID");
        if (action.action === "answer" && (pending.kind !== "question" || !matchesAnswers(pending, action))) throw issue("INVALID");
        expires = pending.expires;
      } else if (state.pending || !store.engines(current.spec.runtime).some(value => value.engine === run.engine && (value.steer || !!binding && value.account_reuse))) throw issue("CONFLICT");
      const receipt = { request_id: action.request_id, state: "queued", at: now.toISOString() } as const;
      store.addAction(current.spec.id, { action, receipt, expires, owner: identity.actor.id });
      this.store.audit(identity, JSON.stringify({ op: "job.activity.action", job: current.spec.id, turn: action.target.turn, action: action.action,
        ...("prompt_id" in action ? { prompt: action.prompt_id } : {}) }), "allow", undefined, "applied");
      return Response.json(receipt, { status: 202 });
    })();
  }
  async runtime(request: Request, identity: Identity, now: Date) {
    if (identity.actor.role !== "runtime") throw issue("FORBIDDEN");
    const parsed = JobActivitySync.safeParse(await boundedJson(request));
    if (!parsed.success) throw issue("INVALID");
    const input = parsed.data, actor = identity.actor.id, store = this.store.jobActivity;
    const runtime = this.store.runtimes(now).find(value => value.actor === actor);
    if (!runtime) throw issue("FORBIDDEN");
    if (input.type === "register") {
      if (new Set(input.engines.map(value => value.engine)).size !== input.engines.length
        || input.engines.some(value => !runtime.registration.engines.some(engine => engine.name === value.engine && engine.version === value.version)
          || (value.account_reuse && (value.engine !== "codex" || value.sandbox !== "os" || input.platform !== "darwin")))) {
        throw issue("INVALID");
      }
      store.register(actor, input);
      return Response.json(JobActivityAck.parse({ type: "registered" }));
    }
    return this.store.db.transaction(() => {
      const job = this.job(input.job), knownLease = Buffer.from(job.spec.lease), lease = Buffer.from(input.lease);
      if (job.spec.runtime !== actor || !job.assigned || lease.length !== knownLease.length || !timingSafeEqual(knownLease, lease)) throw issue("FORBIDDEN");
      const afterFinish = job.result && now.getTime() - Date.parse(job.result.finished);
      if (afterFinish !== undefined && afterFinish > DAY) throw issue("CONFLICT");
      const state = store.state(input.job), original = state.sequence;
      const cancel = !this.allowed(job, now);
      const ack = (acknowledged: number, conflict: boolean, actions: JobAction[] = [], receipts: JobActionReceipt[] = []) =>
        Response.json(JobActivityAck.parse({ type: "job", acknowledged, conflict, cancel, actions, receipts }), { status: conflict ? 409 : 200 });
      if (input.authorization_check) {
        if (input.events.length || input.receipts.length || input.target !== undefined || input.pending !== undefined) throw issue("INVALID");
        return ack(original, false);
      }
      for (const record of input.events) {
        if (record.sequence <= original) {
          if (store.event(input.job, record.sequence) !== JSON.stringify(record)) return ack(original, true);
          continue;
        }
        if (record.sequence !== state.sequence + 1 || record.sequence > 4096) return ack(original, true);
        state.sequence = record.sequence;
      }
      for (const record of input.events) {
        if (record.sequence <= original) continue;
        store.append(input.job, record);
        state.first ??= record.sequence;
      }
      const previous = state.pending, run = job.spec.run;
      if (cancel) { state.target = null; state.pending = null; }
      else if (run.kind === "agent" && run.interaction && input.target !== undefined) {
        state.target = input.target;
        state.pending = input.pending ?? null;
        if (state.pending && (!sameTarget(state.pending.target, state.target) || Date.parse(state.pending.expires) > now.getTime() + 6 * MINUTE)) throw issue("INVALID");
      }
      store.save(input.job, state);
      if (state.pending && state.pending.id !== previous?.id && Date.parse(state.pending.expires) > now.getTime()) {
        this.notifications.jobRequest(input.job, state.pending.id, now.toISOString());
      }
      const receipts: JobActionReceipt[] = [];
      for (const receipt of input.receipts) {
        const row = store.action(input.job, receipt.request_id);
        if (!row || !["applied", "rejected", "unknown", "expired"].includes(receipt.state)) throw issue("INVALID");
        if (row.receipt.state === "delivered" || row.receipt.state === "unknown") {
          const updated = { ...receipt, at: now.toISOString() };
          store.updateAction(input.job, updated);
          const human = this.store.actors().find(value => value.id === row.owner);
          if (human) this.store.audit({ actor: human, label: human.name }, JSON.stringify({
            op: "job.activity.action.result", job: input.job, turn: row.action.target.turn, action: row.action.action,
            state: receipt.state, request: receipt.request_id,
          }), "allow", undefined, "applied");
        }
        receipts.push(store.action(input.job, receipt.request_id)!.receipt);
      }
      this.settle(job, now);
      const actions = cancel || !state.target ? [] : store.actions(input.job).reverse()
        .filter(row => ["delivered", "queued"].includes(row.receipt.state) && sameTarget(row.action.target, state.target)).slice(0, 8);
      for (const row of actions) if (row.receipt.state === "queued") {
        store.updateAction(input.job, { ...row.receipt, state: "delivered", at: now.toISOString() });
      }
      return ack(state.sequence, false, actions.map(row => row.action), receipts);
    })();
  }
}

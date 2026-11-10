import { randomUUID } from "node:crypto";
import {
  AIQuotaSettings, AIQuotaSnapshot, AIQuotaView, ClaudeQuotaBindings, ClaudeQuotaSample,
  type AIConnection, type AIQuotaStatus, type CodexQuotaResult, type NativeAccountBinding,
  type NotificationEvent,
} from "@lumio/schema";
import type { SqliteAIStore, StoredAIQuota } from "@lumio/storage";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const POLL = 15 * 60_000;
const CLAUDE_FRESH = 2 * 60 * 60_000;
const error = (code: "INVALID" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT", key = "ai.invalid") =>
  new HubError(code, { key, args: [] });

function officialDeepSeek(connection: AIConnection): boolean {
  return connection.kind === "deepseek" && !!connection.base_url &&
    new URL(connection.base_url).origin === new URL(BALANCE_URL).origin;
}

async function limitedJson(stream: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (!stream) throw new Error();
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      size += value.byteLength;
      if (size > 16_384) throw new Error();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function deepSeekSnapshot(input: unknown, time: Date): AIQuotaSnapshot {
  const data = input as { is_available?: unknown; balance_infos?: unknown };
  if (!Array.isArray(data?.balance_infos) || data.balance_infos.length > 2) throw new Error();
  return AIQuotaSnapshot.parse({
    source: "deepseek", sampled_at: time.toISOString(), available: data.is_available,
    balances: data.balance_infos.map(item => ({
      currency: item?.currency, total: item?.total_balance, topped_up: item?.topped_up_balance, granted: item?.granted_balance,
    })),
  });
}

function decimalUnits(amount: string): bigint {
  const [whole, fraction = ""] = amount.replace(/^-/, "").split(".");
  return BigInt(whole + fraction.padEnd(12, "0")) * (amount.startsWith("-") ? -1n : 1n);
}

function lowItems(snapshot: AIQuotaSnapshot, settings: AIQuotaSettings, now: number): Map<string, string> {
  const low = new Map<string, string>();
  if (!settings.monitor) return low;
  if (snapshot.source === "deepseek") {
    for (const balance of snapshot.balances) {
      const threshold = settings.thresholds[balance.currency];
      if (threshold !== undefined && decimalUnits(balance.total) < decimalUnits(threshold)) low.set(balance.currency, "");
    }
  } else {
    const threshold = settings.thresholds.remaining_percent;
    for (const window of snapshot.windows) {
      if (window.resets_at && Date.parse(window.resets_at) <= now) continue;
      if (threshold !== undefined && window.used_percent !== undefined && window.used_percent > 100 - threshold)
        low.set(window.id, window.resets_at ?? "");
    }
  }
  return low;
}

const codexBinding = (runtime: string, binding: NativeAccountBinding) =>
  JSON.stringify([runtime, binding.account, binding.generation]);

export class AIUsage {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly authEpoch = new Map<string, string>();
  private readonly claudeSeen = new Map<string, number>();
  private nextTick = 0;

  constructor(
    private readonly store: SqliteAIStore,
    private readonly hub: HubStore,
    private readonly codex: {
      state(runtime: string): "offline" | "unsupported" | "ready";
      read(connection: AIConnection, runtime: string): Promise<CodexQuotaResult | { status: "offline" }>;
    },
    private readonly notify: (event: NotificationEvent) => void,
    private readonly signal: AbortSignal,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private runtime(connection: AIConnection) {
    return this.hub.runtimes(this.now()).find(runtime => runtime.registration.name === connection.host);
  }

  private owned(owner: string, id: string): AIConnection {
    const connection = this.store.connection(id);
    if (!connection || connection.owner !== owner) throw error("NOT_FOUND", "ai.connection_missing");
    return connection;
  }

  private status(connection: AIConnection, stored: StoredAIQuota): AIQuotaStatus {
    if (connection.kind === "deepseek") {
      if (!officialDeepSeek(connection)) return "unsupported";
      if (!connection.api_key_set) return "credentials";
    } else if (connection.kind === "codex-account") {
      const runtime = this.runtime(connection);
      if (!runtime?.online) return "offline";
      const state = this.codex.state(runtime.actor);
      if (state !== "ready") return state;
    } else if (connection.kind === "claude-code-subscription") {
      if (!stored.generation) return "waiting";
      const runtime = this.runtime(connection);
      if (!runtime?.online || stored.binding !== runtime.actor) return "offline";
      const seen = this.claudeSeen.get(runtime.actor);
      if (seen === undefined || this.now().getTime() - seen > 180_000) return stored.snapshot ? "stale" : "waiting";
    } else return "unsupported";
    if (stored.status && stored.status !== "ready") return stored.status;
    const snapshot = stored.snapshot;
    if (!snapshot) return "waiting";
    const now = this.now().getTime();
    const age = now - Date.parse(snapshot.sampled_at);
    if (age > (snapshot.source === "claude-code" ? CLAUDE_FRESH : 2 * POLL) ||
        (snapshot.source !== "deepseek" && snapshot.windows.some(window => window.resets_at && Date.parse(window.resets_at) <= now)))
      return "stale";
    return "ready";
  }

  view(connection: AIConnection): AIQuotaView {
    const stored = this.store.quota(connection.id);
    const runtime = connection.host === "hub" ? undefined : this.runtime(connection);
    const matching = connection.kind === "claude-code-subscription" ? stored.binding === runtime?.actor
      : connection.kind === "codex-account" ? !stored.binding || (runtime && JSON.parse(stored.binding)[0] === runtime.actor) : true;
    const snapshot = matching ? stored.snapshot : undefined;
    const status = this.status(connection, matching ? stored : { settings: stored.settings, generation: stored.generation });
    return AIQuotaView.parse({
      connection: connection.id, status, snapshot, settings: stored.settings,
      attention: !!snapshot && status === "ready" && ((snapshot.source === "deepseek" && !snapshot.available) ||
        lowItems(snapshot, stored.settings, this.now().getTime()).size > 0),
      claude_binding: matching && stored.generation ? { connection: connection.id, generation: stored.generation } : undefined,
    });
  }

  private success(connection: AIConnection, stored: StoredAIQuota, snapshot: AIQuotaSnapshot, binding = stored.binding) {
    const previous = stored.snapshot;
    if (previous && Date.parse(previous.sampled_at) >= Date.parse(snapshot.sampled_at)) return;
    const now = this.now().getTime();
    const oldAlerts = stored.alerted ?? {};
    // Keep alerts for temporarily missing metrics. Missing is not proof that an alert cleared.
    const alerted = new Map(Object.entries(oldAlerts));
    const low = lowItems(snapshot, stored.settings, now);
    const observed = snapshot.source === "deepseek" ? snapshot.balances.map(balance => balance.currency) :
      snapshot.windows.filter(window => window.used_percent !== undefined && (!window.resets_at || Date.parse(window.resets_at) > now)).map(window => window.id);
    const fresh = now - Date.parse(snapshot.sampled_at) <= (snapshot.source === "claude-code" ? CLAUDE_FRESH : 2 * POLL);
    for (const id of fresh ? observed : []) {
      const marker = low.get(id);
      if (marker === undefined) alerted.delete(id);
      else if (!alerted.has(id) || (marker && alerted.get(id) !== marker)) {
        this.notify({ id: randomUUID(), owner: connection.owner, kind: "ai.quota_low",
          title: connection.name.slice(0, 120), path: "#settings/ai", created: this.now().toISOString() });
        alerted.set(id, marker);
      }
    }
    this.store.putQuota(connection.id, { ...stored, binding, snapshot, status: "ready",
      alerted: Object.fromEntries(alerted), next: now + POLL, failures: 0 });
  }

  private failed(connection: AIConnection, stored: StoredAIQuota, status: AIQuotaStatus) {
    const failures = Math.min((stored.failures ?? 0) + 1, 6);
    this.store.putQuota(connection.id, { ...stored, status, failures, next: this.now().getTime() + Math.min(30 * 60_000, 60_000 * 2 ** (failures - 1)) });
  }

  /** Login/logout and account verification also invalidate readings without waiting for a refresh. */
  observeCodex(connection: AIConnection, runtime: string, binding?: NativeAccountBinding): void {
    const stored = this.store.quota(connection.id);
    const key = binding && codexBinding(runtime, binding);
    if (stored.binding !== key || (!binding && (stored.snapshot || stored.status !== "credentials"))) {
      this.authEpoch.set(connection.id, randomUUID());
      this.store.putQuota(connection.id, { settings: stored.settings, binding: key, status: binding ? "waiting" : "credentials" });
    }
  }

  suspendCodex(id: string): void {
    this.authEpoch.set(id, randomUUID());
  }

  private async collect(connection: AIConnection) {
    if (this.signal.aborted) return;
    const runtime = connection.kind === "codex-account" ? this.runtime(connection) : undefined;
    const epoch = this.authEpoch.get(connection.id);
    const current = () => {
      const active = this.store.connection(connection.id);
      return !this.signal.aborted && active?.revision === connection.revision && epoch === this.authEpoch.get(connection.id)
        && (!runtime || this.runtime(active)?.actor === runtime.actor) ? active : undefined;
    };
    if (officialDeepSeek(connection)) {
      const key = this.store.secret(connection.id);
      if (!key) return;
      let snapshot: AIQuotaSnapshot | undefined;
      let state: AIQuotaStatus = "error";
      try {
        const response = await this.fetcher(BALANCE_URL, { headers: { Authorization: `Bearer ${key}` }, redirect: "error",
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(8000)]) });
        if (response.ok) snapshot = deepSeekSnapshot(await limitedJson(response.body), this.now());
        else {
          void response.body?.cancel().catch(() => {});
          if (response.status === 401 || response.status === 403) state = "credentials";
        }
      } catch { /* Only normalized states cross the public API. */ }
      if (!current()) return;
      this.store.db.transaction(() => {
        const stored = this.store.quota(connection.id);
        if (snapshot) this.success(connection, stored, snapshot);
        else this.failed(connection, stored, state);
      }).immediate();
    } else if (runtime?.online && this.codex.state(runtime.actor) === "ready") {
      const result = await this.codex.read(connection, runtime.actor);
      if (!current()) return;
      this.store.db.transaction(() => {
        let stored = this.store.quota(connection.id);
        const binding = "binding" in result && result.binding ? codexBinding(runtime.actor, result.binding) : undefined;
        if ((binding && binding !== stored.binding) || result.status === "credentials") stored = { settings: stored.settings, binding };
        if (result.status === "ready") this.success(connection, stored, { ...result.snapshot, sampled_at: this.now().toISOString() }, binding);
        else this.failed(connection, stored, result.status);
      }).immediate();
    }
  }

  private refresh(connection: AIConnection): Promise<void> {
    const pending = this.inflight.get(connection.id);
    if (pending) return pending;
    const next = this.collect(connection).finally(() => this.inflight.delete(connection.id));
    this.inflight.set(connection.id, next);
    return next;
  }

  tick(): void {
    const now = this.now().getTime();
    if (now < this.nextTick || this.signal.aborted) return;
    this.nextTick = now + 15_000;
    for (const connection of this.store.quotaConnections()) {
      const quota = this.store.quota(connection.id);
      if (!quota.settings.monitor || (quota.next ?? 0) > now || connection.kind === "claude-code-subscription") continue;
      void this.refresh(connection).catch(() => {});
    }
  }

  async stop(): Promise<void> { await Promise.allSettled(this.inflight.values()); }

  async human(request: Request, identity: Identity): Promise<Response> {
    if (identity.actor.role !== "human") throw error("FORBIDDEN", "native.forbidden");
    const owner = identity.actor.id;
    const path = new URL(request.url).pathname;
    const headers = { "Cache-Control": "no-store" };
    if (path === "/v2/ai/usage" && request.method === "GET")
      return Response.json(this.store.connections(owner).map(connection => this.view(connection)), { headers });
    const match = /^\/v2\/ai\/connections\/(aic_[0-9A-HJKMNP-TV-Z]{26})\/usage\/(refresh|settings|bind)$/.exec(path);
    if (!match) throw error("NOT_FOUND", "ai.connection_missing");
    const connection = this.owned(owner, match[1]!);
    const action = match[2];
    if (action === "refresh" && request.method === "POST" && ["deepseek", "codex-account"].includes(connection.kind)) {
      await this.refresh(connection);
    } else if (action === "settings" && request.method === "PUT") {
      const settings = AIQuotaSettings.safeParse(await limitedJson(request.body).catch(() => null));
      if (!settings.success || !["deepseek", "codex-account", "claude-code-subscription"].includes(connection.kind))
        throw error("INVALID");
      this.owned(owner, connection.id);
      const stored = this.store.quota(connection.id);
      const previous = stored.settings;
      const thresholds = previous.thresholds;
      const updated = settings.data.thresholds;
      const changed = previous.monitor !== settings.data.monitor || thresholds.CNY !== updated.CNY ||
        thresholds.USD !== updated.USD || thresholds.remaining_percent !== updated.remaining_percent;
      this.store.putQuota(connection.id, { ...stored, settings: settings.data,
        ...(changed ? { alerted: undefined, next: undefined, failures: undefined } : {}) });
    } else if (action === "bind" && request.method === "POST" && connection.kind === "claude-code-subscription") {
      const runtime = this.runtime(connection);
      if (!runtime) throw error("CONFLICT", "native.runtime_offline");
      const { settings } = this.store.quota(connection.id);
      this.store.putQuota(connection.id, { settings, binding: runtime.actor, generation: randomUUID() });
    } else throw error("INVALID");
    return Response.json(this.view(this.owned(owner, connection.id)), { headers });
  }

  async claude(request: Request, identity: Identity): Promise<Response> {
    const actor = identity.actor.id;
    const runtime = this.hub.runtimes(this.now()).find(runtime => runtime.actor === actor);
    if (identity.actor.role !== "runtime" || !runtime?.online) throw error("FORBIDDEN", "native.forbidden");
    if (request.method === "GET") {
      const bindings = this.store.quotaConnections().flatMap(connection => {
        const quota = this.store.quota(connection.id);
        return connection.kind === "claude-code-subscription" && connection.host === runtime.registration.name &&
          quota.binding === actor && quota.generation ? [{ connection: connection.id, generation: quota.generation }] : [];
      });
      this.claudeSeen.set(actor, this.now().getTime());
      return Response.json(ClaudeQuotaBindings.parse(bindings), { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method !== "POST") throw error("INVALID");
    const sample = ClaudeQuotaSample.safeParse(await limitedJson(request.body).catch(() => null));
    if (!sample.success || Date.parse(sample.data.sampled_at) > this.now().getTime() + 60_000) throw error("INVALID");
    const { connection: id, generation, sampled_at, windows } = sample.data;
    const connection = this.store.connection(id);
    const stored = this.store.quota(id);
    if (connection?.kind !== "claude-code-subscription" || connection.host !== runtime.registration.name ||
        stored.binding !== actor || stored.generation !== generation) throw error("NOT_FOUND", "ai.connection_missing");
    this.claudeSeen.set(actor, this.now().getTime());
    if (stored.snapshot?.source !== "claude-code" || JSON.stringify(stored.snapshot.windows) !== JSON.stringify(windows))
      this.store.db.transaction(() => this.success(connection, stored, { source: "claude-code", sampled_at, windows })).immediate();
    return new Response(null, { status: 204 });
  }
}

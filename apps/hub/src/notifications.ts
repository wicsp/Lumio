import { createHash, randomBytes } from "node:crypto";
import { newId } from "@lumio/foundation";
import { NOTIFICATION_KINDS, RESPONSE_REASONS, NotificationEvent, PushDevice, PushDeviceUpdate, PushPublicKey,
  PushSubscriptionInput, PushTestResult, type TaskTurnChange, type WorkTask, type Proposal } from "@lumio/schema";
import type { HubStore } from "./store.ts";
import { HubError } from "./errors.ts";
import { text as msg } from "./messages.ts";
import { encryptPush, validatePushKeys, VapidKeys } from "./web-push.ts";

export interface NotificationChannel {
  readonly id: string;
  send(event: NotificationEvent): Promise<void>;
}
type DeviceRow = { id: string; owner: string; subscription: string; device: string };
// Classify known names instead of echoing a caller-controlled User-Agent into a response.
function deviceLabel(userAgent: string): string {
  for (const [pattern, label] of [[/iPhone/i, "iPhone"], [/iPad/i, "iPad"], [/Android/i, "Android"], [/Firefox\//i, "Firefox"], [/Edg\//i, "Edge"], [/Chrome\//i, "Chrome"], [/Safari\//i, "Safari"]] as const) {
    if (pattern.test(userAgent)) return label;
  }
  return "Browser";
}
const invalid = () => new HubError("INVALID", { key: "notifications.invalid", args: [] });

/** Hub-owned subscriptions; private delivery credentials never leave this adapter. */
export class WebPushChannel implements NotificationChannel {
  readonly id = "web-push";
  readonly vapid: VapidKeys;
  constructor(private readonly store: HubStore, stateDir: string, private readonly options: {
    fetch?: typeof fetch; now?: () => Date; subject?: string; signal?: AbortSignal;
  } = {}) {
    this.vapid = new VapidKeys(stateDir);
    store.db.exec(`CREATE TABLE IF NOT EXISTS notification_push_devices (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES actors(id), endpoint_hash TEXT NOT NULL UNIQUE,
      subscription TEXT NOT NULL, device TEXT NOT NULL);`);
  }
  private now() { return this.options.now?.() ?? new Date(); }
  key(): PushPublicKey { return PushPublicKey.parse({ public_key: this.vapid.publicKey() }); }
  devices(owner: string): PushDevice[] {
    return this.rows(owner).map(row => PushDevice.parse(JSON.parse(row.device)));
  }
  private rows(owner: string): DeviceRow[] {
    return this.store.db.query<DeviceRow, [string]>("SELECT id,owner,subscription,device FROM notification_push_devices WHERE owner=? ORDER BY rowid").all(owner);
  }
  private row(owner: string, id: string): DeviceRow {
    const row = this.rows(owner).find(row => row.id === id);
    if (!row) throw new HubError("NOT_FOUND", { key: "notifications.device_missing", args: [] });
    return row;
  }
  subscribe(owner: string, input: unknown, userAgent = ""): PushDevice {
    const parsed = PushSubscriptionInput.safeParse(input);
    if (!parsed.success) throw invalid();
    const subscription = parsed.data;
    try {
      validatePushKeys(subscription.keys);
      const url = new URL(subscription.endpoint);
      if (url.username || url.password || url.hash) throw new Error();
    } catch { throw invalid(); }
    const digest = createHash("sha256").update(subscription.endpoint).digest("hex");
    const previous = this.store.db.query<DeviceRow, [string]>("SELECT id,owner,subscription,device FROM notification_push_devices WHERE endpoint_hash=?").get(digest);
    if (previous && previous.owner !== owner) throw new HubError("CONFLICT", { key: "notifications.invalid", args: [] });
    const now = this.now();
    const device = PushDevice.parse(previous ? { ...JSON.parse(previous.device), label: subscription.label ?? JSON.parse(previous.device).label, last_error: undefined }
      : { id: newId("pdev", now, randomBytes), owner, label: subscription.label ?? deviceLabel(userAgent), events: [...NOTIFICATION_KINDS], created: now.toISOString() });
    this.store.db.query(`INSERT INTO notification_push_devices(id,owner,endpoint_hash,subscription,device) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET subscription=excluded.subscription,device=excluded.device`).run(device.id, owner, digest, JSON.stringify(subscription), JSON.stringify(device));
    return device;
  }
  update(owner: string, id: string, input: unknown): PushDevice {
    const parsed = PushDeviceUpdate.safeParse(input); if (!parsed.success) throw invalid();
    const row = this.row(owner, id), device = PushDevice.parse({ ...JSON.parse(row.device), ...parsed.data });
    this.store.db.query("UPDATE notification_push_devices SET device=? WHERE id=? AND owner=?").run(JSON.stringify(device), id, owner);
    return device;
  }
  remove(owner: string, id: string): void {
    this.row(owner, id);
    this.store.db.query("DELETE FROM notification_push_devices WHERE id=? AND owner=?").run(id, owner);
  }
  private async deliver(row: DeviceRow, event: NotificationEvent, test = false): Promise<boolean> {
    // A device can be removed or changed while earlier network requests are in flight.
    const current = this.rows(event.owner).find(value => value.id === row.id);
    if (!current || current.subscription !== row.subscription || (!test && !PushDevice.parse(JSON.parse(current.device)).events.includes(event.kind))) return false;
    let error: string | undefined;
    try {
      const subscription = PushSubscriptionInput.parse(JSON.parse(row.subscription));
      const body = encryptPush(Buffer.from(JSON.stringify({ title: event.title, kind: event.kind, path: event.path })), subscription.keys);
      const response = await (this.options.fetch ?? globalThis.fetch)(subscription.endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(this.options.signal ? [this.options.signal] : [])]),
        headers: { Authorization: this.vapid.authorization(subscription.endpoint, this.now(), this.options.subject),
          "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "300" }, body,
      });
      // Do not read service-controlled error bodies, URLs or exception messages.
      await response.body?.cancel();
      if (response.status === 404 || response.status === 410) {
        this.store.db.query("DELETE FROM notification_push_devices WHERE id=? AND subscription=?").run(row.id, row.subscription);
        return false;
      }
      if (!response.ok) error = `Push service HTTP ${response.status}`;
    } catch { error = "Push delivery failed"; }
    // Merge with current preferences, and never resurrect a removed/replaced device.
    const latest = this.rows(event.owner).find(value => value.id === row.id);
    if (latest && latest.subscription === row.subscription) {
      const device = PushDevice.parse({ ...JSON.parse(latest.device), last_error: error,
        ...(!error ? { last_success: this.now().toISOString() } : {}) });
      this.store.db.query("UPDATE notification_push_devices SET device=? WHERE id=? AND subscription=?").run(JSON.stringify(device), row.id, row.subscription);
    }
    return !error;
  }
  async send(event: NotificationEvent): Promise<void> {
    for (const row of this.rows(event.owner)) {
      if (PushDevice.parse(JSON.parse(row.device)).events.includes(event.kind)) await this.deliver(row, event);
    }
  }
  async test(owner: string): Promise<PushTestResult> {
    const event = NotificationEvent.parse({ id: `test:${randomBytes(16).toString("hex")}`, owner, kind: "turn.review", title: "Lumio", path: "#settings", created: this.now().toISOString() });
    const results: boolean[] = [];
    for (const row of this.rows(owner)) results.push(await this.deliver(row, event, true));
    const delivered = results.length > 0 && results.every(Boolean);
    return PushTestResult.parse({ delivered, ...(!delivered ? { error: msg("notifications.test_failed") } : {}) });
  }
}

/** Transactional outbox plus persistent event-id deduplication, independent of channels. */
export class Notifications {
  readonly push: WebPushChannel;
  private readonly channels: readonly NotificationChannel[];
  private running: Promise<void> | undefined;
  private stopped = false;
  constructor(private readonly store: HubStore, stateDir: string, options: ConstructorParameters<typeof WebPushChannel>[2] = {}, channels?: readonly NotificationChannel[]) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS notification_events(id TEXT PRIMARY KEY, event TEXT NOT NULL, claimed INTEGER NOT NULL DEFAULT 0);`);
    this.push = new WebPushChannel(store, stateDir, options);
    this.channels = channels ?? [this.push];
  }
  /** Called inside the business transaction: rollback also rolls back the notification. */
  notify(input: NotificationEvent): void {
    const event = NotificationEvent.parse(input);
    this.store.db.query("INSERT OR IGNORE INTO notification_events(id,event) VALUES(?,?)").run(event.id, JSON.stringify(event));
  }
  private broadcast(source: string, kind: NotificationEvent["kind"], title: string, path: string, created: string): void {
    // Work and approvals are shared in this single-workspace Hub; each human has private devices.
    for (const actor of this.store.actors().filter(actor => actor.role === "human")) {
      this.notify({ id: createHash("sha256").update(`${source}:${actor.id}`).digest("hex"), owner: actor.id, kind,
        title: title.slice(0, 120) || "Lumio", path, created });
    }
  }
  turn(task: WorkTask, change: TaskTurnChange, sequence: number): void {
    if (change.to.holder !== "human" || !(RESPONSE_REASONS as readonly string[]).includes(change.to.reason)) return;
    this.broadcast(`turn:${task.id}:${sequence}`, `turn.${change.to.reason}` as NotificationEvent["kind"], task.title, `#work/${task.id}`, change.at);
  }
  proposal(proposal: Proposal, title?: string): void {
    // The freeform reason/argv/question are never notification content.
    this.broadcast(`proposal:${proposal.id}`, "proposal.pending", title ?? "Lumio", "#approvals", proposal.created);
  }
  drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.flush().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async flush(): Promise<void> {
    while (!this.stopped) {
      const row = this.store.db.query<{ id: string; event: string }, []>("SELECT id,event FROM notification_events WHERE claimed=0 ORDER BY rowid LIMIT 1").get();
      if (!row) return;
      // Claim before I/O: at most one attempt even after restart or an ambiguous network failure.
      this.store.db.query("UPDATE notification_events SET claimed=1 WHERE id=?").run(row.id);
      const event = NotificationEvent.parse(JSON.parse(row.event));
      await Promise.allSettled(this.channels.map(channel => Promise.resolve().then(() => channel.send(event))));
    }
  }
  async stop(): Promise<void> { this.stopped = true; await this.running; }
}

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NOTIFICATION_KINDS, NotificationEvent, PushDevice, PushPublicKey, PushTestResult, WorkCommandResult, WorkAttention, ApiError } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";
import { readConfig } from "../src/config.ts";
import { Notifications } from "../src/notifications.ts";
import { pushReceiver, verifyVapid } from "./fixtures/push.ts";

let temp: string, hub: Awaited<ReturnType<typeof startHub>>, human: string, other: string, agent: string, runtime: string;
let owner: string, otherOwner: string, logs: string[], received: { payload: unknown; auth: ReturnType<typeof verifyVapid> }[];
let receiver: ReturnType<typeof pushReceiver>, serviceStatus: number, failNetwork: boolean;
let sequence = 0;
const pushFetch = (async (url: string, init: RequestInit) => {
  expect(url).toBe(receiver.subscription.endpoint);
  expect(init.redirect).toBe("error"); expect(init.signal).toBeDefined();
  const headers = new Headers(init.headers);
  expect(headers.get("content-encoding")).toBe("aes128gcm"); expect(headers.get("ttl")).toBe("86400");
  received.push({ payload: receiver.decrypt(Buffer.from(init.body as Uint8Array)), auth: verifyVapid(headers.get("authorization")!) });
  if (failNetwork) throw new Error(`service echoed ${receiver.subscription.endpoint} ${receiver.subscription.keys.auth}`);
  return new Response(`service echoed ${receiver.subscription.endpoint}`, { status: serviceStatus });
}) as unknown as typeof fetch;
async function boot(publicUrl: string | undefined = "https://hub.example.test", webOrigins: string[] = []) {
  hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: temp, LUMIO_PUBLIC_URL: publicUrl, LUMIO_WEB_ORIGINS: webOrigins.join(",") }), localRuntime: "server", port: 0 }, { log: line => logs.push(line), pushFetch });
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-notifications-"));
  receiver = pushReceiver(); received = []; logs = []; serviceStatus = 201; failNetwork = false;
  const store = await HubStore.open(temp);
  owner = store.createActor("owner", "human").id; otherOwner = store.createActor("other", "human").id;
  store.createActor("agent", "agent"); const runtimeActor = store.createActor("server", "runtime").id;
  human = store.createToken("owner", "owner"); other = store.createToken("other", "other"); agent = store.createToken("agent", "agent"); runtime = store.createToken("server", "server");
  store.registerRuntime(runtimeActor, { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "synthetic", sandbox: "none" }], tags: [], max_concurrent: 1 }, new Date());
  store.close(); await boot();
});
afterEach(async () => { await hub?.stop(); await rm(temp, { recursive: true, force: true }); });
function request(path: string, method = "GET", body?: unknown, token = human, language = "en", origin?: string) {
  return fetch(`http://127.0.0.1:${hub.server.port}${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept-Language": language, ...(origin ? { Origin: origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function subscribe(token = human) {
  const response = await request("/v2/notifications/push/devices", "POST", receiver.subscription, token);
  expect(response.status).toBe(200); return PushDevice.parse(await response.json());
}
async function command(op: string, args: Record<string, unknown>, token = human, requestId = `synthetic-push-command-${++sequence}`) {
  const response = await request("/v2/work/commands", "POST", { request_id: requestId, operation: { op, args } }, token);
  expect(response.status).toBe(token === agent && op === "work.task.dispatch" ? 202 : 200);
  return WorkCommandResult.parse(await response.json());
}
function event(id = "synthetic-notification-0001", kind: NotificationEvent["kind"] = "turn.answer") {
  return NotificationEvent.parse({ id, owner, kind, title: "合成标题", path: "#work/task_synthetic", created: new Date().toISOString() });
}
function noSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [receiver.subscription.endpoint, receiver.subscription.keys.p256dh, receiver.subscription.keys.auth]) expect(text).not.toContain(secret);
}

test("human-only device API isolates owners, validates keys and keeps all responses/logs/audits free of secrets", async () => {
  expect(await stat(join(temp, "push-vapid.pem")).catch(() => null)).toBeNull();
  const key = await request("/v2/notifications/push/key"); expect(key.headers.get("cache-control")).toBe("no-store");
  expect(PushPublicKey.parse(await key.json()).public_key.length).toBe(87);
  const device = await subscribe(); noSecrets(device);
  expect(device.owner).toBe(owner); expect(device.events).toEqual([...NOTIFICATION_KINDS]); expect(device.label).toBe("Browser");
  expect((await subscribe()).id).toBe(device.id);
  const path = `/v2/notifications/push/devices/${device.id}`;
  expect(await (await request("/v2/notifications/push/devices", "GET", undefined, other)).json()).toEqual([]);
  for (const method of ["PATCH", "DELETE"]) expect((await request(path, method, method === "PATCH" ? { label: "Other" } : undefined, other)).status).toBe(404);
  expect((await request("/v2/notifications/push/devices", "POST", receiver.subscription, other)).status).toBe(409);
  const updated = PushDevice.parse(await (await request(path, "PATCH", { label: "Synthetic phone", events: ["turn.answer"] })).json());
  expect(updated.events).toEqual(["turn.answer"]); expect(updated.label).toBe("Synthetic phone");
  expect((await request(path, "PATCH", { owner: otherOwner })).status).toBe(400);
  for (const token of [agent, runtime, "invalid"]) {
    for (const [path, method] of [["/key", "GET"], ["/devices", "GET"], ["/devices", "POST"], [`/devices/${device.id}`, "PATCH"], [`/devices/${device.id}`, "DELETE"], ["/test", "POST"]]) {
      expect((await request(`/v2/notifications/push${path}`, method, method === "POST" ? receiver.subscription : undefined, token)).status).toBe(token === "invalid" ? 401 : 403);
    }
  }
  for (const input of [{ ...receiver.subscription, endpoint: "http://invalid.test/secret" }, { ...receiver.subscription, keys: { p256dh: "AAAA", auth: "AAAA" } }, { ...receiver.subscription, endpoint: "https://user:password@push.example.test" }]) {
    const response = await request("/v2/notifications/push/devices", "POST", input); expect(response.status).toBe(400); noSecrets(await response.json());
  }
  noSecrets(logs); noSecrets(hub.store.db.query("SELECT * FROM audit").all());
  expect((await request(path, "DELETE")).status).toBe(204); expect(await (await request("/v2/notifications/push/devices")).json()).toEqual([]);
  const inferred = hub.modules.notifications.push.subscribe(owner, receiver.subscription, `iPhone synthetic ${receiver.subscription.endpoint}`);
  expect(inferred.label).toBe("iPhone"); noSecrets(inferred);
});

test("synthetic service decrypts exact minimal payload, verifies VAPID; id dedup survives restart and concurrent drains", async () => {
  const device = await subscribe(), notifications = hub.modules.notifications;
  notifications.notify(event()); notifications.notify(event());
  await Promise.all([notifications.drain(), notifications.drain()]);
  expect(received).toHaveLength(1);
  expect(received[0]!.payload).toEqual({ title: "合成标题", kind: "turn.answer", path: "#work/task_synthetic" });
  expect(received[0]!.auth.claims.aud).toBe("https://push.example.test");
  expect(received[0]!.auth.claims.sub).toBe("https://hub.example.test");
  expect(received[0]!.auth.claims.exp).toBeGreaterThan(Date.now() / 1000);
  expect(received[0]!.auth.claims.exp).toBeLessThan(Date.now() / 1000 + 86400);
  const firstKey = received[0]!.auth.publicKey;
  expect(hub.modules.notifications.push.devices(owner)[0]!.last_success).toBeDefined();
  notifications.notify(event("synthetic-pending-restart"));
  await hub.stop(); await boot();
  hub.modules.notifications.notify(event()); await hub.modules.notifications.drain(); expect(received).toHaveLength(2);
  expect(hub.modules.notifications.push.key().public_key).toBe(firstKey);
  expect(hub.modules.notifications.push.devices(owner)[0]!.id).toBe(device.id);
});

test("AI quota push carries only the connection title, event type, and settings link", async () => {
  await subscribe();
  const notice = { ...event("synthetic-quota-alert", "ai.quota_low"), title: "Synthetic connection", path: "#settings/ai" };
  hub.modules.notifications.notify(notice);
  hub.modules.notifications.notify(notice);
  await hub.modules.notifications.drain();
  expect(received.map(value => value.payload)).toEqual([{ kind: notice.kind, title: notice.title, path: notice.path }]);
});

test("preferences filter events; test notification targets only the calling human and bypasses event filters", async () => {
  const device = await subscribe();
  await request(`/v2/notifications/push/devices/${device.id}`, "PATCH", { events: [] });
  hub.modules.notifications.notify(event()); await hub.modules.notifications.drain(); expect(received).toHaveLength(0);
  const empty = PushTestResult.parse(await (await request("/v2/notifications/push/test", "POST", {}, other)).json()); expect(empty.delivered).toBe(false);
  const result = PushTestResult.parse(await (await request("/v2/notifications/push/test", "POST", {})).json()); expect(result.delivered).toBe(true);
  expect(received).toHaveLength(1); expect(received[0]!.payload).toEqual({ title: "Lumio", kind: "turn.review", path: "#settings" });
});

test("404/410 remove devices; other status/network failures retain sanitized last_error, then success clears it", async () => {
  for (const status of [404, 410]) {
    await subscribe(); serviceStatus = status;
    const result = PushTestResult.parse(await (await request("/v2/notifications/push/test", "POST", {})).json()); expect(result.delivered).toBe(false);
    expect(hub.modules.notifications.push.devices(owner)).toEqual([]);
  }
  await subscribe();
  for (const status of [400, 403, 429, 500]) {
    serviceStatus = status;
    const response = await request("/v2/notifications/push/test", "POST", {}); noSecrets(await response.json());
    expect(hub.modules.notifications.push.devices(owner)[0]!.last_error).toBe(`Push service HTTP ${status}`);
  }
  failNetwork = true;
  noSecrets(await (await request("/v2/notifications/push/test", "POST", {})).json());
  expect(hub.modules.notifications.push.devices(owner)[0]!.last_error).toBe("Push delivery failed");
  noSecrets(await (await request("/v2/notifications/push/devices")).json());
  noSecrets(logs); noSecrets(hub.store.db.query("SELECT * FROM audit").all());
  failNetwork = false; serviceStatus = 201;
  await request("/v2/notifications/push/test", "POST", {});
  expect(hub.modules.notifications.push.devices(owner)[0]!.last_error).toBeUndefined();
});

test("committed hand-back records notify answer/review/failed once; todo and replayed results never notify", async () => {
  await subscribe();
  for (const status of ["done", "waiting_for_human", "failed", "unknown", "cancelled"] as const) {
    const created = await command("work.task.create", { title: "Synthetic task", description: "Secret description must never be pushed" });
    if (created.kind !== "task") throw new Error("task expected");
    await hub.modules.notifications.drain();
    const before = received.length;
    const started = await command("work.task.dispatch", { task: created.task.id, to: "pi@server" });
    if (started.kind !== "job") throw new Error("job expected");
    await request("/v1/runtime/ack", "POST", { accepted: [started.job.spec.id] }, runtime);
    const result = { job: started.job.spec.id, lease: started.job.spec.lease, status, finished: new Date().toISOString(), report: "Secret report", ...(status === "waiting_for_human" ? { question: "Secret question" } : {}) };
    expect((await request("/v1/runtime/results", "POST", result, runtime)).status).toBe(200);
    await hub.modules.notifications.drain();
    if (status === "cancelled") expect(received).toHaveLength(before);
    else {
      expect(received).toHaveLength(before + 1);
      expect(received.at(-1)!.payload).toEqual({ title: "Synthetic task", kind: status === "done" ? "turn.review" : status === "waiting_for_human" ? "turn.answer" : "turn.failed", path: `#work/${created.task.id}` });
    }
    expect((await request("/v1/runtime/results", "POST", result, runtime)).status).toBe(200);
    await hub.modules.notifications.drain(); expect(received.length).toBe(before + (status === "cancelled" ? 0 : 1));
    const current = hub.modules.work.task(created.task.id);
    await command("work.task.hand", { task: current.id, expected_revision: current.revision, to: "human" });
    await hub.modules.notifications.drain(); expect(received.length).toBe(before + (status === "cancelled" ? 0 : 1));
  }
});

test("new pending proposals notify once; idempotent proposal requests and rolled back transactions do not notify", async () => {
  await subscribe();
  const task = await command("work.task.create", { title: "Synthetic approval title" }); if (task.kind !== "task") throw new Error("task expected");
  const args = { task: task.task.id, to: "pi@server" }, requestId = "synthetic-proposal-replay";
  await command("work.task.dispatch", args, agent, requestId); await command("work.task.dispatch", args, agent, requestId);
  await hub.modules.notifications.drain(); expect(received).toHaveLength(1);
  expect(received[0]!.payload).toEqual({ title: "Synthetic approval title", kind: "proposal.pending", path: "#approvals" });
  const notifications = hub.modules.notifications;
  expect(() => hub.store.db.transaction(() => { notifications.notify(event("rolled-back-event")); throw new Error("rollback"); })()).toThrow();
  const otherTask = await command("work.task.create", { title: "Rolled back proposal" }); if (otherTask.kind !== "task") throw new Error("task expected");
  hub.store.db.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  try {
    const response = await request("/v2/work/commands", "POST", { request_id: "synthetic-rollback-request", operation: { op: "work.task.dispatch", args: { task: otherTask.task.id, to: "pi@server" } } }, agent);
    expect(response.status).toBe(500);
  } finally { hub.store.db.exec("DROP TRIGGER synthetic_audit_failure"); }
  await notifications.drain(); expect(received).toHaveLength(1);
  expect(hub.store.proposals("pending")).toHaveLength(1);
});

test("outbox fans out through pluggable channels once and isolates channel failures", async () => {
  const seen: string[] = [];
  const notifications = new Notifications(hub.store, temp, {}, [
    { id: "synthetic-future-channel", async send(event) { seen.push(event.id); throw new Error("synthetic failure"); } },
    { id: "synthetic-second-channel", async send(event) { seen.push(event.id); } },
  ]);
  notifications.notify(event()); notifications.notify(event()); await notifications.drain(); await notifications.drain();
  expect(seen).toEqual([event().id, event().id]); await notifications.stop();
});


test("background sender delivers committed events even when result reconciliation is temporarily broken", async () => {
  await subscribe();
  const reconcile = hub.modules.reconcile;
  hub.modules.reconcile = () => { throw new Error("synthetic unrelated recovery error"); };
  try {
    hub.modules.notifications.notify(event());
    const deadline = Date.now() + 3000;
    while (!received.length && Date.now() < deadline) await Bun.sleep(25);
    expect(received).toHaveLength(1);
  } finally { hub.modules.reconcile = reconcile; }
});

test("in-flight delivery does not resurrect a deleted device", async () => {
  const device = await subscribe();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const notifications = new Notifications(hub.store, temp, { subject: "https://hub.example.test", fetch: (async () => {
    entered(); await blocked; return new Response(null, { status: 201 });
  }) as unknown as typeof fetch });
  notifications.notify(event()); const sending = notifications.drain();
  await started;
  notifications.push.remove(owner, device.id);
  release(); await sending;
  expect(notifications.push.devices(owner)).toEqual([]);
  await notifications.stop();
});


test("VAPID always has an HTTPS sub: publicUrl wins and request Origin stays private", async () => {
  const origin = "https://fallback.example.test";
  await hub.stop(); await boot("https://hub.example.test", [origin]);
  const response = await request("/v2/notifications/push/devices", "POST", receiver.subscription, human, "en", origin);
  expect(response.status).toBe(200);
  const device = PushDevice.parse(await response.json()); expect(JSON.stringify(device)).not.toContain(origin);
  await request("/v2/notifications/push/test", "POST", {});
  expect(received.at(-1)!.auth.claims.sub).toBe("https://hub.example.test");
  expect(hub.store.db.query<{ origin: string }, []>("SELECT origin FROM notification_push_devices").get()?.origin).toBe(origin);
  // Drop the configured HTTPS address, keeping the private Origin across restart.
  await hub.stop(); await boot("http://hub.example.test", [origin]);
  expect(PushTestResult.parse(await (await request("/v2/notifications/push/test", "POST", {})).json()).delivered).toBe(true);
  expect(received.at(-1)!.auth.claims.sub).toBe(origin);
  const views = await (await request("/v2/notifications/push/devices")).json();
  expect(JSON.stringify(views)).not.toContain(origin);
  expect(JSON.stringify(logs)).not.toContain(origin);
  expect(JSON.stringify(hub.store.db.query("SELECT * FROM audit").all())).not.toContain(origin);
});

test("without HTTPS publicUrl, subscribing requires an HTTPS Origin and gives a clear localized error", async () => {
  const origin = "https://fallback.example.test";
  await hub.stop(); await boot("", [origin]);
  for (const [language, pattern] of [["en", /Set LUMIO_PUBLIC_URL/], ["zh", /请将 LUMIO_PUBLIC_URL/]] as const) {
    const response = await request("/v2/notifications/push/devices", "POST", receiver.subscription, human, language);
    expect(response.status).toBe(400); const error = ApiError.parse(await response.json()); expect(error.error.code).toBe("INVALID"); expect(error.error.message).toMatch(pattern); noSecrets(error);
  }
  expect(hub.modules.notifications.push.devices(owner)).toEqual([]);
  const fallback = await request("/v2/notifications/push/devices", "POST", receiver.subscription, human, "en", origin);
  expect(fallback.status).toBe(200); PushDevice.parse(await fallback.json());
  expect(PushTestResult.parse(await (await request("/v2/notifications/push/test", "POST", {})).json()).delivered).toBe(true);
  expect(received.at(-1)!.auth.claims.sub).toBe(origin);
  expect(() => hub.modules.notifications.push.subscribe(owner, receiver.subscription, "", "http://fallback.example.test")).toThrow();
  expect(() => hub.modules.notifications.push.subscribe(owner, receiver.subscription, "", "https://fallback.example.test/path")).toThrow();
});

test("old subscription tables gain the private Origin column without exposing it", async () => {
  await subscribe(); await hub.stop();
  const store = await HubStore.open(temp);
  store.db.exec("ALTER TABLE notification_push_devices DROP COLUMN origin"); store.close();
  await boot();
  expect(hub.modules.notifications.push.devices(owner)).toHaveLength(1);
  expect(PushTestResult.parse(await (await request("/v2/notifications/push/test", "POST", {})).json()).delivered).toBe(true);
  expect(received.at(-1)!.auth.claims.sub).toBe("https://hub.example.test");
});

test("automatic plan handoffs notify checkpoints and end once, while agent-to-agent advances stay silent", async () => {
  await subscribe();
  const created = await command("work.task.create", { title: "Synthetic planned notification" });
  if (created.kind !== "task") throw new Error("task expected");
  const task = created.task.id;
  await command("work.task.plan.set", { task, expected_revision: created.task.revision, plan: { stages: [
    { kind: "agent", id: "implement", agent: "pi@server", instruction: "Synthetic implementation" },
    { kind: "agent", id: "review", agent: "pi@server", instruction: "Synthetic review" },
    { kind: "checkpoint", id: "approve", prompt: "Secret checkpoint prompt" },
    { kind: "agent", id: "merge", agent: "pi@server", instruction: "Synthetic merge" },
  ] } });
  const started = await command("work.task.dispatch", { task }); if (started.kind !== "job") throw new Error("job expected");
  async function finishRound(job: string) {
    const spec = hub.store.executionStore.get(job)!.spec;
    expect((await request("/v1/runtime/ack", "POST", { accepted: [job] }, runtime)).status).toBe(200);
    const result = { job, lease: spec.lease, status: "done", finished: new Date().toISOString(), report: "Secret synthetic report" };
    expect((await request("/v1/runtime/results", "POST", result, runtime)).status).toBe(200);
    await hub.modules.notifications.drain();
    // Retried result and reconciliation cannot enqueue the same handoff twice.
    expect((await request("/v1/runtime/results", "POST", result, runtime)).status).toBe(200);
    hub.modules.reconcile(); await hub.modules.notifications.drain();
  }
  await finishRound(started.job.spec.id);
  expect(hub.modules.work.task(task).turn).toMatchObject({ holder: "pi@server", stage: "review", reason: "working" });
  expect(received).toEqual([]);
  const second = hub.modules.work.detail(task).executions.at(-1)!.job;
  await finishRound(second);
  expect(received).toHaveLength(1);
  expect(received[0]!.payload).toEqual({ title: "Synthetic planned notification", kind: "turn.review", path: `#work/${task}` });
  expect(WorkAttention.array().parse(await (await request("/v2/work/attention")).json())[0]).toMatchObject({ task, stage: "approve" });
  await command("work.task.checkpoint", { task, stage: "approve", action: "continue" });
  await hub.modules.notifications.drain(); expect(received).toHaveLength(1);
  await finishRound(hub.modules.work.detail(task).executions.at(-1)!.job);
  expect(hub.modules.work.task(task).turn).toMatchObject({ holder: "human", reason: "review", stage: "end" });
  expect(received).toHaveLength(2);
  const turns = hub.modules.work.detail(task).turns.filter(change => change.to.holder === "human" && change.to.reason === "review");
  expect(turns.map(change => change.to.stage)).toEqual(["approve", "end"]);
  expect(turns.every(change => change.by === hub.store.workActor().id)).toBe(true);
});

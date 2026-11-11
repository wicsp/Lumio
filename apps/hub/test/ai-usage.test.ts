import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIConnection, AIConfigurationDelete, AIQuotaView, AIQuotaViews, AliyunBillingUpdate, ClaudeQuotaBindings, ClaudeQuotaSample, NativeRuntimeCommand, NativeRuntimeMessage, NotificationEvent, RuntimeRegistration } from "@lumio/schema";
import balanceFixture from "../../../fixtures/ai-usage/deepseek.json";
import aliyunFixture from "../../../fixtures/ai-usage/aliyun.json";
import { aliyunBalanceUrl } from "../src/aliyun-billing.ts";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";

async function fixture(quotaFetch?: typeof fetch) {
  const state = await mkdtemp(join(tmpdir(), "lumio-hub-quota-"));
  const config = readConfig({ LUMIO_STATE_DIR: state, LUMIO_HUB_LISTEN: "127.0.0.1:0" });
  let clock = new Date("2026-11-10T01:00:00Z");
  const start = () => startHub(config, { quotaFetch, now: () => clock, log: () => {} });
  let hub = await start();
  const actor = (name: string, role: "human" | "runtime" | "agent") => {
    const identity = hub.store.createActor(name, role);
    const token = hub.store.createToken(name, identity.name);
    if (role === "runtime") hub.store.registerRuntime(identity.id, RuntimeRegistration.parse({
      name, protocol_version: 2, engines: [], tags: [], max_concurrent: 1,
    }), clock);
    return { id: identity.id, token };
  };
  const owner = actor("fixture-owner", "human"), outsider = actor("fixture-outsider", "human"), agent = actor("fixture-agent", "agent");
  const request = (path: string, method = "GET", body?: unknown, token = owner.token) => fetch(new URL(path, hub.server.url), {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const connection = async (body: unknown) => AIConnection.parse(await (await request("/v2/ai/connections", "POST", body)).json());
  const notices = () => hub.store.db.query<{ event: string }, []>("SELECT event FROM notification_events").all()
    .map(row => NotificationEvent.parse(JSON.parse(row.event))).filter(event => event.kind === "ai.quota_low");
  return {
    actor, owner, outsider, agent, request, connection, notices,
    get hub() { return hub; },
    now: () => clock,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    restart: async () => { await hub.stop(); hub = await start(); },
    close: async () => { await hub.stop(); await rm(state, { force: true, recursive: true }); },
  };
}

const api = { name: "Synthetic DeepSeek", kind: "deepseek", host: "hub", base_url: "https://api.deepseek.com/v1", api_key: "${secret:synthetic-deepseek}" };
const path = (id: string, action: string) => `/v2/ai/connections/${id}/usage/${action}`;
const parseView = async (response: Response) => {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return AIQuotaView.parse(await response.json());
};

const aliyunApi = { name: "Synthetic Alibaba Cloud", kind: "openai-compatible", host: "hub",
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_key: "${secret:synthetic-dashscope}" };
const aliyunCredentials = { site: "china", access_key_id: "fixture+id", access_key_secret: "fixture-secret" } as const;

test("Alibaba Cloud signs the canonical BSS RPC request and sends no secret in the URL", () => {
  const url = new URL(aliyunBalanceUrl(aliyunCredentials, new Date("2026-11-10T01:00:00.234Z"), "00000000-0000-4000-8000-000000000000"));
  expect(url.origin).toBe("https://business.aliyuncs.com");
  expect(url.searchParams.get("Action")).toBe("QueryAccountBalance");
  expect(url.searchParams.get("Signature")).toBe("VMyrx7Jjgf9YQ/ia9WCa3FSgfI8=");
  expect(url.href).not.toContain(aliyunCredentials.access_key_secret);
});

test("Alibaba Cloud billing is private, manual, and clears revoked readings", async () => {
  let calls = 0;
  let mode: "ready" | "transient" | "revoked" = "ready";
  const f = await fixture((async (input, options) => {
    calls++;
    const url = new URL(String(input));
    expect(url.origin).toBe("https://business.ap-southeast-1.aliyuncs.com");
    expect(url.searchParams.get("AccessKeyId")).toBe(aliyunCredentials.access_key_id);
    expect(options?.redirect).toBe("error");
    expect(url.href).not.toContain(aliyunApi.api_key);
    if (mode === "transient") throw new DOMException("fixture timeout", "TimeoutError");
    if (mode === "revoked") return Response.json({ Success: false, Code: "NoPermission", Message: aliyunCredentials.access_key_secret }, { status: 400 });
    return Response.json(aliyunFixture);
  }) as typeof fetch);
  try {
    const connection = await f.connection(aliyunApi);
    const other = await f.connection({ ...aliyunApi, base_url: "https://fixture.example.test/compatible-mode/v1" });
    const billing = path(connection.id, "aliyun-billing"), refresh = path(connection.id, "refresh");
    const read = async () => AIQuotaViews.parse(await (await f.request("/v2/ai/usage")).json()).find(view => view.connection === connection.id);
    expect(await read()).toMatchObject({ aliyun_billing_configured: false, status: "credentials" });
    const credentials = AliyunBillingUpdate.parse({ ...aliyunCredentials, site: "international" });
    expect((await f.request(billing, "PUT", credentials, f.outsider.token)).status).toBe(404);
    expect((await f.request(billing, "PUT", credentials, f.agent.token)).status).toBe(403);
    expect((await f.request(path(other.id, "aliyun-billing"), "PUT", credentials)).status).toBe(400);
    const configured = await parseView(await f.request(billing, "PUT", credentials));
    expect(configured).toMatchObject({ aliyun_billing_configured: true, status: "waiting" });
    expect(JSON.stringify(configured)).not.toContain(aliyunCredentials.access_key_secret);
    expect(JSON.stringify(configured)).not.toContain(aliyunCredentials.access_key_id);
    expect((await f.request(path(connection.id, "settings"), "PUT", { monitor: true, thresholds: {} })).status).toBe(400);
    expect(calls).toBe(0);
    const first = await parseView(await f.request(refresh, "POST"));
    expect(first.status).toBe("ready");
    expect(first.snapshot).toMatchObject({ source: "aliyun-billing", currency: "JPY", cash_balance: "9007199254740993.01", available_amount: "-23.40" });
    await f.restart();
    expect(await read()).toEqual(first);
    mode = "transient";
    expect(await parseView(await f.request(refresh, "POST"))).toMatchObject({ status: "error", snapshot: first.snapshot });
    mode = "revoked";
    const revoked = await parseView(await f.request(refresh, "POST"));
    expect(revoked.status).toBe("credentials");
    expect(revoked.snapshot).toBeUndefined();
    expect(JSON.stringify(revoked)).not.toContain(aliyunCredentials.access_key_secret);
    const cleared = await parseView(await f.request(billing, "PUT", AliyunBillingUpdate.parse({ clear: true })));
    expect(cleared.aliyun_billing_configured).toBe(false);
    expect(cleared.snapshot).toBeUndefined();
    expect(calls).toBe(3);
  } finally { await f.close(); }
});

test("Alibaba Cloud rotation rejects late results and changing the endpoint or deleting clears the binding", async () => {
  const held = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const f = await fixture((async input => {
    if (new URL(String(input)).searchParams.get("AccessKeyId") === aliyunCredentials.access_key_id) {
      started.resolve();
      await held.promise;
      return Response.json({ ...aliyunFixture, Data: { ...aliyunFixture.Data, AvailableCashAmount: "123.00" } });
    }
    return Response.json(aliyunFixture);
  }) as typeof fetch);
  try {
    const connection = await f.connection(aliyunApi);
    const billing = path(connection.id, "aliyun-billing"), refresh = path(connection.id, "refresh");
    await parseView(await f.request(billing, "PUT", aliyunCredentials));
    const pending = f.request(refresh, "POST");
    await started.promise;
    await parseView(await f.request(billing, "PUT", { ...aliyunCredentials, access_key_id: "fixture-new-id" }));
    const current = await parseView(await f.request(refresh, "POST"));
    expect(current.snapshot).toMatchObject({ cash_balance: aliyunFixture.Data.AvailableCashAmount });
    held.resolve();
    expect(await parseView(await pending)).toEqual(current);
    const url = `/v2/ai/connections/${connection.id}`;
    const edit = await f.request(url, "PUT", { ...aliyunApi, base_url: "https://fixture.example.test/v1" });
    expect(edit.status).toBe(200);
    expect((await f.request(billing, "PUT", aliyunCredentials)).status).toBe(400);
    const editedBack = AIConnection.parse(await (await f.request(url, "PUT", aliyunApi)).json());
    const missing = await parseView(await f.request(refresh, "POST"));
    expect(missing.aliyun_billing_configured).toBe(false);
    expect(missing.snapshot).toBeUndefined();
    await parseView(await f.request(billing, "PUT", aliyunCredentials));
    expect((await f.request(url, "DELETE", AIConfigurationDelete.parse({
      request_id: crypto.randomUUID(), expected_revision: editedBack.revision,
    }))).status).toBe(200);
    expect(f.hub.store.db.query("SELECT 1 FROM ai_aliyun_billing WHERE connection=?").get(connection.id)).toBeNull();
  } finally { held.resolve(); await f.close(); }
});

test("DeepSeek queries only the official fixed endpoint, merges concurrent refreshes, and invalidates on credential changes", async () => {
  let calls = 0;
  let mode: "ready" | "error" | "hold" = "ready";
  const held = Promise.withResolvers<void>();
  const fetcher = (async (url, options) => {
    calls++;
    expect(String(url)).toBe("https://api.deepseek.com/user/balance");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("Authorization")).toBe(`Bearer ${api.api_key}`);
    if (mode === "error") return new Response("synthetic upstream error", { status: 429 });
    if (mode === "hold") await held.promise;
    return Response.json(balanceFixture);
  }) as typeof fetch;
  const f = await fixture(fetcher);
  try {
    const connection = await f.connection(api);
    const custom = await f.connection({ ...api, base_url: "https://api.deepseek.com.fixture.test/v1" });
    const refresh = path(connection.id, "refresh");
    expect((await parseView(await f.request(path(custom.id, "refresh"), "POST"))).status).toBe("unsupported");
    expect((await f.request(refresh, "POST", undefined, f.outsider.token)).status).toBe(404);
    expect((await f.request("/v2/ai/usage", "GET", undefined, f.agent.token)).status).toBe(403);
    expect(AIQuotaViews.parse(await (await f.request("/v2/ai/usage", "GET", undefined, f.outsider.token)).json())).toEqual([]);
    expect(calls).toBe(0);
    mode = "hold";
    const pending = Promise.all([f.request(refresh, "POST"), f.request(refresh, "POST")]);
    await Bun.sleep(35);
    held.resolve();
    const [first, second] = await Promise.all((await pending).map(parseView));
    expect(calls).toBe(1);
    expect(first).toEqual(second);
    expect(first?.snapshot).toMatchObject({ source: "deepseek", balances: [{ currency: "CNY", total: "8.40" }, { currency: "USD", total: "12.30" }] });
    expect(JSON.stringify(first)).not.toContain(api.api_key);
    mode = "error";
    f.advance(1000);
    const failed = await parseView(await f.request(refresh, "POST"));
    expect(failed.status).toBe("error");
    expect(failed.snapshot).toEqual(first?.snapshot);
    await f.request(`/v2/ai/connections/${connection.id}`, "PUT", { ...api, api_key: undefined, name: "Renamed" });
    expect((await parseView(await f.request(refresh, "POST"))).snapshot).toEqual(first?.snapshot);
    await f.request(`/v2/ai/connections/${connection.id}`, "PUT", { ...api, api_key: "${secret:rotated}" });
    const read = AIQuotaViews.parse(await (await f.request("/v2/ai/usage")).json()).find(view => view.connection === connection.id);
    expect(read).toMatchObject({ status: "waiting" });
    expect(read?.snapshot).toBeUndefined();
  } finally { await f.close(); }
});

test("enabled DeepSeek monitoring persists alert deduplication and alerts again after recovery", async () => {
  let total = "8.40";
  const f = await fixture((async (_url, _options) => Response.json({
    ...balanceFixture, balance_infos: [{ ...balanceFixture.balance_infos[0], total_balance: total }],
  })) as typeof fetch);
  try {
    const connection = await f.connection(api);
    const refresh = () => f.request(path(connection.id, "refresh"), "POST").then(parseView);
    await parseView(await f.request(path(connection.id, "settings"), "PUT", { monitor: true, thresholds: { CNY: "10" } }));
    f.hub.modules.native.usage.tick();
    for (let n = 0; !f.notices().length && n < 50; n++) await Bun.sleep(5);
    expect(f.notices()).toHaveLength(1);
    expect(f.notices()[0]).toMatchObject({ owner: f.owner.id, path: "#settings/ai" });
    await f.restart();
    f.advance(60_000);
    expect((await refresh()).attention).toBe(true);
    expect(f.notices()).toHaveLength(1);
    total = "10.00";
    f.advance(1000);
    expect((await refresh()).attention).toBe(false);
    total = "9.999999999999";
    f.advance(1000);
    expect((await refresh()).attention).toBe(true);
    expect(f.notices()).toHaveLength(2);
  } finally { await f.close(); }
});

test("Claude samples are owner- and Runtime-bound, reject old generations, and never refresh identical or older data", async () => {
  const f = await fixture();
  try {
    const runtime = f.actor("fixture-mac", "runtime"), other = f.actor("fixture-other-runtime", "runtime");
    const connection = await f.connection({ name: "Claude subscription", kind: "claude-code-subscription", host: "fixture-mac" });
    expect((await f.request("/v2/ai/profiles", "POST", { name: "not a model", connection: connection.id, engine: "lumio", model: "synthetic" })).status).toBe(400);
    const bind = () => f.request(path(connection.id, "bind"), "POST").then(parseView);
    const read = async () => AIQuotaViews.parse(await (await f.request("/v2/ai/usage")).json())[0]!;
    const report = "/v2/runtime/claude-usage";
    const send = (data: ClaudeQuotaSample, token = runtime.token) => f.request(report, "POST", data, token);
    const view = await bind();
    expect(view.status).toBe("waiting");
    const binding = view.claude_binding!;
    expect(ClaudeQuotaBindings.parse(await (await f.request(report, "GET", undefined, other.token)).json())).toEqual([]);
    expect(ClaudeQuotaBindings.parse(await (await f.request(report, "GET", undefined, runtime.token)).json())).toEqual([binding]);
    const settings = { monitor: true, thresholds: { remaining_percent: 10 } };
    await parseView(await f.request(path(connection.id, "settings"), "PUT", settings));
    const sample = ClaudeQuotaSample.parse({ ...binding, sampled_at: f.now().toISOString(),
      windows: [{ id: "five_hour", minutes: 300, used_percent: 95, resets_at: "2026-11-10T01:01:00Z" }] });
    expect((await send(sample, other.token)).status).toBe(404);
    expect((await send(sample, f.owner.token)).status).toBe(403);
    expect((await send(sample)).status).toBe(204);
    expect(await read()).toMatchObject({ status: "ready", attention: true, snapshot: { sampled_at: sample.sampled_at } });
    f.advance(1000);
    expect((await send({ ...sample, sampled_at: f.now().toISOString() })).status).toBe(204);
    expect((await read()).snapshot?.sampled_at).toBe(sample.sampled_at);
    f.advance(60_000);
    expect(await read()).toMatchObject({ status: "stale", attention: false });
    const next = ClaudeQuotaSample.parse({ ...sample, sampled_at: f.now().toISOString(),
      windows: [{ ...sample.windows[0], resets_at: "2026-11-10T06:00:00Z" }] });
    expect((await send(next)).status).toBe(204);
    expect((await send(sample)).status).toBe(204);
    expect((await read()).snapshot?.sampled_at).toBe(next.sampled_at);
    expect(f.notices()).toHaveLength(2);
    const rebound = await bind();
    expect(rebound.claude_binding?.generation).not.toBe(binding.generation);
    expect(rebound.snapshot).toBeUndefined();
    expect((await send(next)).status).toBe(404);
  } finally { await f.close(); }
});

test("Claude background quota refreshes every fifteen minutes without a browser and rejects account changes", async () => {
  const f = await fixture();
  try {
    const runtime = f.actor("fixture-mac", "runtime");
    const native = f.hub.modules.native;
    const connection = await f.connection({ name: "Claude subscription", kind: "claude-code-subscription", host: "fixture-mac" });
    const read = async () => AIQuotaViews.parse(await (await f.request("/v2/ai/usage")).json())[0]!;
    const account = "a".repeat(64);
    let observed = account;
    const requests: Extract<NativeRuntimeCommand, { type: "claude_usage" }>[] = [];
    const socket = {
      id: "fixture-socket", data: { runtime: runtime.id }, close() {}, terminate() {},
      send(line: string) {
        const command = NativeRuntimeCommand.parse(JSON.parse(line));
        if (command.type !== "claude_usage") return;
        requests.push(command);
        const reply = NativeRuntimeMessage.parse({
          type: "claude_usage", command: command.command, connection: command.connection, generation: command.generation,
          result: { status: "ready", account: observed, windows: [{ id: "five_hour", minutes: 300, used_percent: 63 }] },
        });
        queueMicrotask(() => native.channelMessage(socket, JSON.stringify(reply)));
      },
    };
    native.channelOpen(socket);
    native.channelMessage(socket, JSON.stringify({ type: "hello", protocol: 1, instance: "fixture",
      version: "fixture", isolation: "macos-seatbelt", claude_usage: true }));
    const first = await parseView(await f.request(path(connection.id, "settings"), "PUT", {
      claude_mode: "background", monitor: true, thresholds: {},
    }));
    const next = (ms: number) => {
      f.advance(ms);
      f.hub.store.registerRuntime(runtime.id, RuntimeRegistration.parse({
        name: "fixture-mac", protocol_version: 2, engines: [], tags: [], max_concurrent: 1,
      }), f.now());
      native.usage.tick();
    };
    next(15_000);
    expect((await read()).snapshot).toMatchObject({ source: "claude-code", collection: "background", sampled_at: f.now().toISOString() });
    expect(requests[0]).toMatchObject({ generation: first.claude_binding?.generation });
    expect(requests[0]?.account).toBeUndefined();
    next(14 * 60_000);
    expect(requests).toHaveLength(1);
    next(60_000);
    expect((await read()).snapshot?.sampled_at).toBe(f.now().toISOString());
    expect(requests[1]?.account).toBe(account);
    observed = "b".repeat(64);
    next(15 * 60_000);
    expect(await read()).toMatchObject({ status: "credentials", claude_issue: "account_changed" });
    expect((await read()).snapshot).toBeUndefined();
    next(15 * 60_000);
    expect(requests).toHaveLength(3);
    const rebound = await parseView(await f.request(path(connection.id, "bind"), "POST"));
    expect(rebound.claude_binding?.generation).not.toBe(first.claude_binding?.generation);
    expect((await f.request(path(connection.id, "refresh"), "POST", undefined, f.outsider.token)).status).toBe(404);
    next(15_000);
    expect((await read()).status).toBe("ready");
    expect(requests[3]?.account).toBeUndefined();
  } finally { await f.close(); }
});

import { expect, test } from "bun:test";
import { createClient } from "../src/index.ts";
import { PushDevice, PushSubscriptionInput } from "@lumio/schema";
const U = "00000000000000000000000001";
const input = PushSubscriptionInput.parse({ endpoint: "https://push.example.test/synthetic-secret", keys: { p256dh: "synthetic_public_key", auth: "synthetic_auth" }, label: "Synthetic phone" });
const device = PushDevice.parse({ id: `pdev_${U}`, owner: `act_${U}`, label: input.label, events: ["turn.answer"], created: "2026-11-05T00:00:00Z" });

test("push methods validate contracts, use the right HTTP methods and do not expose subscription secrets", async () => {
  const cases: { path: string; method: string; body?: unknown; result?: unknown; call(client: ReturnType<typeof createClient>): Promise<unknown> }[] = [
    { path: "/key", method: "GET", result: { public_key: "synthetic_vapid_public_key" }, call: client => client.pushKey() },
    { path: "/devices", method: "POST", body: input, result: device, call: client => client.subscribePush(input) },
    { path: "/devices", method: "GET", result: [device], call: client => client.pushDevices() },
    { path: `/devices/${device.id}`, method: "PATCH", body: { events: [] }, result: { ...device, events: [] }, call: client => client.updatePushDevice(device.id, { events: [] }) },
    { path: `/devices/${device.id}`, method: "DELETE", call: client => client.removePushDevice(device.id) },
    { path: "/test", method: "POST", body: {}, result: { delivered: true }, call: client => client.testPush() },
  ];
  for (const item of cases) {
    const client = createClient({ url: "https://hub.example.test", token: "synthetic", language: "zh", fetch: (async (url: URL, init: RequestInit) => {
      expect(url.pathname).toBe(`/v2/notifications/push${item.path}`); expect(init.method).toBe(item.method);
      expect(init.redirect).toBe("error"); expect(new Headers(init.headers).get("accept-language")).toBe("zh");
      expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(item.body);
      return item.result === undefined ? new Response(null, { status: 204 }) : Response.json(item.result);
    }) as unknown as typeof fetch });
    expect(await item.call(client)).toEqual(item.result);
    expect(() => client.updatePushDevice("bad/id", { events: [] })).toThrow();
    expect(() => client.updatePushDevice(device.id, {})).toThrow();
    expect(() => client.subscribePush({ ...input, endpoint: "http://push.example.test" })).toThrow();
  }
});

test("unexpected secret fields and malformed responses are rejected without echoing secrets", async () => {
  const client = createClient({ url: "https://hub.example.test", fetch: (async () => Response.json({ ...device, endpoint: input.endpoint, keys: input.keys })) as unknown as typeof fetch });
  try { await client.subscribePush(input); throw new Error("expected rejection"); }
  catch (cause) { expect(cause).toMatchObject({ code: "INTERNAL" }); expect(String(cause)).not.toContain(input.endpoint); expect(String(cause)).not.toContain(input.keys.auth); }
});

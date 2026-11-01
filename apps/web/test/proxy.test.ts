import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WebConfigError, parseWebConfig } from "../src/config.ts";
import { isAllowedRoute } from "../src/proxy.ts";
import { startWeb, type WebServer } from "../src/server.ts";

let hub: ReturnType<typeof Bun.serve>;
let web: WebServer;
const seen: Array<{ path: string; headers: Record<string, string>; body: string }> = [];

beforeAll(async () => {
  hub = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    seen.push({ path: url.pathname + url.search, headers: Object.fromEntries(request.headers), body: await request.text() });
    if (url.pathname === "/v1/runtimes") return Response.redirect("http://example.invalid/", 302);
    if (url.pathname === "/v2/assistant/chat") {
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":1}\n')); setTimeout(() => { c.enqueue(new TextEncoder().encode('{"b":2}\n')); c.close(); }, 50); } });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Set-Cookie": "x=1" } });
    }
    return Response.json({ ok: true }, { headers: { "Set-Cookie": "x=1" } });
  } });
  web = await startWeb({ hostname: "127.0.0.1", port: 0, hubUrl: `http://127.0.0.1:${hub.port}`, allowedOrigins: [] },
    { assets: { js: "console.log(1)", css: "" }, maxBodyBytes: 64 });
});
afterAll(async () => { await web.stop(); hub.stop(true); });

describe("config", () => {
  test("defaults", () => expect(parseWebConfig({})).toEqual({ hostname: "127.0.0.1", port: 4317, hubUrl: "http://127.0.0.1:7420", allowedOrigins: [] }));
  for (const bad of ["ftp://h:1", "http://u:p@h:1", "http://h:1/path", "http://h:1?q=1", "http://h:1#x", "nope"]) {
    test(`rejects ${bad}`, () => expect(() => parseWebConfig({ LUMIO_WEB_HUB_URL: bad })).toThrow(WebConfigError));
  }
  test("rejects malformed listen", () => expect(() => parseWebConfig({ LUMIO_WEB_LISTEN: "4317" })).toThrow(WebConfigError));
});

describe("allowlist", () => {
  test("allows needed user routes", () => {
    expect(isAllowedRoute("GET", "/v1/actors")).toBe(true);
    expect(isAllowedRoute("POST", "/v1/client/join")).toBe(true);
    expect(isAllowedRoute("POST", "/v1/proposals/prop_01JABCDEFGHJKMNPQRSTVWXYZ0/accept")).toBe(true);
  });
  test("rejects runtime, invite and archive routes", () => {
    for (const [m, p] of [["POST", "/v1/runtime/register"], ["POST", "/v1/client-invites"], ["POST", "/v1/runtime-invites"], ["DELETE", "/v1/runtimes/x"],
      ["POST", "/v2/execution/artifacts"], ["GET", "/v1/actors/../runtime/sync"], ["POST", "/v1/actors"]] as const) expect(isAllowedRoute(m, p)).toBe(false);
  });
});

describe("proxy", () => {
  const base = () => web.url;
  test("forwards only allowed headers and sets security headers", async () => {
    const res = await fetch(`${base()}/hub/v1/actors?x=1`, { headers: { Authorization: "Bearer t", Cookie: "s=1", "X-Forwarded-For": "1.2.3.4", Accept: "application/json" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const last = seen.at(-1)!;
    expect(last.path).toBe("/v1/actors?x=1");
    expect(last.headers.authorization).toBe("Bearer t");
    expect(last.headers.cookie).toBeUndefined();
    expect(last.headers["x-forwarded-for"]).toBeUndefined();
  });
  test("unknown path is 404 without contacting hub", async () => {
    const count = seen.length;
    expect((await fetch(`${base()}/hub/v1/runtime/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(404);
    expect(seen.length).toBe(count);
  });
  test("cross-site origin is denied", async () => {
    const res = await fetch(`${base()}/hub/v1/actors`, { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
  test("same origin is accepted", async () => {
    expect((await fetch(`${base()}/hub/v1/actors`, { headers: { Origin: base() } })).status).toBe(200);
  });
  test("oversized body is rejected", async () => {
    const res = await fetch(`${base()}/hub/v2/work/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x: "y".repeat(200) }) });
    expect(res.status).toBe(413);
  });
  test("non-JSON body is rejected", async () => {
    expect((await fetch(`${base()}/hub/v2/work/commands`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
  });
  test("upstream redirect becomes 502", async () => {
    const res = await fetch(`${base()}/hub/v1/runtimes`);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("example.invalid");
  });
  test("NDJSON streams through", async () => {
    const res = await fetch(`${base()}/hub/v2/assistant/chat`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: "{}" });
    expect(res.headers.get("content-type")).toContain("ndjson");
    expect(await res.text()).toBe('{"a":1}\n{"b":2}\n');
  });
  test("serves page with CSP and rejects foreign Host", async () => {
    const page = await fetch(`${base()}/`);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html=await page.text();
    expect(html).toContain("/assets/app.js");
    expect(html).toContain(`name="lumio-hub" content="http://127.0.0.1:${hub.port}"`);
  });
});

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, WorkTask } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const web = { files: new Map([["/", { body: "<!doctype html><title>Lumio</title>", type: "text/html; charset=utf-8" }], ["/assets/app.js", { body: "console.log('synthetic')", type: "text/javascript" }]]), csp: "default-src 'none'" };
test("Hub serves injected files without changing API authentication or contracts; responses prohibit caching", async () => {
  const state = await mkdtemp(join(tmpdir(), "lumio-web-hub-")); roots.push(state);
  const hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: state }), port: 0 }, { web, log() {} });
  const base = `http://127.0.0.1:${hub.server.port}`;
  try {
    const actor = hub.store.createActor("synthetic", "human"), token = hub.store.createToken("synthetic", actor.name);
    for (const path of ["/", "/assets/app.js"]) {
      const response = await fetch(base + path, { headers: { "Sec-Fetch-Site": "same-origin" } });
      expect(response.status).toBe(200); expect(response.headers.get("content-security-policy")).toBe(web.csp);
      expect(response.headers.get("x-frame-options")).toBe("DENY"); expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(await (await fetch(base + "/", { method: "HEAD" })).text()).toBe("");
    const denied = await fetch(base + "/v2/work/tasks"); expect(denied.status).toBe(401); ApiError.parse(await denied.json()); expect(denied.headers.get("cache-control")).toBe("no-store");
    const tasks = await fetch(base + "/v2/work/tasks", { headers: { Authorization: `Bearer ${token}` } }); expect(tasks.status).toBe(200); WorkTask.array().parse(await tasks.json());
  } finally { await hub.stop(); }
});
test("Origin and Host independently require local/public/extra sources; header-free CLI/runtime requests keep token behavior", async () => {
  const state = await mkdtemp(join(tmpdir(), "lumio-web-origin-")); roots.push(state);
  const hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: state, LUMIO_PUBLIC_URL: "https://public.synthetic", LUMIO_WEB_ORIGINS: "https://extra.synthetic:8443" }), port: 0 }, { web, log() {} });
  const base = `http://127.0.0.1:${hub.server.port}`;
  try {
    for (const origin of [base, "https://public.synthetic", "https://extra.synthetic:8443"]) {
      expect((await fetch(base + "/", { headers: { Origin: origin, Host: new URL(origin).host } })).status).toBe(200);
    }
    for (const headers of ([{ Origin: "https://evil.synthetic" }, { Origin: base, Host: "evil.synthetic" }, { "Sec-Fetch-Site": "same-origin", Host: "evil.synthetic" }, { Origin: "null" }, { Origin: "https://public.synthetic.evil" }] as Record<string, string>[])) {
      const response = await fetch(base + "/health", { headers }); expect(response.status).toBe(403); ApiError.parse(await response.json());
    }
    expect((await fetch(base + "/health", { headers: { Host: "cli.synthetic" } })).status).toBe(200);
    expect((await fetch(base + "/v2/work/tasks", { headers: { Host: "runtime.synthetic" } })).status).toBe(401);
  } finally { await hub.stop(); }
});
test("Hub without Web options returns 404 at root; malformed origins fail configuration without echoing values", async () => {
  const state = await mkdtemp(join(tmpdir(), "lumio-no-web-")); roots.push(state);
  const hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: state }), port: 0 }, { log() {} });
  try { expect((await fetch(`http://127.0.0.1:${hub.server.port}/`)).status).toBe(404); } finally { await hub.stop(); }
  for (const origin of ["null", "file:///tmp", "https://user:secret@synthetic", "https://synthetic/path"]) expect(() => readConfig({ LUMIO_WEB_ORIGINS: origin })).toThrow("INVALID");
});
test("browser extension origins pass with an allowed Host and still require a valid token", async () => {
  const state = await mkdtemp(join(tmpdir(), "lumio-web-extension-")); roots.push(state);
  const hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: state }), port: 0 }, { log() {} });
  const endpoint = new URL("/v2/work/tasks", hub.server.url);
  try {
    const actor = hub.store.createActor("extension-user", "human");
    const token = hub.store.createToken("extension-user", actor.name);
    for (const Origin of ["chrome-extension://abcdefghijklmnopabcdefghijklmnop", "moz-extension://12345678-1234-4321-abcd-123456789abc"]) {
      const unauthorized = await fetch(endpoint, { headers: { Origin } });
      expect(unauthorized.status).toBe(401);
      expect(ApiError.parse(await unauthorized.json()).error.code).toBe("UNAUTHENTICATED");
      const headers = { Origin, Authorization: `Bearer ${token}` };
      const authorized = await fetch(endpoint, { headers });
      expect(authorized.status).toBe(200);
      WorkTask.array().parse(await authorized.json());
      const wrongHost = await fetch(endpoint, { headers: { ...headers, Host: "evil.synthetic" } });
      expect(wrongHost.status).toBe(403);
      expect(ApiError.parse(await wrongHost.json()).error.code).toBe("FORBIDDEN");
    }
  } finally { await hub.stop(); }
});

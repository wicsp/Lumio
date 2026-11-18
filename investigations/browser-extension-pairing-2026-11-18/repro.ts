/** Investigation only: isolated Hub, synthetic credentials, no production access. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { startHub } from "../../apps/hub/src/server.ts";
import { readConfig } from "../../apps/hub/src/config.ts";
import { Pairing } from "../../apps/hub/src/pairing.ts";
import { browserAllowed } from "../../apps/hub/src/web.ts";

const repo = resolve(import.meta.dir, "../..");
const extensionRequire = createRequire(join(repo, "apps/chrome-ext/package.json"));
const { ClientInvite, ClientJoin, CaptureCreateResult } = await import(extensionRequire.resolve("@lumio/schema"));
const { createClient } = await import(extensionRequire.resolve("@lumio/api-client"));
const scratch = await mkdtemp(join(import.meta.dir, "scratch-"));
const state = join(scratch, "state"), vault = join(scratch, "vault");
await cp(join(repo, "fixtures/query-vault"), vault, { recursive: true });
await mkdir(join(scratch, "home"));
let now = Date.parse("2026-11-18T00:00:00Z");
const logs: string[] = [];
const config = { ...readConfig({ LUMIO_STATE_DIR: state, LUMIO_VAULT: vault,
  HOME: join(scratch, "home"), LUMIO_WATCHDOG_INTERVAL_MINUTES: "0" }), port: 0 };
let hub = await startHub(config, { now: () => new Date(now), log: line => logs.push(line) });
const base = () => `http://127.0.0.1:${hub.server.port}`;
const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const emit = (label: string, data: unknown) => console.log(JSON.stringify({ label, data }));
const used = (code: string) => hub.store.db.query<{ used: number }, [string]>(
  "SELECT used FROM pairing_codes WHERE hash=?").get(createHash("sha256").update(code).digest("hex"))!.used;

// Minimal DOM/Chrome adapters execute the real options bundle. They do not model
// Chrome's network security, TLS stack, or permissions UI.
async function runOptions(bundle: string, code: string) {
  const ids = new Map<string, Element>(), forms: Element[] = [];
  class Element {
    children: any[] = [];
    listeners = new Map<string, Function>();
    value = "";
    disabled = false;
    constructor(readonly tag: string) { if (tag === "form") forms.push(this); }
    setAttribute(name: string, value: string) {
      if (name === "id") ids.set(value, this);
      if (name === "value") this.value = value;
    }
    addEventListener(name: string, fn: Function) { this.listeners.set(name, fn); }
    append(child: any) { this.children.push(child); }
    replaceChildren(...children: any[]) { this.children = children; }
    text(): string { return this.children.map(x => typeof x === "string" ? x : x.text()).join(" "); }
  }
  const root = new Element("root"); ids.set("root", root);
  let saved: any;
  const calls: { path: string; status: number }[] = [];
  const context = {
    document: { getElementById: (id: string) => ids.get(id), createElement: (tag: string) => new Element(tag) },
    chrome: {
      i18n: { getUILanguage: () => "en" },
      storage: { local: { get: async () => ({}), set: async (value: any) => { saved = value; }, remove: async () => {} } },
      permissions: { request: async () => true },
    },
    URL, FormData, Uint8Array, crypto, console,
    fetch: async (url: URL, init: RequestInit) => {
      const response = await fetch(url, { ...init, headers: { ...init.headers, Origin: origin } });
      calls.push({ path: url.pathname, status: response.status });
      return response;
    },
  };
  runInNewContext(bundle, context);
  await Bun.sleep(5);
  ids.get("hub")!.value = base(); ids.get("code")!.value = code;
  forms[0]!.listeners.get("submit")!({ preventDefault() {} });
  const deadline = Date.now() + 5000;
  while (!saved && !root.text().includes("expired") && Date.now() < deadline) await Bun.sleep(10);
  assert.ok(saved || root.text().includes("expired"), "options flow did not finish");
  return { calls, saved: !!saved, text: root.text() };
}

try {
  const actor = hub.store.createActor("synthetic-owner", "human");
  const human = hub.store.createToken("synthetic-owner", actor.name);
  const client = () => createClient({ url: base(), token: human });
  const invitation = ClientInvite.parse(await client().clientInvite("browser@2026-11-18"));
  assert.equal(Date.parse(invitation.expires) - now, 600_000);
  const oldBundle = await readFile(join(repo, "apps/chrome-ext/dist/options.js"), "utf8");
  emit("old-bundle", { sha256: createHash("sha256").update(oldBundle).digest("hex"),
    oldJoin: oldBundle.includes('"/v1/client/join"'), newJoin: oldBundle.includes('"/v2/setup/client/join"') });
  const old = await runOptions(oldBundle, invitation.code);
  assert.deepEqual(old.calls, [{ path: "/v1/client/join", status: 401 }]);
  assert.equal(old.saved, false); assert.equal(used(invitation.code), 0);
  emit("old-options", { ...old, codeUsed: used(invitation.code) });
  const oldResponse = await fetch(base() + "/v1/client/join", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ code: invitation.code }) });
  emit("old-endpoint-body", { status: oldResponse.status, body: await oldResponse.json() });
  const built = await Bun.build({ entrypoints: [join(repo, "apps/chrome-ext/src/options.ts")], target: "browser", format: "esm", minify: true, write: false });
  assert.ok(built.success);
  const fresh = await runOptions(await built.outputs[0]!.text(), invitation.code);
  assert.deepEqual(fresh.calls, [{ path: "/v2/setup/client/join", status: 200 }]);
  assert.equal(fresh.saved, true); assert.equal(used(invitation.code), 1);
  emit("fresh-options-same-code", { calls: fresh.calls, saved: fresh.saved, codeUsed: used(invitation.code), elapsedMs: 0 });

  // A GET is not a preview and cannot consume a code.
  const preview = await client().clientInvite("preview-test");
  const get = await fetch(base() + "/v2/setup/client/join");
  assert.equal(used(preview.code), 0);
  emit("get-not-preview", { status: get.status, codeUsed: used(preview.code) });
  await createClient({ url: base() }).clientJoin(preview.code);

  const first = await client().clientInvite("same-label");
  const second = await client().clientInvite("same-label");
  assert.equal(used(first.code), 1);
  try { await createClient({ url: base() }).clientJoin(first.code); assert.fail("superseded code accepted"); }
  catch (e: any) { assert.equal(e.status, 401); }
  const joined = ClientJoin.parse(await createClient({ url: base() }).clientJoin(second.code));
  emit("same-label-invalidation", { olderCodeUsed: used(first.code), newerJoin: "success" });
  const captured = CaptureCreateResult.parse(await createClient({ url: base(), token: joined.token }).capture({
    request_id: "investigation-synthetic-page", channel: "extension", url: "https://example.com/synthetic",
    title: "Synthetic page", content: { format: "html", body: "<html><body><article><h1>Synthetic page</h1><p>Fixture-only capture for pairing investigation.</p></article></body></html>" },
  }));
  assert.ok(captured.capture.id);
  emit("clip-after-pairing", { state: captured.capture.state, duplicate: captured.duplicate });
  const replacement = await client().clientInvite("same-label");
  await createClient({ url: base() }).clientJoin(replacement.code);
  assert.equal(hub.store.authenticate(`Bearer ${joined.token}`), null);
  emit("same-label-token-revocation", { previousTokenValid: false });

  const persisted = await client().clientInvite("restart-test");
  await hub.stop(); hub = await startHub(config, { now: () => new Date(now), log: line => logs.push(line) });
  await createClient({ url: base() }).clientJoin(persisted.code);
  emit("restart-persistence", { join: "success" });

  // Direct Pairing instances use the same real isolated SQLite store and clock.
  const identity = hub.store.authenticate(`Bearer ${human}`)!;
  const p = new Pairing(hub.store, {}, base, () => new Date(now));
  const ttl = p.invite("client", "ttl-test", identity);
  now += 599_999; p.join("client", ttl.code);
  const expired = p.invite("client", "expiry-test", identity);
  now += 600_000;
  assert.throws(() => p.join("client", expired.code), (e: any) => e.code === "UNAUTHENTICATED");
  emit("ttl-boundary", { before600000ms: "accepted", at600000ms: "UNAUTHENTICATED" });
  const valid = p.invite("client", "lockout-test", identity);
  for (let i = 0; i < 9; i++) assert.throws(() => p.join(i % 2 ? "client" : "runtime", "z".repeat(26)));
  assert.throws(() => p.join("client", valid.code));
  assert.equal(used(valid.code), 0);
  now += 60_000; p.join("client", valid.code);
  emit("global-lockout", { validCodeRejectedUntil60000ms: true, after60000ms: "accepted" });
  for (const publicUrl of ["https://8.135.45.26", "https://8.135.45.26:8443"]) {
    assert.equal(browserAllowed(new Request(publicUrl + "/v2/setup/client/join", { headers: { Host: new URL(publicUrl).host, Origin: origin } }), { hostname: "127.0.0.1", publicUrl }, 7420), true);
  }
  emit("ip-origin-static-function", { standardAnd8443: "allowed when configured as publicUrl", realTLSChecked: false });
  for (const line of logs.filter(line => line.startsWith("{"))) {
    const value = JSON.parse(line);
    emit("hub-log", { method: value.method, path: value.path, status: value.status });
  }
  emit("result", "all investigation assertions passed; no production Hub contacted");
} finally {
  await hub.stop();
  await rm(scratch, { recursive: true, force: true });
}

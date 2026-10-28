import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, Job, ClientInvite, ClientJoin, HubSigningKey, RuntimeInvite, RuntimeJoin, RuntimeInfo, RuntimeRegistration } from "@lumio/schema";
import { authorize, PAIRING_OPERATIONS } from "../src/authorize.ts";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";
let root: string, state: string, vault: string, hub: Awaited<ReturnType<typeof startHub>>, now: number;
let human: string, agent: string, runtime: string, logs: string[];
let daemon: ReturnType<typeof Bun.spawn> | undefined;
const base = () => `http://127.0.0.1:${hub.server.port}`;
async function boot(publicUrl: string | undefined = "https://synthetic.example") {
  return startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state }), publicUrl: publicUrl || undefined, port: 0 }, { now: () => new Date(now), log: (line) => logs.push(line) });
}
function request(path: string, token?: string, body?: unknown, method?: string) {
  return fetch(base() + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
}
const invite = async (kind: "runtime" | "client" = "runtime", name = kind === "runtime" ? "server" : "cli@mac") => {
  const response = await request(`/v1/${kind}-invites`, human, { name }); expect(response.status).toBe(200);
  return (kind === "runtime" ? RuntimeInvite : ClientInvite).parse(await response.json());
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lumio-pairing-")); state = join(root, "state"); vault = join(root, "vault"); logs = []; now = Date.parse("2026-10-28T00:00:00Z");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  const store = await HubStore.open(state);
  store.createActor("owner", "human"); store.createActor("agent", "agent"); store.createActor("server", "runtime");
  human = store.createToken("owner", "owner"); agent = store.createToken("agent", "agent"); runtime = store.createToken("old-runtime", "server"); store.close(); hub = await boot();
});
afterEach(async () => { if (daemon) { daemon.kill("SIGTERM"); await daemon.exited; daemon = undefined; } await hub.stop(); await rm(root, { recursive: true, force: true }); });

test("explicit authorization table permits only public join, human invites/removal, runtime signing key", async () => {
  for (const operation of PAIRING_OPERATIONS) for (const role of [null, "human", "agent", "runtime"] as const) {
    const actor = hub.store.actors().find((a) => a.role === role) ?? null;
    expect(authorize(actor, { operation }).result).toBe((operation.endsWith(".join") ? role === null : operation === "runtime.signing-key" ? role === "runtime" : role === "human") ? "allow" : "deny");
  }
  for (const kind of ["runtime", "client"]) for (const token of [undefined, agent, runtime]) {
    expect((await request(`/v1/${kind}-invites`, token, "{")).status).toBe(token ? 403 : 401);
  }
  for (const token of [human, agent]) expect((await request("/v1/runtime/signing-key", token)).status).toBe(403);
  const key = HubSigningKey.parse(await (await request("/v1/runtime/signing-key", runtime)).json()); expect(key.fingerprint).toMatch(/^[a-f0-9]{4}(-[a-f0-9]{4}){3}$/);
  for (const token of [agent, runtime]) expect((await request("/v1/runtimes/server", token, undefined, "DELETE")).status).toBe(403);
  await hub.stop(); hub = await boot("");
  for (const kind of ["runtime", "client"]) { const res = await request(`/v1/${kind}-invites`, human, { name: "server" }); expect(res.status).toBe(400); expect(ApiError.parse(await res.json()).error.message).toContain("Hub 还没有对外地址"); }
});

test("new invite invalidates old codes, persists only hashes, expires exactly at ten minutes and returns identical 401", async () => {
  for (const kind of ["runtime", "client"] as const) {
    const first = await invite(kind), next = await invite(kind);
    expect(first.code).toHaveLength(26); expect(next.code).not.toBe(first.code);
    expect(next.command).toContain("--code " + next.code); expect(next.hub_url).toBe("https://synthetic.example");
    expect(Date.parse(next.expires) - now).toBe(600_000);
    const failure = await request(`/v1/${kind}/join`, undefined, { code: first.code }); expect(failure.status).toBe(401); const error = await failure.json();
    now += 600_000;
    for (const body of [{ code: next.code }, { code: "z".repeat(26) }, "{", { code: next.code, extra: true }]) {
      const res = await request(`/v1/${kind}/join`, undefined, body); expect(res.status).toBe(401); expect(await res.json()).toEqual(error);
    }
    now += 60_001;
    const stored = JSON.stringify(hub.store.db.query("SELECT * FROM pairing_codes").all()); expect(stored).not.toContain(first.code); expect(stored).not.toContain(next.code);
  }
});

test("join is atomic and single-use, revokes every old runtime token, client token belongs to inviting human; kinds cannot mix", async () => {
  const secondOld = hub.store.createToken("second-old", "server");
  const r = await invite(), c = await invite("client");
  for (const [kind, code] of [["client", r.code], ["runtime", c.code]]) expect((await request(`/v1/${kind}/join`, undefined, { code })).status).toBe(401);
  const responses = await Promise.all([request("/v1/runtime/join", undefined, { code: r.code }), request("/v1/runtime/join", undefined, { code: r.code })]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
  const joined = RuntimeJoin.parse(await responses.find((r) => r.status === 200)!.json());
  expect(hub.store.authenticate(`Bearer ${runtime}`)).toBeNull(); expect(hub.store.authenticate(`Bearer ${secondOld}`)).toBeNull();
  const registration = RuntimeRegistration.parse({ protocol_version: 2, name: "server", engines: [], tags: [], max_concurrent: 1 });
  const info = RuntimeInfo.parse(await (await request("/v1/runtime/register", joined.token, registration)).json()); expect(info.actor).toBe(joined.actor);
  const client = ClientJoin.parse(await (await request("/v1/client/join", undefined, { code: c.code })).json());
  expect(hub.store.authenticate(`Bearer ${client.token}`)!.actor.id).toBe(hub.store.authenticate(`Bearer ${human}`)!.actor.id);
  expect((await request("/v1/runtime-invites", human, { name: "owner" })).status).toBe(409);
  const audit = JSON.stringify(hub.store.db.query("SELECT * FROM audit").all());
  for (const secret of [r.code, c.code, human, agent, runtime, secondOld, joined.token, client.token]) expect(logs.join("\n") + audit).not.toContain(secret);
  expect(audit).toContain('server'); expect(audit).toContain(joined.actor);
  const history = Job.parse(await (await request("/v1/jobs", human, { runtime: "server", run: { kind: "command", argv: ["/bin/echo", "synthetic"] } })).json());
  const fresh = await invite();
  expect((await request("/v1/runtimes/server", human, undefined, "DELETE")).status).toBe(204);
  expect(hub.store.authenticate(`Bearer ${joined.token}`)).toBeNull(); expect(hub.store.runtimes(new Date(now))).toHaveLength(1);
  expect((await request(`/v1/jobs/${history.spec.id}`, human)).status).toBe(200);
  expect((await request("/v1/runtime/join", undefined, { code: fresh.code })).status).toBe(401);
});

test("global failure budget is shared across both joins, blocks even valid codes for one minute, and invites survive Hub restart", async () => {
  const r = await invite();
  await hub.stop(); hub = await boot();
  for (let i = 0; i < 10; i++) expect((await request(`/v1/${i % 2 ? "client" : "runtime"}/join`, undefined, { code: "z".repeat(26) })).status).toBe(401);
  expect((await request("/v1/runtime/join", undefined, { code: r.code })).status).toBe(401);
  now += 59_999; expect((await request("/v1/runtime/join", undefined, { code: r.code })).status).toBe(401);
  now += 1; expect((await request("/v1/runtime/join", undefined, { code: r.code })).status).toBe(200);
});

test("real Hub + CLI runtime add + join with temporary HOME connects a foreground runtime without system services", async () => {
  await hub.stop(); hub = await boot("http://127.0.0.1:7420");
  const cli = Bun.spawn([process.execPath, new URL("../../cli/src/main.ts", import.meta.url).pathname, "runtime", "add", "e2e", "--json"], {
    env: { ...process.env, HOME: root, LUMIO_HUB_URL: base(), LUMIO_TOKEN: human }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, error, code] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]); expect(code).toBe(0); expect(error).toBe("");
  const invitation = RuntimeInvite.parse(JSON.parse(stdout));
  // A same-app fixture injects service startup; the actual daemon uses only HTTP to reach this Hub.
  const child = Bun.spawn([process.execPath, new URL("../../runtime/test/fixtures/join.ts", import.meta.url).pathname, base(), invitation.code], {
    env: { ...process.env, HOME: root, PATH: "/usr/bin:/bin", LUMIO_HUB_URL: undefined, LUMIO_TOKEN: undefined }, stdout: "pipe", stderr: "pipe",
  }); daemon = child;
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline && !hub.store.runtimes(new Date(now)).some((r) => r.registration.name === "e2e")) await Bun.sleep(25);
  expect(hub.store.runtimes(new Date(now)).find((r) => r.registration.name === "e2e")?.online).toBe(true);
  const content = await readFile(join(root, ".config/lumio-runtime/runtime.env"), "utf8"); expect(content).toContain('LUMIO_RUNTIME_NAME="e2e"'); expect(content).not.toContain(invitation.code);
  daemon.kill("SIGTERM"); expect(await daemon.exited).toBe(0); daemon = undefined;
  expect(await new Response(child.stderr).text()).toBe(""); expect(await new Response(child.stdout).text()).toContain("已连上 Hub");
}, 15_000);

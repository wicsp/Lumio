import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, JOB_PROTOCOL_VERSION, RuntimeHeartbeat, RuntimeInfo, RuntimeRegistration, RuntimeSync } from "@lumio/schema";
import { authorize, EXISTING_OPERATIONS, RUNTIME_OPERATIONS } from "../src/authorize.ts";
import { readConfig } from "../src/config.ts";
import { ROUTES, startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";

let temp: string, state: string, vault: string, logs: string[], clock: number;
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let human: string, agent: string, runtime: string, other: string;
const registration = RuntimeRegistration.parse({ protocol_version: JOB_PROTOCOL_VERSION, name: "server", engines: [], tags: ["gpu:4", "lab"], max_concurrent: 2 });
const heartbeat = RuntimeHeartbeat.parse({ running: [], queued: [], outbox: 0 });
const base = () => `http://127.0.0.1:${hub!.server.port}`;
const boot = (port = 0) => startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state }), port }, { now: () => new Date(clock), log: (line) => logs.push(line) });
function request(path: string, token: string, body?: unknown) {
  return fetch(`${base()}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
}
async function list() { return RuntimeInfo.array().parse(await (await request("/v1/runtimes", human)).json()); }
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(25); }
  throw new Error("Timed out waiting for synthetic runtime");
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-runtime-hub-")); state = join(temp, "state"); vault = join(temp, "vault"); logs = []; clock = Date.parse("2026-01-01T00:00:00Z");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  const store = await HubStore.open(state);
  for (const [name, role] of [["owner", "human"], ["agent", "agent"], ["server", "runtime"], ["other", "runtime"]] as const) store.createActor(name, role);
  human = store.createToken("owner", "owner"); agent = store.createToken("agent", "agent"); runtime = store.createToken("server", "server"); other = store.createToken("other", "other"); store.close();
  hub = await boot();
});
afterEach(async () => {
  if (daemon) { daemon.kill("SIGKILL"); await daemon.exited; daemon = undefined; }
  await hub?.stop(); hub = undefined; await rm(temp, { recursive: true, force: true });
});

test("register and sync validate contracts, persist capabilities, sort names and derive online from injected clock", async () => {
  let response = await request("/v1/runtime/sync", runtime, heartbeat);
  expect(response.status).toBe(404); expect(ApiError.parse(await response.json()).error.code).toBe("NOT_FOUND");
  response = await request("/v1/runtime/register", runtime, registration);
  expect(response.status).toBe(200);
  const info = RuntimeInfo.parse(await response.json()); expect(info.registration).toEqual(registration);
  expect(info.actor).toBe(hub!.store.actors().find((actor) => actor.name === "server")!.id);
  expect(await list()).toEqual([info]);
  const updated = { ...registration, tags: ["changed"], max_concurrent: 3 };
  response = await request("/v1/runtime/register", runtime, updated);
  expect(RuntimeInfo.parse(await response.json()).registration).toEqual(updated);
  await request("/v1/runtime/register", other, { ...registration, name: "alpha" });
  expect((await list()).map((info) => info.registration.name)).toEqual(["alpha", "server"]);
  clock += 180_000; expect((await list()).every((info) => info.online)).toBe(true);
  clock += 1; expect((await list()).every((info) => !info.online)).toBe(true);
  response = await request("/v1/runtime/sync", runtime, heartbeat);
  expect(response.status).toBe(200); expect(RuntimeSync.parse(await response.json())).toEqual({ jobs: [], cancel: [], routines: [] });
  expect((await list())[1]).toMatchObject({ online: true, last_seen: new Date(clock).toISOString() });
  await hub!.stop(); hub = await boot();
  expect((await list())[1]!.registration).toEqual(updated);
  const audit = hub!.store.db.query<{ operation: string; authorization: string; execution_result: string }, []>("SELECT * FROM audit").all();
  expect(audit).toContainEqual(expect.objectContaining({ operation: "runtime.sync", authorization: "allow", execution_result: "NOT_FOUND" }));
  expect(audit).toContainEqual(expect.objectContaining({ operation: "runtime.register", authorization: "allow", execution_result: "applied" }));
  // 成功的心跳不进审计（P2-1 review：否则每 5 秒一行）。
  expect(audit.filter((row) => row.operation === "runtime.sync" && row.execution_result === "applied")).toHaveLength(0);
});

test("different runtime identities cannot claim one name, and one identity cannot change its name", async () => {
  await request("/v1/runtime/register", runtime, registration);
  for (const [token, body] of [[other, registration], [runtime, { ...registration, name: "renamed" }]] as const) {
    const response = await request("/v1/runtime/register", token, body);
    expect(response.status).toBe(409); expect(ApiError.parse(await response.json()).error.code).toBe("CONFLICT");
  }
  expect((await list()).map((info) => info.registration)).toEqual([registration]);
});

test("malformed JSON, wrong protocol and unknown fields return INVALID without changing last_seen", async () => {
  await request("/v1/runtime/register", runtime, registration);
  clock += 200_000;
  for (const [path, bodies] of [["/v1/runtime/register", ["{", { ...registration, protocol_version: 1 }, { ...registration, extra: true }]],
    ["/v1/runtime/sync", ["{", { ...heartbeat, extra: true }, { ...heartbeat, outbox: [] }]]] as const) {
    for (const body of bodies) {
      const response = await request(path, runtime, body);
      expect(response.status).toBe(400); expect(ApiError.parse(await response.json()).error.code).toBe("INVALID");
    }
  }
  expect((await list())[0]!.online).toBe(false);
});

test("runtime is denied at every existing endpoint before body parsing; other roles cannot register or sync", async () => {
  for (const route of ROUTES.filter((route) => !(RUNTIME_OPERATIONS as readonly string[]).includes(route.operation))) {
    const path = { "job.submit": "/v1/jobs", jobs: "/v1/jobs", "job.show": "/v1/jobs/missing", "job.cancel": "/v1/jobs/missing/cancel", operations: "/v1/operations", actors: "/v1/actors", proposals: "/v1/proposals", "proposal.accept": "/v1/proposals/missing/accept", "proposal.reject": "/v1/proposals/missing/reject",
      status: "/v1/status", health: "/health", search: "/v1/search", check: "/v1/check", links: "/v1/notes/Main/links", show: "/v1/notes/Main" };
    const response = await request(path[route.operation as keyof typeof path], runtime, "method" in route && route.method === "POST" ? "{" : undefined);
    expect(response.status).toBe(403); expect(ApiError.parse(await response.json()).error.code).toBe("FORBIDDEN");
  }
  for (const token of [runtime, agent]) expect((await request("/v1/runtimes", token)).status).toBe(403);
  for (const token of [human, agent]) for (const path of ["/v1/runtime/register", "/v1/runtime/sync"]) {
    const response = await request(path, token, "{");
    expect(response.status).toBe(403); ApiError.parse(await response.json());
  }
  for (const path of ["/v1/runtime/register", "/v1/runtime/sync", "/v1/runtimes"]) {
    const response = await fetch(`${base()}${path}`, { method: path.endsWith("runtimes") ? "GET" : "POST" });
    expect(response.status).toBe(401); ApiError.parse(await response.json());
  }
  expect((await fetch(`${base()}/health`)).status).toBe(200);
  expect((await request("/health", human)).status).toBe(200);
  expect((await request("/health", agent)).status).toBe(200);
  const records = JSON.stringify(hub!.store.db.query("SELECT * FROM audit").all());
  for (const token of [human, agent, runtime, other]) expect(logs.join("\n") + records).not.toContain(token);
});

test("rule table covers each runtime and role permission, with private queries denied too", () => {
  const actors = hub!.store.actors();
  for (const operation of EXISTING_OPERATIONS) for (const includePrivate of [false, true]) {
    expect(authorize(actors.find((actor) => actor.role === "runtime")!, { operation, includePrivate }).result).toBe("deny");
  }
  for (const operation of RUNTIME_OPERATIONS) for (const role of ["human", "agent", "runtime"] as const) {
    expect(authorize(actors.find((actor) => actor.role === role)!, { operation }).result)
      .toBe((operation === "runtimes" ? role === "human" : role === "runtime") ? "allow" : "deny");
  }
});

test("real daemon with fake PATH survives Hub restart, detects agents once and becomes offline after stopping", async () => {
  const bin = join(temp, "bin"), callsFile = join(temp, "version-calls"); await mkdir(bin);
  for (const [command, version] of [["codex", "codex-cli 0.42.0"], ["claude", "2.0.1 (Claude Code)"]]) {
    const path = join(bin, command!);
    await writeFile(path, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nif (process.argv[2] !== '--version' || process.argv.length !== 3) process.exit(2);\nappendFileSync(${JSON.stringify(callsFile)}, ${JSON.stringify(command + '\n')});\nconsole.log(${JSON.stringify(version)});\n`);
    await chmod(path, 0o700);
  }
  const child = Bun.spawn([process.execPath, new URL("../../runtime/src/main.ts", import.meta.url).pathname], { env: {
    PATH: bin, LUMIO_HUB_URL: base(), LUMIO_TOKEN: runtime, LUMIO_RUNTIME_NAME: registration.name,
    LUMIO_RUNTIME_TAGS: "gpu:4,lab", LUMIO_RUNTIME_MAX_CONCURRENT: "2", LUMIO_RUNTIME_POLL_SECONDS: "0.05", LUMIO_RUNTIME_STATE_DIR: join(temp, "runtime-state"),
  }, stdout: "pipe", stderr: "pipe" });
  daemon = child;
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  await eventually(async () => (await list()).length === 1);
  expect((await list())[0]!.registration).toEqual({ ...registration, engines: [
    { name: "codex", version: "0.42.0", sandbox: "os" }, { name: "claude-code", version: "2.0.1", sandbox: "none" },
  ] });
  const port = hub!.server.port!;
  await hub!.stop(); hub = undefined;
  await Bun.sleep(200); expect(daemon.exitCode).toBeNull();
  clock += 200_000; hub = await boot(port);
  await eventually(async () => (await list())[0]!.online);
  expect(daemon.exitCode).toBeNull();
  await eventually(() => hub!.store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM audit WHERE operation='runtime.register' AND execution_result='applied'").get()!.count >= 2);
  daemon.kill("SIGTERM"); expect(await daemon.exited).toBe(0); daemon = undefined;
  const stdout = await output; expect(await errors).toBe("");
  expect(stdout.match(/执行器登记成功/g)).toHaveLength(2);
  expect(stdout.match(/Hub 连接失联/g)).toHaveLength(1); expect(stdout.match(/Hub 连接已恢复/g)).toHaveLength(1);
  expect((await readFile(callsFile, "utf8")).trim().split("\n").sort()).toEqual(["claude", "codex"]);
  clock += 180_001; expect((await list())[0]!.online).toBe(false);
  for (const token of [human, agent, runtime, other]) expect(stdout + logs.join("\n")).not.toContain(token);
}, 15_000);

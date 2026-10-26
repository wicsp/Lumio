import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, Job, JobResult, RuntimeAck, RuntimeInfo, RuntimeSync } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { HubStore } from "../src/store.ts";

let temp: string, state: string, vault: string, runtimeState: string;
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let daemons: ReturnType<typeof Bun.spawn>[] = [];
let human: string, agent: string, runtime: string, other: string, port: number;
let proxy: Bun.Server<undefined> | undefined;
let output: Promise<string>[], errors: Promise<string>[];
const fixture = new URL("./fixtures/command.ts", import.meta.url).pathname;
const registration = { protocol_version: 2, name: "server", engines: [], tags: [], max_concurrent: 1 };
const heartbeat = { running: [], queued: [], outbox: 0 };
const base = () => `http://127.0.0.1:${port}`;
const boot = (listen = 0) => startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state }), port: listen }, { log: () => {} });
async function request(path: string, token = human, body?: unknown) {
  return fetch(`${base()}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function get(id: string) { return Job.parse(await (await request(`/v1/jobs/${id}`)).json()); }
async function submit(mode = "quiet", path = join(temp, "calls"), delay = 0, fields: object = {}, extra = "literal") {
  const response = await request("/v1/jobs", human, { runtime: "server", run: { kind: "command", argv: [process.execPath, fixture, mode, path, String(delay), extra] }, ...fields });
  expect(response.status).toBe(200); return Job.parse(await response.json());
}
async function eventually(check: () => boolean | Promise<boolean>, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(20); }
  throw new Error("Timed out waiting for synthetic job");
}
async function exists(path: string) { try { await readFile(path); return true; } catch { return false; } }
async function localCount(query: string) {
  try { const db = new Database(join(runtimeState, "runtime.sqlite"), { readonly: true }); try { return db.query<{ count: number }, []>(query).get()!.count; } finally { db.close(); } } catch { return -1; }
}
async function startRuntime(url = base(), binary?: string) {
  const child = Bun.spawn(binary ? [binary] : [process.execPath, new URL("../../runtime/src/main.ts", import.meta.url).pathname], { env: {
    PATH: temp, LUMIO_HUB_URL: url, LUMIO_TOKEN: runtime, LUMIO_RUNTIME_NAME: "server", LUMIO_RUNTIME_MAX_CONCURRENT: "1", LUMIO_RUNTIME_POLL_SECONDS: "0.03",
    LUMIO_RUNTIME_STATE_DIR: runtimeState, LUMIO_RUNTIME_ALLOWED_COMMANDS: process.execPath,
  }, stdout: "pipe", stderr: "pipe" });
  daemons.push(child); output.push(new Response(child.stdout).text()); errors.push(new Response(child.stderr).text());
  await eventually(async () => {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Synthetic runtime exited ${child.exitCode ?? child.signalCode}: ${await errors.at(-1)}`);
    return RuntimeInfo.array().parse(await (await request("/v1/runtimes")).json()).length === 1;
  }).catch(async (cause) => {
    await stop(child);
    throw new Error(`${cause}: ${await output.at(-1)} ${await errors.at(-1)}`);
  });
  return child;
}
async function stop(child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals = "SIGTERM") { child.kill(signal); await child.exited; daemons = daemons.filter((d) => d !== child); }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-jobs-")); state = join(temp, "hub"); vault = join(temp, "vault"); runtimeState = join(temp, "runtime"); output = []; errors = [];
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  const store = await HubStore.open(state);
  for (const [name, role] of [["owner", "human"], ["agent", "agent"], ["server", "runtime"], ["other", "runtime"]] as const) store.createActor(name, role);
  human = store.createToken("owner", "owner"); agent = store.createToken("agent", "agent"); runtime = store.createToken("server", "server"); other = store.createToken("other", "other"); store.close();
  hub = await boot(); port = hub.server.port!;
});
afterEach(async () => {
  for (const child of [...daemons]) await stop(child);
  await proxy?.stop(true); proxy = undefined;
  await hub?.stop(); hub = undefined;
  await rm(temp, { recursive: true, force: true });
});

test("job API validates inputs, authorizes all endpoints, tracks ownership/lease, deduplicates results and audits identities", async () => {
  RuntimeInfo.parse(await (await request("/v1/runtime/register", runtime, registration)).json());
  const job = await submit();
  expect(job).toMatchObject({ status: "queued", spec: { workdir: "~", timeout_seconds: 7200 } });
  expect(Buffer.from(job.spec.lease, "base64url").length).toBeGreaterThanOrEqual(32);
  for (const token of [agent, runtime]) for (const [path, body] of [["/v1/jobs", {}], [`/v1/jobs/${job.spec.id}/cancel`, {}], ["/v1/jobs", undefined], [`/v1/jobs/${job.spec.id}`, undefined]] as const) {
    const response = await request(path, token, body); expect(response.status).toBe(403); ApiError.parse(await response.json());
  }
  for (const body of [{ runtime: "missing", run: job.spec.run }, { runtime: "server", run: job.spec.run, unknown: true }, { runtime: "server", run: { kind: "agent", engine: "codex", prompt: "no" } }])
    expect((await request("/v1/jobs", human, body)).status).toBe(400);
  expect((await request("/v1/jobs?status=bad")).status).toBe(400);
  const sync = RuntimeSync.parse(await (await request("/v1/runtime/sync", runtime, heartbeat)).json());
  expect(sync.jobs).toEqual([job.spec]);
  const result = JobResult.parse({ job: job.spec.id, lease: job.spec.lease, status: "done", exit_code: 0, finished: new Date().toISOString() });
  expect((await request("/v1/runtime/results", runtime, result)).status).toBe(409);
  RuntimeAck.parse(await (await request("/v1/runtime/ack", runtime, { accepted: [job.spec.id] })).json());
  const assigned = await get(job.spec.id); expect(assigned.status).toBe("assigned"); expect(assigned.assigned).toBeDefined();
  for (const [token, body] of [[other, result], [runtime, { ...result, lease: "wrong_lease_123456789" }]] as const) {
    expect((await request("/v1/runtime/results", token, body)).status).toBe(409); expect(await get(job.spec.id)).toEqual(assigned);
  }
  await request("/v1/runtime/sync", other, { ...heartbeat, running: [job.spec.id] });
  expect(await get(job.spec.id)).toEqual(assigned);
  await request("/v1/runtime/sync", runtime, { ...heartbeat, running: [job.spec.id] });
  expect(await get(job.spec.id)).toMatchObject({ status: "running", last_seen: expect.any(String) });
  expect((await request("/v1/runtime/results", runtime, result)).status).toBe(200);
  expect((await request("/v1/runtime/results", runtime, result)).status).toBe(200);
  expect((await request("/v1/runtime/results", runtime, { ...result, exit_code: 1 })).status).toBe(409);
  expect(Job.array().parse(await (await request("/v1/jobs?status=done")).json())).toHaveLength(1);
  const queued = await submit(); await request(`/v1/jobs/${queued.spec.id}/cancel`, human, {});
  expect((await get(queued.spec.id)).status).toBe("cancelled");
  const audit = hub!.store.db.query<{ actor_id: string; operation: string; execution_result: string }, []>("SELECT * FROM audit WHERE operation IN ('job.submit','job.cancel')").all();
  expect(audit.filter((r) => r.execution_result === "applied").map((r) => r.operation)).toEqual(["job.submit", "job.submit", "job.cancel"]);
  expect(audit.every((r) => hub!.store.actors().some((a) => a.id === r.actor_id))).toBe(true);
  await hub!.stop(); hub = await boot(port); expect((await get(job.spec.id)).result).toEqual(result);
});

test("real command captures stdout tail, stderr log, cwd, literal argv, GPU and nonzero exit; disallowed program never starts", async () => {
  await startRuntime();
  const job = await submit("output", join(temp, "calls"), 0, { workdir: temp, gpus: [0, 2] }, "$(touch never); --literal");
  await eventually(async () => (await get(job.spec.id)).status === "done");
  const result = (await get(job.spec.id)).result!;
  expect(result.exit_code).toBe(0); expect(result.report!.length).toBe(4000);
  expect(result.report).toContain(`cwd=${await realpath(temp)} gpu=0,2 arg=$(touch never); --literal`);
  const log = await readFile(result.log!, "utf8"); expect(log).toContain("stderr only"); expect(log).toContain("x".repeat(4500)); expect(result.report).not.toContain("stderr only");
  expect(await exists(join(temp, "never"))).toBe(false);
  const failed = await submit("fail"); await eventually(async () => (await get(failed.spec.id)).status === "failed");
  expect((await get(failed.spec.id)).result!.exit_code).toBe(7);
  const denied = await submit("quiet", join(temp, "never"), 0, { run: { kind: "command", argv: ["/not/allowed", join(temp, "never")] } });
  await eventually(async () => (await get(denied.spec.id)).status === "failed");
  expect((await get(denied.spec.id)).result!.error).toContain("允许列表"); expect(await exists(join(temp, "never"))).toBe(false);
  await eventually(async () => await localCount("SELECT count(*) AS count FROM outbox") === 0);
});

test("Hub stops mid-command; execution continues and durable outbox delivers after restart", async () => {
  await startRuntime(); const calls = join(temp, "calls");
  const job = await submit("quiet", calls, 600);
  await eventually(() => exists(calls));
  await hub!.stop(); hub = undefined;
  await eventually(async () => await localCount("SELECT count(*) AS count FROM outbox") === 1);
  expect(await readFile(calls, "utf8")).toContain("end");
  hub = await boot(port);
  await eventually(async () => (await get(job.spec.id)).status === "done");
  expect((await readFile(calls, "utf8")).match(/start/g)).toHaveLength(1);
});

test("crash before ack: committed local queue survives, Hub resends and command executes exactly once", async () => {
  let ackSeen = false, allowAck = false;
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/v1/runtime/ack" && !allowAck) { ackSeen = true; return new Response("offline", { status: 503 }); }
    return fetch(`${base()}${new URL(req.url).pathname}`, { method: req.method, headers: req.headers, body: await req.text() });
  } });
  const url = `http://127.0.0.1:${proxy.port}`;
  const daemon = await startRuntime(url), calls = join(temp, "calls"); const job = await submit("quiet", calls);
  await eventually(() => ackSeen);
  expect(await localCount("SELECT count(*) AS count FROM queue WHERE acked=0 AND state='queued'")).toBe(1);
  expect((await get(job.spec.id)).status).toBe("queued"); expect(await exists(calls)).toBe(false);
  await stop(daemon, "SIGKILL"); allowAck = true; await startRuntime(url);
  await eventually(async () => (await get(job.spec.id)).status === "done");
  expect((await readFile(calls, "utf8")).match(/start/g)).toHaveLength(1);
  const spec = (await get(job.spec.id)).spec;
  expect((await request("/v1/runtime/ack", runtime, { accepted: [spec.id] })).status).toBe(200);
  expect((await get(spec.id)).status).toBe("done");
});

test("lost result response retries identical result; 409 keeps the outbox and logs conflict", async () => {
  let lose = true, attempts = 0, conflict = false;
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/v1/runtime/results") {
      attempts++;
      if (conflict) return Response.json({ error: { code: "CONFLICT", message: "synthetic" } }, { status: 409 });
      const response = await fetch(`${base()}${path}`, { method: req.method, headers: req.headers, body: await req.text() });
      if (lose) { lose = false; return new Response("connection lost", { status: 503 }); }
      return response;
    }
    return fetch(`${base()}${path}`, { method: req.method, headers: req.headers, body: await req.text() });
  } });
  const daemon = await startRuntime(`http://127.0.0.1:${proxy.port}`), job = await submit();
  await eventually(async () => attempts >= 2 && await localCount("SELECT count(*) AS count FROM outbox") === 0);
  const result = (await get(job.spec.id)).result; expect(result!.status).toBe("done");
  conflict = true; const blocked = await submit();
  await eventually(async () => attempts === 3 && await localCount("SELECT count(*) AS count FROM outbox") === 1);
  await Bun.sleep(100); expect(attempts).toBe(3); expect((await get(blocked.spec.id)).result).toBeUndefined();
  await stop(daemon); expect((await Promise.all(output)).join("\n")).toContain("409");
});

test("MAX_CONCURRENT=1 executes in receipt order without overlap", async () => {
  await startRuntime(); const calls = join(temp, "sequence");
  const first = await submit("quiet", calls, 250), second = await submit("quiet", calls, 0);
  await eventually(async () => (await get(second.spec.id)).status === "done");
  expect((await get(first.spec.id)).status).toBe("done");
  expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([expect.stringMatching(/^start /), "end", expect.stringMatching(/^start /), "end"]);
});

for (const mode of ["restart", "timeout", "cancel"] as const) test(`${mode} kills process group including grandchild`, async () => {
  let daemon = await startRuntime(); const calls = join(temp, "tree");
  const job = await submit("tree", calls, 0, { timeout_seconds: mode === "timeout" ? 1 : 60 });
  await eventually(() => exists(`${calls}.child`));
  const pid = Number((await readFile(calls, "utf8")).split(" ")[1]!.trim()), grandchild = Number(await readFile(`${calls}.child`, "utf8"));
  expect(alive(pid)).toBe(true); expect(alive(grandchild)).toBe(true);
  if (mode === "restart") { await stop(daemon, "SIGKILL"); daemon = await startRuntime(); }
  if (mode === "cancel") expect((await request(`/v1/jobs/${job.spec.id}/cancel`, human, {})).status).toBe(200);
  const final = mode === "restart" ? "unknown" : mode === "cancel" ? "cancelled" : "failed";
  await eventually(async () => (await get(job.spec.id)).status === final, 15_000);
  await eventually(() => !alive(pid) && !alive(grandchild));
  if (mode !== "cancel") expect((await get(job.spec.id)).result!.error).toBe(mode === "restart" ? "执行器重启" : "超时");
}, 25_000);

test("cancel racing receipt/ack cancels locally queued work without starting it", async () => {
  let cancelBeforeAck = true;
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname, body = await req.text();
    if (path === "/v1/runtime/ack" && cancelBeforeAck) {
      cancelBeforeAck = false;
      const ack = RuntimeAck.parse(JSON.parse(body));
      for (const id of ack.accepted) await request(`/v1/jobs/${id}/cancel`, human, {});
    }
    return fetch(`${base()}${path}`, { method: req.method, headers: req.headers, body });
  } });
  await startRuntime(`http://127.0.0.1:${proxy.port}`);
  const calls = join(temp, "never"); const job = await submit("quiet", calls);
  await eventually(async () => (await get(job.spec.id)).result?.status === "cancelled");
  expect(await exists(calls)).toBe(false);
});

test("ack committed at Hub but response lost: runtime restart still executes once", async () => {
  let loseAck = true, ackSeen = false;
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const response = await fetch(`${base()}${path}`, { method: req.method, headers: req.headers, body: await req.text() });
    if (path === "/v1/runtime/ack" && loseAck) { ackSeen = true; return new Response("lost ack", { status: 503 }); }
    return response;
  } });
  const url = `http://127.0.0.1:${proxy.port}`, daemon = await startRuntime(url), calls = join(temp, "once");
  const job = await submit("quiet", calls);
  await eventually(() => ackSeen); expect((await get(job.spec.id)).status).toBe("assigned");
  await stop(daemon, "SIGKILL"); loseAck = false; await startRuntime(url);
  await eventually(async () => (await get(job.spec.id)).status === "done");
  expect((await readFile(calls, "utf8")).match(/start/g)).toHaveLength(1);
});

test("timeout escalates to SIGKILL when command and grandchild ignore SIGTERM", async () => {
  await startRuntime(); const calls = join(temp, "stubborn");
  const job = await submit("tree", calls, 0, { timeout_seconds: 1 }, "ignore-term");
  await eventually(() => exists(`${calls}.child`));
  const grandchild = Number(await readFile(`${calls}.child`, "utf8"));
  await eventually(async () => (await get(job.spec.id)).status === "failed", 15_000);
  expect((await get(job.spec.id)).result!.error).toBe("超时");
  await eventually(() => !alive(grandchild));
}, 20_000);


test("compiled runtime preserves the durable-start worker path", async () => {
  const binary = join(temp, "compiled-runtime");
  const build = Bun.spawn([process.execPath, "build", "--compile", new URL("../../runtime/src/main.ts", import.meta.url).pathname, "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
  const [code, , stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  expect(code).toBe(0);
  if (code !== 0) throw new Error(stderr);
  // Nix Bun's compiled Mach-O needs an ad-hoc signature before macOS will run it.
  if (process.platform === "darwin") {
    const signing = Bun.spawn(["/usr/bin/codesign", "--force", "--sign", "-", binary], { stdout: "ignore", stderr: "pipe" });
    const signingErrors = new Response(signing.stderr).text();
    expect(await signing.exited).toBe(0); await signingErrors;
  }
  await startRuntime(base(), binary);
  const job = await submit(); await eventually(async () => (await get(job.spec.id)).status === "done");
  expect((await get(job.spec.id)).result!.exit_code).toBe(0);
}, 20_000);

import { beforeEach as beforeLocale, afterEach as afterLocale } from "bun:test";
let previousLocale: string | undefined;
beforeLocale(() => { previousLocale = process.env.LUMIO_LANG; process.env.LUMIO_LANG = "zh"; });
afterLocale(() => { if (previousLocale === undefined) delete process.env.LUMIO_LANG; else process.env.LUMIO_LANG = previousLocale; });
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { AIConnection, JOB_ACCOUNT_FEATURE, JobActivityCapabilities, NativeConnectionView, WorkCommandRequest, WorkCommandResult, JobActionReceipt, JobActivityAck, JobActivityPage, JobActivitySync, JobAttention, JobLiveView } from "@lumio/schema";
import { cp, mkdir, writeFile, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, Job, JobResult, RuntimeAck, RuntimeInfo, RuntimeRegistered, RuntimeSync, StoredArtifact, RunLogEvent, BackupManifest } from "@lumio/schema";
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
async function request(path: string, token = human, body?: unknown, features?: string) {
  return fetch(`${base()}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Accept-Language": "zh", Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(features ? { "X-Lumio-Features": features } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function get(id: string) { return Job.parse(await (await request(`/v2/execution/jobs/${id}`)).json()); }
async function submit(mode = "quiet", path = join(temp, "calls"), delay = 0, fields: object = {}, extra = "literal") {
  const response = await request("/v2/execution/jobs", human, { runtime: "server", run: { kind: "command", argv: [process.execPath, fixture, mode, path, String(delay), extra] }, ...fields });
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
async function startRuntime(url = base(), binary?: string, extraEnv?: Record<string, string>) {
  const child = Bun.spawn(binary ? [binary] : [process.execPath, new URL("../../runtime/src/main.ts", import.meta.url).pathname], { env: {
    HOME: temp, PATH: temp, LUMIO_HUB_URL: url, LUMIO_TOKEN: runtime, LUMIO_RUNTIME_NAME: "server", LUMIO_RUNTIME_MAX_CONCURRENT: "1", LUMIO_RUNTIME_POLL_SECONDS: "0.03",
    LUMIO_RUNTIME_STATE_DIR: runtimeState, LUMIO_RUNTIME_ALLOWED_COMMANDS: process.execPath,
    ...extraEnv,
  }, stdout: "pipe", stderr: "pipe" });
  daemons.push(child); output.push(new Response(child.stdout).text()); errors.push(new Response(child.stderr).text());
  await eventually(async () => {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Synthetic runtime exited ${child.exitCode ?? child.signalCode}: ${await errors.at(-1)}`);
    return RuntimeInfo.array().parse(await (await request("/v2/execution/runtimes")).json()).length === 1;
  }).catch(async (cause) => {
    await stop(child);
    throw new Error(`${cause}: ${await output.at(-1)} ${await errors.at(-1)}`);
  });
  return child;
}
async function stop(child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals = "SIGTERM") { child.kill(signal); await child.exited; daemons = daemons.filter((d) => d !== child); }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
beforeEach(async () => {
  temp = await mkdtemp(join(await realpath(tmpdir()), "lumio-jobs-")); state = join(temp, "hub"); vault = join(temp, "vault"); runtimeState = join(temp, "runtime"); output = []; errors = [];
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
  RuntimeRegistered.parse(await (await request("/v1/runtime/register", runtime, registration)).json());
  const job = await submit();
  expect(job).toMatchObject({ status: "queued", spec: { workdir: "~", timeout_seconds: 7200 } });
  expect(Buffer.from(job.spec.lease, "base64url").length).toBeGreaterThanOrEqual(32);
  for (const token of [agent, runtime]) for (const [path, body] of [["/v2/execution/jobs", {}], [`/v2/execution/jobs/${job.spec.id}/cancel`, {}], ["/v2/execution/jobs", undefined], [`/v2/execution/jobs/${job.spec.id}`, undefined]] as const) {
    const response = await request(path, token, body);
    const allowed = token === agent && body === undefined;
    expect(response.status).toBe(allowed ? 200 : 403); if (!allowed) ApiError.parse(await response.json());
  }
  for (const body of [{ runtime: "missing", run: job.spec.run }, { runtime: "server", run: job.spec.run, unknown: true }, { runtime: "server", run: { kind: "agent", engine: "codex", prompt: "no" } }])
    expect((await request("/v2/execution/jobs", human, body)).status).toBe(400);
  expect((await request("/v2/execution/jobs?status=bad")).status).toBe(400);
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
  expect(Job.array().parse(await (await request("/v2/execution/jobs?status=done")).json())).toHaveLength(1);
  const queued = await submit(); await request(`/v2/execution/jobs/${queued.spec.id}/cancel`, human, {});
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
  expect(result.report).toContain("lumio-env=LUMIO_SUDO_SOCKET,LUMIO_SUDO_TOKEN"); // 执行器的令牌与配置不传给被执行的程序（P2-2 review）
  const log = await readFile(result.log!, "utf8"); expect(log).toContain("stderr only"); expect(log).toContain("x".repeat(4500)); expect(result.report).not.toContain("stderr only");
  expect(await exists(join(temp, "never"))).toBe(false);
  const failed = await submit("fail"); await eventually(async () => (await get(failed.spec.id)).status === "failed");
  expect((await get(failed.spec.id)).result!.exit_code).toBe(7);
  const denied = await submit("quiet", join(temp, "never"), 0, { run: { kind: "command", argv: ["/not/allowed", join(temp, "never")] } });
  await eventually(async () => (await get(denied.spec.id)).status === "failed");
  expect((await get(denied.spec.id)).result!.error).toContain("LUMIO_RUNTIME_ALLOWED_COMMANDS"); expect(await exists(join(temp, "never"))).toBe(false);
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

test("file archival is independently durable: failed upload does not block results, restart confirms once, business backup restores both", async () => {
  let allowUpload = false;
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/v2/execution/artifacts/") && req.method === "PUT" && !allowUpload) return new Response("synthetic offline file store", { status: 503 });
    return fetch(`${base()}${path}`, { method: req.method, headers: req.headers, ...(req.method === "GET" ? {} : { body: await req.arrayBuffer() }) });
  } });
  const daemon = await startRuntime(`http://127.0.0.1:${proxy.port}`), calls = join(temp, "archive-calls"), job = await submit("output", calls);
  await eventually(async () => (await get(job.spec.id)).status === "done");
  const files = async () => StoredArtifact.array().parse(await (await request(`/v2/execution/jobs/${job.spec.id}/artifacts`)).json());
  await eventually(async () => (await files()).length === 2);
  expect((await files()).every((file) => file.status === "staged")).toBe(true);
  await eventually(async () => await localCount("SELECT count(*) AS count FROM outbox") === 0);
  expect(await localCount("SELECT count(*) AS count FROM archive_outbox WHERE state='pending'")).toBe(2);
  await stop(daemon); allowUpload = true; await startRuntime(`http://127.0.0.1:${proxy.port}`);
  await eventually(async () => (await files()).every((file) => file.status === "ready"));
  await eventually(async () => await localCount("SELECT count(*) AS count FROM archive_outbox WHERE state='confirmed'") === 2);
  const raw = (await files()).find((file) => file.media_type === "text/plain")!, trace = (await files()).find((file) => file.media_type === "application/vnd.lumio.runlog+jsonl")!;
  const content = async (id: string) => (await request(`/v2/execution/artifacts/${id}/content`)).text();
  expect(await content(raw.id)).toBe(await readFile((await get(job.spec.id)).result!.log!, "utf8"));
  const events = (await content(trace.id)).trim().split("\n").map((line) => RunLogEvent.parse(JSON.parse(line)));
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(events.at(-1)!.payload.status).toBe("done"); expect(events.some((event) => event.type === "output" && event.payload.stream === "stderr")).toBe(true);
  expect((await readFile(calls, "utf8")).match(/start/g)).toHaveLength(1);
  expect((await request(`/v2/execution/artifacts/${raw.id}/content`, agent)).status).toBe(200);
  for (const child of [...daemons]) await stop(child);
  const main = new URL("../src/main.ts", import.meta.url).pathname, backup = join(temp, "business-backup"), restored = join(temp, "restored");
  async function manage(args: string[]) {
    const child = Bun.spawn([process.execPath, main, ...args], { env: { LUMIO_LANG: "zh", HOME: temp, PATH: temp, LUMIO_STATE_DIR: state }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(code).toBe(0); return BackupManifest.parse(JSON.parse(stdout));
  }
  expect((await manage(["backup", "business", backup])).files).toHaveLength(2);
  await manage(["backup", "verify", backup]); await manage(["restore", "business", backup, restored]);
  await hub!.stop(); hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: restored }), port: 0 }, { log() {} }); port = hub.server.port!;
  expect((await get(job.spec.id)).status).toBe("done"); expect(await content(raw.id)).toContain("stderr only");
  expect(await files()).toHaveLength(2);
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
  if (mode === "cancel") expect((await request(`/v2/execution/jobs/${job.spec.id}/cancel`, human, {})).status).toBe(200);
  const final = mode === "restart" ? "unknown" : mode === "cancel" ? "cancelled" : "failed";
  await eventually(async () => (await get(job.spec.id)).status === final, 15_000);
  await eventually(() => !alive(pid) && !alive(grandchild));
  if (mode !== "cancel") expect((await get(job.spec.id)).result!.error).toBe(mode === "restart" ? "restarted" : "timeout");
}, 25_000);

test("cancel racing receipt/ack cancels locally queued work without starting it", async () => {
  let cancelBeforeAck = true;
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname, body = await req.text();
    if (path === "/v1/runtime/ack" && cancelBeforeAck) {
      cancelBeforeAck = false;
      const ack = RuntimeAck.parse(JSON.parse(body));
      for (const id of ack.accepted) await request(`/v2/execution/jobs/${id}/cancel`, human, {});
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
  expect((await get(job.spec.id)).result!.error).toBe("timeout");
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

test("Job activity is authorized, contiguous, idempotent and cannot replace a final result", async () => {
  const path = "/v1/runtime/job-activity/sync";
  const registrationResponse = await fetch(base() + "/v1/runtime/register", {
    method: "POST", headers: { Authorization: `Bearer ${runtime}`, "X-Lumio-Features": "job-activity" },
    body: JSON.stringify(registration),
  });
  expect(registrationResponse.headers.get("X-Lumio-Features")).toBe("job-activity");
  expect((await request(path, runtime, JobActivitySync.parse({ type: "register", platform: "synthetic", engines: [] }))).status).toBe(200);
  await request("/v1/runtime/register", other, { ...registration, name: "other" });
  const job = await submit(), id = job.spec.id, url = `/v2/execution/jobs/${id}`;
  expect((await request(`${url}/live`, agent)).status).toBe(403);
  expect((await request(`${url}/events`, runtime)).status).toBe(403);
  await request("/v1/runtime/ack", runtime, { accepted: [id] });
  const time = new Date().toISOString();
  const sync = JobActivitySync.parse({ type: "job", job: id, lease: job.spec.lease, events: [
    { sequence: 1, event: { type: "phase", phase: "preparing", at: time } },
    { sequence: 2, event: { type: "tool_started", at: time, tool: { id: "compile", label: "bun test", kind: "command" } } },
  ], receipts: [] });
  if (sync.type !== "job") throw new Error("Expected job sync");
  expect((await request(path, other, sync)).status).toBe(403);
  expect((await request(path, runtime, { ...sync, lease: "incorrect-lease-00001" })).status).toBe(403);
  const gap = await request(path, runtime, { ...sync, events: sync.events.slice(1) });
  expect(gap.status).toBe(409);
  expect(JobActivityAck.parse(await gap.json())).toMatchObject({ acknowledged: 0, conflict: true });
  for (let i = 0; i < 2; i++) {
    const ack = JobActivityAck.parse(await (await request(path, runtime, sync)).json());
    expect(ack).toMatchObject({ acknowledged: 2, conflict: false });
  }
  const live = JobLiveView.parse(await (await request(`${url}/live`)).json());
  expect(live).toMatchObject({ started: time, sequence: 2, active_tools: [{ label: "bun test" }] });
  const first = JobActivityPage.parse(await (await request(`${url}/events?limit=1`)).json());
  expect(first).toMatchObject({ next_after: 1, has_more: true, gap: false });
  expect(JobActivityPage.parse(await (await request(`${url}/events?after=1`)).json()).events).toEqual(sync.events.slice(1));
  await request("/v1/runtime/results", runtime, JobResult.parse({ job: id, lease: job.spec.lease, status: "done", finished: time }));
  const late = JobActivityAck.parse(await (await request(path, runtime, { ...sync, events: [
    { sequence: 3, event: { type: "phase", phase: "finishing", at: time } },
  ] })).json());
  expect(late).toMatchObject({ acknowledged: 3, cancel: true });
  expect(JobLiveView.parse(await (await request(`${url}/live`)).json())).toMatchObject({ status: "done", active_tools: [], pending: null });
});

test("same-round prompts require the original turn, never submit twice, and stop with Job cancellation", async () => {
  const path = "/v1/runtime/job-activity/sync";
  await request("/v1/runtime/register", runtime, { ...registration, engines: [{ name: "codex", version: "0.166.0", sandbox: "os" }] });
  await request(path, runtime, { type: "register", platform: "darwin", engines: [
    { engine: "codex", version: "0.166.0", progress: true, sandbox: "os", approvals: true, questions: true, steer: true },
  ] });
  const job = Job.parse(await (await request("/v2/execution/jobs", human, {
    runtime: "server", run: { kind: "agent", engine: "codex", interaction: "interactive", prompt: "fixture" },
  })).json());
  const id = job.spec.id, url = `/v2/execution/jobs/${id}`;
  await request("/v1/runtime/ack", runtime, { accepted: [id] });
  const target = { instance: randomUUID(), session: "session-one", turn: "turn-one" };
  const pending = {
    kind: "question", id: randomUUID(), target, expires: new Date(Date.now() + 60_000).toISOString(),
    questions: [{ id: "test-path", text: "Which fixture?", options: ["small", "large"], multiple: false }],
  };
  const sync = { type: "job", job: id, lease: job.spec.lease, events: [], receipts: [], target, pending };
  expect((await request(path, runtime, sync)).status).toBe(200);
  expect(JobAttention.parse(await (await request("/v2/execution/attention")).json())).toEqual([
    { job: id, task: null, kind: "question", expires: pending.expires },
  ]);
  const action = {
    action: "answer", prompt_id: pending.id, target, answers: [{ question: "test-path", values: ["small"] }], request_id: randomUUID(),
  };
  expect((await request(`${url}/actions`, agent, action)).status).toBe(403);
  expect((await request(`${url}/actions`, human, { ...action, target: { ...target, turn: "stale" } })).status).toBe(409);
  expect((await request(`${url}/actions`, human, { ...action, answers: [{ question: "test-path", values: ["typo"] }] })).status).toBe(400);
  const first = await request(`${url}/actions`, human, action);
  expect(first.status).toBe(202);
  const queued = JobActionReceipt.parse(await first.json());
  expect(queued.state).toBe("queued");
  expect(await (await request(`${url}/actions`, human, action)).json()).toEqual(queued);
  expect((await request(`${url}/actions`, human, { ...action, request_id: randomUUID() })).status).toBe(409);
  expect(JobActivityAck.parse(await (await request(path, runtime, sync)).json())).toMatchObject({ actions: [action] });
  const apply = { request_id: action.request_id, state: "applied", at: new Date().toISOString() };
  expect(JobActivityAck.parse(await (await request(path, runtime, { ...sync, pending: null, receipts: [apply] })).json())).toMatchObject({
    actions: [], receipts: [{ request_id: action.request_id, state: "applied" }],
  });
  const nextPrompt = { ...pending, id: randomUUID(), expires: new Date(Date.now() - 5000).toISOString() };
  expect((await request(path, runtime, { ...sync, pending: nextPrompt })).status).toBe(200);
  expect((await request(`${url}/actions`, human, { ...action, prompt_id: nextPrompt.id, request_id: randomUUID() })).status).toBe(409);
  await request(`${url}/cancel`, human, {});
  expect((await request(`${url}/actions`, human, { ...action, request_id: randomUUID() })).status).toBe(409);
  expect(JobActivityAck.parse(await (await request(path, runtime, sync)).json())).toMatchObject({ actions: [], cancel: true });
  expect(JobAttention.parse(await (await request("/v2/execution/attention")).json())).toEqual([]);
});

async function activityRuntime(reuse = false) {
  const bin = join(temp, "agents"), project = join(temp, "project");
  await mkdir(bin); await mkdir(project);
  const engine = await readFile(new URL("./fixtures/job-activity-engine.ts", import.meta.url), "utf8");
  for (const name of ["codex", "claude"]) {
    await writeFile(join(bin, name), `#!${process.execPath}\n${engine}`, { mode: 0o700 });
  }
  await startRuntime(undefined, undefined, {
    PATH: `${bin}:/usr/bin:/bin`, LUMIO_INTERACTIVE_JOB_ROOTS: project,
    ...(reuse ? { LUMIO_NATIVE_SESSIONS: "1", LUMIO_NATIVE_CODEX: join(bin, "codex") }
      : { LUMIO_JOB_CODEX_API_KEY: "synthetic-codex-key", LUMIO_JOB_CLAUDE_API_KEY: "synthetic-claude-key" }),
  });
  await eventually(async () => {
    const list = await (await request("/v2/execution/activity/capabilities")).json() as { engines: unknown[] }[];
    return !!list[0]?.engines.length;
  });
  return project;
}

test("a dispatched headless Job shows the first tool before completion through the actual Runtime", async () => {
  const project = await activityRuntime();
  const result = await request("/v2/execution/jobs", human, { runtime: "server", workdir: project, run: { kind: "agent", engine: "codex", prompt: "Review fixture" } });
  expect(result.status).toBe(200);
  const id = Job.parse(await result.json()).spec.id, url = `/v2/execution/jobs/${id}`;
  await eventually(async () => {
    const live = JobLiveView.parse(await (await request(`${url}/live`)).json());
    return live.status === "running" && live.active_tools.some(tool => tool.label === "bun test");
  }, 5000);
  await eventually(async () => (await get(id)).status === "done");
  expect((await get(id)).result?.report).toBe("Report from the synthetic Codex");
  await eventually(async () => JobLiveView.parse(await (await request(`${url}/live`)).json()).phase === "finishing");
  const page = JobActivityPage.parse(await (await request(`${url}/events`)).json());
  expect(JSON.stringify(page)).not.toContain("fixture_only");
});

test.skipIf(process.platform !== "darwin")("Codex App Server and the Claude Agent SDK apply same-round answers and approvals", async () => {
  const project = await activityRuntime();
  for (const engine of ["codex", "claude-code"] as const) {
    const response = await request("/v2/execution/jobs", human, {
      runtime: "server", workdir: project, run: { kind: "agent", engine, prompt: "Run synthetic interaction", interaction: "interactive" },
    });
    expect(response.status).toBe(200);
    const id = Job.parse(await response.json()).spec.id, url = `/v2/execution/jobs/${id}`;
    const view = async () => JobLiveView.parse(await (await request(`${url}/live`)).json());
    const waitFor = async (kind: "question" | "approval") => {
      await eventually(async () => {
        const live = await view();
        if (["failed", "unknown", "done"].includes(live.status)) { const r = (await get(id)).result; throw new Error(JSON.stringify({ report: r?.report, error: r?.error, log: r?.log ? await readFile(r.log, "utf8").catch(() => "") : "" })); }
        return live.pending?.kind === kind;
      });
      return (await view()).pending!;
    };
    const q = await waitFor("question");
    if (q.kind !== "question") throw new Error("Expected question");
    const answer = { action: "answer", target: q.target, prompt_id: q.id, request_id: randomUUID(), answers: [{ question: q.questions[0]!.id, values: ["Yes"] }] };
    expect((await request(`${url}/actions`, human, answer)).status).toBe(202);
    const a = await waitFor("approval");
    if (a.kind !== "approval") throw new Error("Expected approval");
    expect(a.can_approve).toBe(true);
    const approve = { action: "approve", target: a.target, prompt_id: a.id, request_id: randomUUID() };
    expect((await request(`${url}/actions`, human, approve)).status).toBe(202);
    await eventually(async () => (await get(id)).status === "done");
    expect((await get(id)).result?.report).toBe(`Fixture answer=Yes decision=${engine === "codex" ? "accept" : "allow"}`);
    await eventually(async () => (await view()).receipts.filter(receipt => receipt.state === "applied").length === 2);
  }
}, 30_000);

test.skipIf(process.platform !== "darwin")("an existing Codex login drives a Work Job through refresh, questions and approval and is revoked on logout", async () => {
  const project = await activityRuntime(true);
  const connection = AIConnection.parse(await (await request("/v2/ai/connections", human, {
    name: "Fixture Codex", host: "server", kind: "codex-account",
  })).json());
  const auth = `/v2/ai/connections/${connection.id}/auth`;
  const connect = async () => NativeConnectionView.parse(await (await request(auth)).json());
  const codexHome = join(runtimeState, "native-accounts", connection.id, "codex");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const claims = Buffer.from(JSON.stringify({ sub: "fixture-codex-user", exp: Math.floor(Date.now() / 1000) + 3600, fixture: 0 })).toString("base64url");
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {
    access_token: `eyJhbGciOiJub25lIn0.${claims}.fixture-job-login`, account_id: "fixture-account",
  } }), { mode: 0o600 });
  let authState: NativeConnectionView | undefined;
  await eventually(async () => (authState = await connect()).state === "ready")
    .catch(() => { throw new Error(`Fixture sign-in failed: ${authState?.state} (${authState?.error ?? "no error"})`); });
  const capabilities = JobActivityCapabilities.parse(await (await request("/v2/execution/activity/capabilities")).json());
  expect(capabilities[0]).toMatchObject({ codex_connections: [{ id: connection.id, name: connection.name }],
    engines: expect.arrayContaining([expect.objectContaining({ engine: "codex", account_reuse: true, approvals: false })]) });

  const work = async (op: string, args: object) => {
    const response = await request("/v2/work/commands", human, WorkCommandRequest.parse({ request_id: randomUUID(), operation: { op, args } }));
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));
    return WorkCommandResult.parse(body);
  };
  const task = await work("work.task.create", { title: "Synthetic Codex account", workdir: project });
  if (task.kind !== "task") throw new Error("Expected fixture task");
  const dispatched = await work("work.task.dispatch", { task: task.task.id, to: "codex@server", expected_revision: task.task.revision, interaction: "interactive" });
  if (dispatched.kind !== "job") throw new Error("Expected an assigned job");
  const id = dispatched.job.spec.id, path = `/v2/execution/jobs/${id}`;
  expect(JSON.stringify(dispatched)).not.toContain(connection.id);
  const live = async (job = path) => JobLiveView.parse(await (await request(`${job}/live`)).json());
  await eventually(async () => (await live()).pending?.kind === "question", 9000).catch(async () => {
    const state = await live(), job = await get(id);
    const logPath = job.result?.log ?? join(runtimeState, "logs", `${id}.log`);
    throw new Error(JSON.stringify({ status: state.status, phase: state.phase, pending: state.pending?.kind,
      report: job.result?.report, error: job.result?.error, log: await readFile(logPath, "utf8").catch(() => "") }));
  });
  expect((await live()).capability).toMatchObject({ approvals: true, questions: true, steer: true });
  const q = (await live()).pending!;
  if (q.kind !== "question") throw new Error("Expected question");
  expect((await request(`${path}/actions`, human, { action: "answer", request_id: randomUUID(), prompt_id: q.id, target: q.target,
    answers: [{ question: q.questions[0]!.id, values: ["Yes"] }] })).status).toBe(202);
  await eventually(async () => (await live()).pending?.kind === "approval");
  const approve = (await live()).pending!;
  expect((await request(`${path}/actions`, human, { action: "approve", request_id: randomUUID(), prompt_id: approve.id, target: approve.target })).status).toBe(202);
  await eventually(async () => (await get(id)).status === "done");
  const { result } = await get(id);
  expect(result?.report).toBe("Fixture answer=Yes decision=accept token=[REDACTED]");
  expect(await readFile(result!.log!, "utf8")).not.toContain("fixture-job-login");
  expect((await request(`${path}/events`)).ok).toBe(true);

  const response = await request("/v2/execution/jobs", human, { runtime: "server", workdir: project, connection: connection.id,
    run: { kind: "agent", engine: "codex", prompt: "Test revoked consent", interaction: "interactive" } });
  expect(response.status).toBe(200);
  const revoking = Job.parse(await response.json()).spec.id, revokedPath = `/v2/execution/jobs/${revoking}`;
  await eventually(async () => (await live(revokedPath)).pending?.kind === "question");
  const pending = (await live(revokedPath)).pending!;
  expect(NativeConnectionView.parse(await (await request(auth, human, { action: "logout", request_id: randomUUID() })).json()).state).toBe("signed_out");
  expect((await request(`${revokedPath}/actions`, human, { action: "deny", request_id: randomUUID(), prompt_id: pending.id, target: pending.target })).status).toBe(409);
  await eventually(async () => (await get(revoking)).status === "cancelled");
  expect((await live(revokedPath)).pending).toBeNull();
}, 30_000);

test("job account selection and the Runtime-only binding reject foreign owners and ambiguous connections", async () => {
  const primary = RuntimeRegistered.parse(await (await request("/v1/runtime/register", runtime, { ...registration,
    engines: [{ name: "codex", version: "0.166.0", sandbox: "os" }],
  })).json());
  expect((await request("/v1/runtime/job-activity/sync", runtime, { type: "register", platform: "darwin", engines: [
    { engine: "codex", version: "0.166.0", progress: true, sandbox: "os", approvals: false, questions: false, steer: false, account_reuse: true },
  ] })).ok).toBe(true);
  const make = async (name: string, token = human) => AIConnection.parse(await (await request("/v2/ai/connections", token,
    { name, kind: "codex-account", host: "server" })).json());
  const foreign = hub!.store.createActor("another-human", "human"), otherHuman = hub!.store.createToken("another-human", foreign.name);
  const first = await make("First"), second = await make("Second"), invalid = await make("Other human's connection", otherHuman);
  for (const account of [first, second, invalid]) hub!.store.aiStore.putQuota(account.id, {
    settings: { monitor: true, thresholds: {} }, status: "waiting", binding: JSON.stringify([primary.actor, "a".repeat(64), 1]),
  });
  const caps = JobActivityCapabilities.parse(await (await request("/v2/execution/activity/capabilities")).json());
  expect(caps[0]!.codex_connections?.map(connection => connection.id).sort()).toEqual([first.id, second.id].sort());
  const submit = (connection?: string, token = human) => request("/v2/execution/jobs", token, { runtime: "server", connection,
    run: { kind: "agent", engine: "codex", interaction: "interactive", prompt: "Synthetic delegated work" } });
  expect((await submit()).status).toBe(400);
  expect((await submit(invalid.id)).status).toBe(400);
  expect((await submit(first.id, agent)).status).toBe(403);
  const job = Job.parse(await (await submit(first.id)).json());
  expect(JSON.stringify(await get(job.spec.id))).not.toContain(first.id);
  const old = RuntimeSync.parse(await (await request("/v1/runtime/sync", runtime, heartbeat)).json());
  expect(old.jobs).toEqual([]);
  expect(old.accounts).toBeUndefined();
  const sync = RuntimeSync.parse(await (await request("/v1/runtime/sync", runtime, heartbeat, JOB_ACCOUNT_FEATURE)).json());
  expect(sync.jobs.map(job => job.id)).toEqual([job.spec.id]);
  expect(sync.accounts).toEqual([{ job: job.spec.id, connection: first.id, owner: first.owner, account: "a".repeat(64), generation: 1, revision: first.revision }]);
  expect(JSON.stringify(sync.jobs)).not.toContain(first.id);
});

test("both local interactive Job entry points exclude the Hub's private directories", async () => {
  await hub!.stop();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state }), port: 0, localRuntime: "server" }, { log: () => {} });
  port = hub.server.port!;
  const engine = { name: "codex", version: "0.166.0", sandbox: "os" };
  await request("/v1/runtime/register", runtime, { ...registration, engines: [engine] });
  await request("/v1/runtime/job-activity/sync", runtime, { type: "register", platform: "darwin", engines: [
    { engine: engine.name, version: engine.version, sandbox: engine.sandbox, progress: true, questions: true, approvals: true, steer: true },
  ] });
  const project = join(temp, "project"), alias = join(temp, "alias");
  await mkdir(project);
  await symlink(vault, alias);
  const direct = (workdir: string) => request("/v2/execution/jobs", human, { runtime: "server", workdir,
    run: { kind: "agent", engine: "codex", interaction: "interactive", prompt: "Synthetic directory check" } });
  for (const path of [vault, state, alias, temp]) expect((await direct(path)).status).toBe(400);
  expect(Job.parse(await (await direct(project)).json()).spec.workdir).toBe(project);
  const work = (op: string, args: object) => request("/v2/work/commands", human,
    WorkCommandRequest.parse({ request_id: randomUUID(), operation: { op, args } }));
  const task = WorkCommandResult.parse(await (await work("work.task.create", { title: "Synthetic directory check", workdir: alias })).json());
  if (task.kind !== "task") throw new Error("Expected a fixture task");
  expect((await work("work.task.dispatch", { task: task.task.id, to: "codex@server", interaction: "interactive" })).status).toBe(400);
});

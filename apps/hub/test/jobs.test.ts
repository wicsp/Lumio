import { Jobs } from "../src/jobs.ts";
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
import { PROJECT_WORKTREE_FEATURE, AgentConcurrencyUpdate, AgentConcurrencyView, type WorkTask, ApiError, Job, JobResult, RuntimeAck, RuntimeInfo, RuntimeRegistered, RuntimeSync, StoredArtifact, RunLogEvent, BackupManifest } from "@lumio/schema";
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

test("a managed runtime can overlap commands despite a legacy device value of one", async () => {
  await startRuntime();
  const first = await submit("quiet", join(temp, "first"), 1000);
  const second = await submit("quiet", join(temp, "second"), 1000);
  await eventually(async () => (await get(first.spec.id)).status === "running" && (await get(second.spec.id)).status === "running");
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

test("project admission survives retries and limits jobs across runtimes", async () => {
  const engines = [{ name: "codex", version: "0.166.0", sandbox: "os" }];
  const register = async (token: string, name: string, feature?: string) =>
    RuntimeRegistered.parse(await (await request("/v1/runtime/register", token, { ...registration, name, engines }, feature)).json());
  await register(runtime, "server", PROJECT_WORKTREE_FEATURE);
  await register(other, "other");
  const command = async (operation: unknown) => {
    const input = WorkCommandRequest.parse({ operation, request_id: randomUUID() });
    return request("/v2/work/commands", human, input);
  };
  const read = async (operation: unknown) => WorkCommandResult.parse(await (await command(operation)).json());
  const project = await read({ op: "work.project.create", args: {
    title: "Synthetic project", workdir: "/synthetic/project", worktree_base: "release/fixture",
  } });
  if (project.kind !== "project") throw new Error("Expected a project");
  const tasks: WorkTask[] = [];
  for (const title of ["One", "Two", "Three"]) {
    const result = await read({ op: "work.task.create", args: { title, project: project.project.id } });
    if (result.kind !== "task") throw new Error("Expected a task");
    tasks.push(result.task);
  }
  const dispatch = async (task: typeof tasks[number], to: string) =>
    read({ op: "work.task.dispatch", args: { task: task.id, expected_revision: task.revision, to } });
  const first = await dispatch(tasks[0]!, "codex@server");
  const second = await dispatch(tasks[1]!, "codex@other");
  await dispatch(tasks[2]!, "codex@other");
  if (first.kind !== "job" || second.kind !== "job") throw new Error("Expected jobs");
  const sync = async (token: string, feature?: string) =>
    RuntimeSync.parse(await (await request("/v1/runtime/sync", token, heartbeat, feature)).json());
  expect((await sync(runtime)).jobs.map(job => job.id)).toEqual([first.job.spec.id]);
  await hub!.stop();
  hub = await boot();
  port = hub.server.port!;
  expect((await sync(runtime)).jobs.map(job => job.id)).toEqual([first.job.spec.id]);
  expect((await sync(other)).jobs).toEqual([]);
  const update = await read({ op: "work.project.update", args: { project: project.project.id, expected_revision: project.project.revision, patch: { max_concurrent: 2 } } });
  if (update.kind !== "project") throw new Error("Expected an updated project");
  expect((await sync(other)).jobs.map(job => job.id)).toEqual([second.job.spec.id]);
  const reset = await read({ op: "work.project.update", args: { project: project.project.id, expected_revision: update.project.revision, patch: { max_concurrent: 1, auto_worktree: true } } });
  if (reset.kind !== "project") throw new Error("Expected an updated project");
  expect((await sync(other)).jobs.map(job => job.id)).toEqual([second.job.spec.id]);
  for (const [token, result] of [[runtime, first], [other, second]] as const) {
    const spec = result.job.spec;
    await request("/v1/runtime/ack", token, { accepted: [spec.id] });
    const response = await request("/v1/runtime/results", token, JobResult.parse({ job: spec.id, lease: spec.lease, status: "done", finished: new Date().toISOString() }));
    expect(response.status).toBe(200);
  }
  const remaining = (await sync(other)).jobs[0];
  if (!remaining) throw new Error("Expected a third admitted job");
  const added = await read({ op: "work.task.create", args: { title: "Managed checkout", project: project.project.id } });
  if (added.kind !== "task") throw new Error("Expected a task");
  const rejected = await read({ op: "work.task.dispatch", args: { task: added.task.id, to: "codex@other" } });
  if (rejected.kind !== "task") throw new Error("Expected refusal without dispatch");
  expect(rejected.task.turn).toMatchObject({ holder: "human", reason: "failed" });
  const managed = await dispatch(rejected.task, "codex@server");
  if (managed.kind !== "job") throw new Error("Expected a job");
  expect(managed.job.spec.worktree).toMatchObject({ project: project.project.id, task: added.task.id, base: "release/fixture" });
  expect((await sync(runtime, PROJECT_WORKTREE_FEATURE)).jobs).toEqual([]);
  const cancel = await request(`/v2/execution/jobs/${remaining.id}/cancel`, human, {});
  expect(cancel.status).toBe(200);
  const redelivery = await sync(other);
  expect(redelivery.jobs.map(job => job.id)).toEqual([remaining.id]);
  expect(redelivery.cancel).toEqual([remaining.id]);
  expect((await sync(runtime, PROJECT_WORKTREE_FEATURE)).jobs).toEqual([]);
  await request("/v1/runtime/ack", other, { accepted: [remaining.id] });
  expect((await request("/v1/runtime/results", other, JobResult.parse({
    job: remaining.id, lease: remaining.lease, status: "cancelled", finished: new Date().toISOString(),
  }))).status).toBe(200);
  expect((await sync(runtime)).jobs).toEqual([]);
  expect((await sync(runtime, PROJECT_WORKTREE_FEATURE)).jobs.map(job => job.id)).toEqual([managed.job.spec.id]);
});

test("account admission is shared across Runtime registrations and settings apply immediately", async () => {
  const actor = hub!.store.actors().find(value => value.name === "owner")!.id;
  const engines = ["codex", "claude-code", "pi"].map(name => ({ name, version: "synthetic", sandbox: "none" }));
  const left = RuntimeRegistered.parse(await (await request("/v1/runtime/register", runtime, { ...registration, engines })).json());
  const right = RuntimeRegistered.parse(await (await request("/v1/runtime/register", other, { ...registration, name: "other", engines })).json());
  const jobs = new Jobs(hub!.store);
  const create = (device: string, engine: "codex" | "claude-code" | "pi", account?: string, model?: string) => {
    const job = jobs.create({ runtime: device, workdir: "~", timeout_seconds: 120,
      run: { kind: "agent", engine, prompt: "Synthetic", model, ...(account ? { interaction: "interactive" as const } : {}) } }, new Date());
    if (account) hub!.store.jobActivity.bindAccount({ job: job.spec.id, account, owner: actor,
      connection: device === left.actor ? "aic_00000000000000000000000001" : "aic_00000000000000000000000002",
      revision: 1, generation: 1 });
    return job;
  };
  const sync = async (token: string) => RuntimeSync.parse(await (await request("/v1/runtime/sync", token, heartbeat, JOB_ACCOUNT_FEATURE)).json());
  const shared = "a".repeat(64), separate = "b".repeat(64);
  const first = Array.from({ length: 3 }, () => create(left.actor, "codex", shared));
  const fourth = create(right.actor, "codex", shared), fifth = create(right.actor, "codex", shared);
  const independent = create(right.actor, "codex", separate);
  expect((await sync(runtime)).jobs.map(spec => spec.id)).toEqual(first.map(job => job.spec.id));
  expect((await sync(other)).jobs.map(spec => spec.id)).toEqual([fourth.spec.id, independent.spec.id]);
  await request("/v1/runtime/register", runtime, { ...registration, engines });
  expect((await sync(other)).jobs.map(spec => spec.id)).toEqual([fourth.spec.id, independent.spec.id]);

  const set = async (input: AgentConcurrencyUpdate, token = human) => {
    const response = await fetch(base() + "/v2/ai/concurrency", {
      method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(AgentConcurrencyUpdate.parse(input)),
    });
    return response;
  };
  const leftPi = { kind: "runtime", runtime: left.actor, engine: "pi" } as const;
  expect((await set({ target: leftPi, group: "pi-shared", max_concurrent: 100 }, agent)).status).toBe(403);
  for (const id of [left.actor, right.actor]) {
    const response = await set({ target: { ...leftPi, runtime: id }, group: "pi-shared", max_concurrent: 100 });
    const sharedRows = AgentConcurrencyView.parse(await response.json()).filter(row => row.group === "pi-shared");
    expect(sharedRows.length).toBeGreaterThan(0);
    expect(sharedRows.every(row => row.max_concurrent === 100)).toBe(true);
  }
  const claude = [create(left.actor, "claude-code"), create(left.actor, "claude-code"), create(right.actor, "claude-code")];
  const pi = Array.from({ length: 101 }, (_, n) => create(n < 51 ? left.actor : right.actor, "pi"));
  const leftJobs = (await sync(runtime)).jobs.map(spec => spec.id);
  expect(leftJobs).toContain(claude[0]!.spec.id);
  expect(leftJobs).toContain(claude[1]!.spec.id);
  const rightJobs = (await sync(other)).jobs.map(spec => spec.id);
  expect(rightJobs).not.toContain(claude[2]!.spec.id);
  expect(rightJobs).not.toContain(fifth.spec.id);
  expect(rightJobs).not.toContain(pi.at(-1)!.spec.id);
  expect([...leftJobs, ...rightJobs].filter(id => pi.some(job => job.spec.id === id))).toHaveLength(100);
  const local = create(left.actor, "pi", undefined, "local/synthetic");
  const provider = await set({ target: { ...leftPi, backend: "local" }, group: "local-backend", max_concurrent: 1 });
  expect(AgentConcurrencyView.parse(await provider.json())).toContainEqual(
    expect.objectContaining({ group: "local-backend", max_concurrent: 1 }));
  expect((await sync(runtime)).jobs.map(spec => spec.id)).toContain(local.spec.id);
  await set({ target: leftPi, group: "pi-shared", max_concurrent: 101 });
  expect((await sync(other)).jobs.map(spec => spec.id)).toContain(pi.at(-1)!.spec.id);
  await set({ target: leftPi, group: "pi-shared", max_concurrent: 2 });
  const afterDecrease = create(right.actor, "pi");
  const held = (await sync(other)).jobs.map(spec => spec.id);
  expect(held).toContain(pi.at(-1)!.spec.id);
  expect(held).not.toContain(afterDecrease.spec.id);


  const released = first[0]!.spec;
  await request("/v1/runtime/ack", runtime, { accepted: [released.id] });
  expect((await request("/v1/runtime/results", runtime, JobResult.parse({
    job: released.id, lease: released.lease, status: "done", finished: new Date().toISOString(),
  }))).status).toBe(200);
  expect((await sync(other)).jobs.map(spec => spec.id)).toContain(fifth.spec.id);
});

test("Job activity uses device connectivity while waiting and job heartbeats once running", async () => {
  RuntimeRegistered.parse(await (await request("/v1/runtime/register", runtime, registration)).json());
  const job = await submit(), id = job.spec.id, url = `/v2/execution/jobs/${id}/live`;
  const live = async () => JobLiveView.parse(await (await request(url)).json());
  expect(await live()).toMatchObject({ status: "queued", connected: true });
  await request("/v1/runtime/ack", runtime, { accepted: [id] });
  const assigned = await get(id);
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  hub!.store.executionStore.save({ ...assigned, assigned: old });
  expect(await live()).toMatchObject({ status: "assigned", connected: true, last_heartbeat: null });

  await request("/v1/runtime/sync", runtime, { ...heartbeat, running: [id] });
  expect(await live()).toMatchObject({ status: "running", connected: true });
  hub!.store.executionStore.save({ ...await get(id), last_seen: old });
  expect(await live()).toMatchObject({ status: "running", connected: false });
});

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

test("a real Runtime uses the default base to execute and continue tasks in separate project worktrees", async () => {
  const repository = join(temp, "repository"), bin = join(temp, "bin");
  await mkdir(repository); await mkdir(bin);
  const env = { HOME: temp, PATH: `${bin}:/usr/bin:/bin` };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-b", "main");
  await writeFile(join(repository, "source.txt"), "original");
  git("add", "source.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture: initial");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  await writeFile(join(bin, "codex"), `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
if (process.argv[2] === "--version") console.log("codex-cli 0.166.0");
else {
  appendFileSync("working.txt", "round\\n");
  writeFileSync(process.argv[process.argv.indexOf("--output-last-message") + 1], "Synthetic report");
}
`, { mode: 0o700 });
  await startRuntime(undefined, undefined, { PATH: env.PATH, LUMIO_RUNTIME_MAX_CONCURRENT: "2" });
  const command = async (operation: unknown) => {
    const response = await request("/v2/work/commands", human, WorkCommandRequest.parse({ operation, request_id: randomUUID() }));
    const value = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    return WorkCommandResult.parse(value);
  };
  const project = await command({ op: "work.project.create", args: {
    title: "Managed project", workdir: repository, auto_worktree: true, max_concurrent: 2,
  } });
  if (project.kind !== "project") throw new Error("Expected a project");
  const task = async (title: string) => {
    const result = await command({ op: "work.task.create", args: { title, project: project.project.id } });
    if (result.kind !== "task") throw new Error("Expected a task");
    return result.task.id;
  };
  const dispatch = async (id: string) => {
    const result = await command({ op: "work.task.dispatch", args: { task: id, to: "codex@server" } });
    if (result.kind !== "job") throw new Error("Expected a job");
    return result.job;
  };
  const firstTask = await task("First task"), secondTask = await task("Second task");
  const first = await dispatch(firstTask), second = await dispatch(secondTask);
  expect(first.spec.worktree?.base).toBe("origin/main");
  const complete = async (job: Job) => {
    await eventually(async () => !!(await get(job.spec.id)).result);
    const result = (await get(job.spec.id)).result!;
    expect(result.status).toBe("done");
    if (!result.workspace) throw new Error("Expected a managed workspace");
    return result.workspace;
  };
  const [left, right] = await Promise.all([complete(first), complete(second)]);
  expect(left.path).not.toBe(right.path);
  expect(left.branch).not.toBe(right.branch);
  expect(await exists(join(repository, "working.txt"))).toBe(false);
  const next = await dispatch(firstTask);
  expect(next.spec.worktree?.reuse).toBe(true);
  expect(await complete(next)).toEqual(left);
  expect(await readFile(join(left.path, "working.txt"), "utf8")).toBe("round\nround\n");
  expect(await readFile(join(right.path, "working.txt"), "utf8")).toBe("round\n");
}, 20_000);

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

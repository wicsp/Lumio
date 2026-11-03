import { expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@lumio/api-client";
import { Job, WorkTask, WorkCommandRequest } from "@lumio/schema";
import { selftest } from "../src/selftest.ts";
import { doctor } from "../src/doctor.ts";
const hubMain = new URL("../../hub/src/main.ts", import.meta.url).pathname;
const runtimeMain = new URL("../../runtime/src/main.ts", import.meta.url).pathname;
const agentMain = new URL("fixtures/selftest-agent.ts", import.meta.url).pathname;
const git = Bun.which("git")!;
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(50); }
  throw new Error("fixture startup timed out");
}
test("selftest uses real Hub and runtime with fake codex, claude and pi; database tasks are retained as done and failures stay isolated", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumio-selftest-e2e-")), vault = join(home, "vault"), bin = join(home, "bin");
  const state = join(home, "hub"), sessions = join(home, "sessions"), mode = join(home, "mode");
  let hub: ReturnType<typeof Bun.spawn> | undefined, runtime: ReturnType<typeof Bun.spawn> | undefined;
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = probe.port!; await probe.stop(true);
  const url = `http://127.0.0.1:${port}`;
  const env = { HOME: home, PATH: `${bin}:${dirname(git)}:/usr/bin:/bin`, LUMIO_VAULT: vault, LUMIO_STATE_DIR: state, LUMIO_HUB_LISTEN: `127.0.0.1:${port}`, LUMIO_AUTOSAVE_IDLE: "3600" };
  function manage(...args: string[]) {
    const p = Bun.spawnSync([process.execPath, hubMain, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode) throw new Error(p.stderr.toString()); return p.stdout.toString().trim();
  }
  try {
    await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
    await mkdir(bin); await mkdir(sessions);
    for (const engine of ["codex", "claude", "pi"]) {
      const path = join(bin, engine);
      await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${agentMain}" ${engine} "$@"\n`); await chmod(path, 0o755);
    }
    manage("actor", "create", "owner", "--role", "human"); manage("actor", "create", "server", "--role", "runtime");
    const token = manage("token", "create", "owner", "--actor", "owner"), runtimeToken = manage("token", "create", "server", "--actor", "server");
    hub = Bun.spawn([process.execPath, hubMain], { env, stdout: "ignore", stderr: "ignore" });
    await eventually(async () => { try { return (await fetch(`${url}/health`)).ok; } catch { return false; } });
    runtime = Bun.spawn([process.execPath, runtimeMain], { env: { ...env, LUMIO_TOKEN: runtimeToken, LUMIO_HUB_URL: url, LUMIO_RUNTIME_NAME: "server", LUMIO_RUNTIME_STATE_DIR: join(home, "runtime"), LUMIO_RUNTIME_POLL_SECONDS: "0.05", FAKE_SESSIONS: sessions, FAKE_MODE_FILE: mode }, stdout: "ignore", stderr: "ignore" });
    const client = createClient({ url, token });
    await eventually(async () => (await client.runtimes()).length === 1);
    let results = await selftest({ url, token, notes: true, vault, pollMs: 50, timeoutMs: 60_000 });
    expect(results).toHaveLength(12);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    for (const r of results) { expect(r.elapsed_ms).toBeGreaterThanOrEqual(0); expect(Job.safeParse(await client.job(r.job!)).success).toBe(true); }
    expect((await readdir(join(vault, "plan/tasks"))).filter(n => n.startsWith("Lumio 自检"))).toEqual([]);
    const tasks = (await client.workTasks()).filter(task => task.title.startsWith("Lumio 自检")); expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      expect(WorkTask.parse(task).status).toBe("done");
      const detail = await client.workTask(task.id); expect(detail.executions).toHaveLength(4);
      expect(detail.executions.every(execution => execution.applied)).toBe(true); expect(detail.comments).toHaveLength(4);
    }
    for (const [failure, label] of [["forget", "接着会话"], ["no-question", "提问"], ["no-cancel", "取消"]]) {
      await writeFile(mode, failure!);
      // The actual runtime forcibly kills agents; suppressing the cancel delivery simulates a broken cancellation path.
      const fetcher = failure === "no-cancel" ? (async (input, init) => {
        if (String(input).endsWith("/cancel")) return fetch(String(input).slice(0, -7), { ...init, method: "GET", body: undefined });
        return fetch(input, init);
      }) as typeof fetch : undefined;
      results = await selftest({ url, token, agents: ["pi"], pollMs: 50, timeoutMs: 20_000, fetch: fetcher });
      expect(results.map((r) => [r.name, r.ok])).toEqual(["执行与汇报", "接着会话", "提问", "取消"].map((s) => [`pi ${s}`, s !== label]));
      expect(results.find((r) => !r.ok)!.fix).toContain("lumio job show job_");
    }
    expect((await selftest({ url, token, runtime: "missing" }))[0]!.ok).toBe(false);
    expect((await selftest({ url, token, agents: ["unknown"] }))[0]!.ok).toBe(false);
    // CLI doctor reads this synthetic vault's issues and validates the real API responses.
    await mkdir(join(home, ".config/lumio"), { recursive: true });
    await writeFile(join(home, ".config/lumio/config.json"), JSON.stringify({ hub_url: url, token }), { mode: 0o600 });
    const checks = await doctor({ home, env: {}, run: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(checks.find((c) => c.name === "Hub 令牌")!.ok).toBe(true); expect(checks.find((c) => c.name === "执行器列表")!.ok).toBe(true);
  } finally {
    runtime?.kill("SIGTERM"); await runtime?.exited;
    hub?.kill("SIGTERM"); await hub?.exited;
    await rm(home, { recursive: true, force: true });
  }
}, 150_000);

test("selftest enforces deadlines, continues checks, cancels unfinished database jobs and marks the task done", async () => {
  let time = 0, sequence = 0, cancelled = 0;
  const jobs = new Map<string, Job>(), date = "2026-10-29T00:00:00Z";
  let task = WorkTask.parse({ schema_version: 2, type: "task", id: "task_00000000000000000000000002", title: "自检", description: "", status: "todo", tags: [], dependencies: [], references: [], revision: 1, created: date, updated: date, assignee: "pi@server" });
  const fetcher = (async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname === "/v1/runtimes") return Response.json([{ actor: "act_00000000000000000000000001", registration: { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "1.4.0", sandbox: "none" }], tags: [], max_concurrent: 1 }, last_seen: date, online: true }]);
    if (u.pathname === "/v2/work/commands") {
      const { operation } = WorkCommandRequest.parse(JSON.parse(String(init?.body)));
      if (operation.op === "work.task.create") { task = WorkTask.parse({ ...task, ...operation.args }); return Response.json({ kind: "task", task }); }
      if (operation.op === "work.task.update") { task = WorkTask.parse({ ...task, ...operation.args.patch, revision: task.revision + 1 }); return Response.json({ kind: "task", task }); }
      sequence++;
      const job = Job.parse({ spec: { protocol_version: 2, id: `job_${String(sequence).padStart(26, "0")}`, runtime: "act_00000000000000000000000001", lease: "synthetic_lease_123456", source: { task: task.id, round: sequence }, run: { kind: "agent", engine: "pi", prompt: task.description }, workdir: "~", timeout_seconds: 1, created: date }, status: "running" });
      jobs.set(job.spec.id, job); return Response.json({ kind: "job", job });
    }
    if (u.pathname.startsWith("/v2/work/tasks/")) return Response.json({ task, executions: [], comments: [] });
    const id = u.pathname.split("/")[3]!;
    if (u.pathname.endsWith("/cancel")) cancelled++;
    return Response.json(jobs.get(id));
  }) as typeof fetch;
  const results = await selftest({ url: "http://synthetic", token: "synthetic", fetch: fetcher, timeoutMs: 100, cancelMs: 30, pollMs: 10, now: () => time, sleep: async ms => { time += ms; } });
  expect(results).toHaveLength(4); expect(results.every(r => !r.ok)).toBe(true);
  // Resume is skipped without a successful session, but independent later steps still run.
  expect(results.map(r => r.elapsed_ms)).toEqual([100, 0, 100, 30]);
  expect(sequence).toBe(3); expect(cancelled).toBe(4); expect(task.status).toBe("done");
});

test("--notes is a compatibility alias: no vault is needed or written even on failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "lumio-selftest-no-vault-"));
  try {
    const runtime = { actor: "act_00000000000000000000000001", registration: { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "1.4.0", sandbox: "none" }], tags: [], max_concurrent: 1 }, last_seen: "2026-10-29T00:00:00Z", online: true };
    const paths: string[] = [];
    const fetcher = (async (input) => {
      const path = new URL(String(input)).pathname; paths.push(path);
      if (path === "/v1/runtimes") return Response.json([runtime]);
      return Response.json({ error: { code: "INTERNAL", message: "synthetic job failure" } }, { status: 500 });
    }) as typeof fetch;
    const results = await selftest({ url: "http://synthetic", token: "synthetic", notes: true, vault: home, fetch: fetcher });
    expect(results).toHaveLength(4); expect(results.every(r => !r.ok)).toBe(true);
    expect(paths).toContain("/v2/work/commands"); expect(paths).not.toContain("/v1/jobs");
    expect(await readdir(home)).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

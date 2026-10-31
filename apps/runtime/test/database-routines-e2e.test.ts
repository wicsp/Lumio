import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionRoutine, Job } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { runRuntime } from "../src/runtime.ts";

// Only HTTP crosses the app boundary; all processes, credentials, engines and files are synthetic.
test("database Routine uses protocol 2 on a real runtime with no Knowledge, retains offline results and coalesces missed fires", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lumio-db-routine-")), state = join(temp, "hub"), runtimeState = join(temp, "runtime");
  const hubMain = new URL("../../hub/src/main.ts", import.meta.url).pathname;
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = probe.port!; await probe.stop(true);
  const url = `http://127.0.0.1:${port}`, env = { HOME: temp, PATH: temp, LUMIO_STATE_DIR: state, LUMIO_HUB_LISTEN: `127.0.0.1:${port}` };
  let hub: ReturnType<typeof Bun.spawn> | undefined, controller: AbortController | undefined, running: Promise<void> | undefined;
  let now = Date.parse("2026-10-26T10:05:00Z");
  const savedArgv = process.argv[1];
  async function eventually(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(30); }
    throw new Error("synthetic database routine timed out");
  }
  const manage = (...args: string[]) => {
    const child = Bun.spawnSync([process.execPath, hubMain, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode) throw new Error("synthetic management failed"); return child.stdout.toString().trim();
  };
  async function boot() { hub = Bun.spawn([process.execPath, hubMain], { env, stdout: "ignore", stderr: "ignore" }); await eventually(async () => { try { return (await fetch(`${url}/health`)).ok; } catch { return false; } }); }
  async function halt() { hub?.kill("SIGTERM"); await hub?.exited; hub = undefined; }
  function local<T>(sql: string): T[] { const db = new Database(join(runtimeState, "runtime.sqlite"), { readonly: true }); try { return db.query<T, []>(sql).all(); } finally { db.close(); } }
  try {
    await writeFile(join(temp, "pi"), `#!${process.execPath}\nif(process.argv[2]==='--version') console.log('1.4.0'); else console.log('合成定时结果');\n`, { mode: 0o700 });
    await chmod(join(temp, "pi"), 0o700);
    manage("actor", "create", "owner", "--role", "human"); manage("actor", "create", "server", "--role", "runtime");
    const human = manage("token", "create", "owner", "--actor", "owner"), token = manage("token", "create", "runtime", "--actor", "server");
    const api = async (path: string, body?: object) => {
      const response = await fetch(`${url}${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${human}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error(`synthetic HTTP ${response.status}`); return response.json();
    };
    await boot();
    const routine = ExecutionRoutine.parse(await api("/v2/execution/commands", { request_id: "synthetic-routine-e2e", operation: { op: "execution.routine.create", args: { title: "无知识目录的计划", schedule: "*/10 * * * *", timezone: "UTC", assignee: "pi@server", context: "previous" } } }));
    const config = readConfig({ LUMIO_HUB_URL: url, LUMIO_TOKEN: token, LUMIO_RUNTIME_NAME: "server", LUMIO_RUNTIME_POLL_SECONDS: "0.05", LUMIO_RUNTIME_STATE_DIR: runtimeState });
    const start = () => {
      controller = new AbortController();
      running = runRuntime(config, { signal: controller.signal, env: { HOME: temp, PATH: temp }, log() {}, now: () => new Date(now) });
    };
    const stop = async () => { controller?.abort(); await running; running = undefined; };
    process.argv[1] = new URL("../src/main.ts", import.meta.url).pathname;
    start();
    await eventually(() => { try { return local("SELECT * FROM routines").length === 1; } catch { return false; } });
    now = Date.parse("2026-10-26T10:10:30Z");
    await eventually(async () => Job.array().parse(await api(`/v1/jobs?routine=${routine.id}`))[0]?.status === "done");
    await eventually(() => local<{ spec: string }>("SELECT spec FROM routines")[0]!.spec.includes("上一次的汇报"));
    await halt(); now = Date.parse("2026-10-26T10:20:30Z");
    await eventually(() => local("SELECT * FROM outbox").length === 1);
    await boot(); await eventually(async () => Job.array().parse(await api(`/v1/jobs?routine=${routine.id}`)).length === 2);
    await eventually(() => local("SELECT * FROM outbox").length === 0);
    await stop(); now = Date.parse("2026-10-26T11:05:30Z"); start();
    await eventually(async () => Job.array().parse(await api(`/v1/jobs?routine=${routine.id}`)).filter((job) => job.status === "done").length === 3);
    const jobs = Job.array().parse(await api(`/v1/jobs?routine=${routine.id}`));
    expect(jobs.map((job) => job.spec.source?.fired_at)).toEqual(["2026-10-26T10:10:00.000Z", "2026-10-26T10:20:00.000Z", "2026-10-26T11:00:00.000Z"]);
    expect(jobs.every((job) => job.result?.report === "合成定时结果")).toBe(true);
    expect(await api("/v2/work/tasks")).toEqual([]);
    expect((await readFile(join(state, "config.json"), "utf8"))).not.toContain("vault");
    await stop();
  } finally {
    controller?.abort(); await running; await halt(); process.argv[1] = savedArgv!;
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Job, RoutineInfo } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { runRuntime } from "../src/runtime.ts";

// P2-5 端到端：真实的 Hub 进程 + 进程内的执行器（注入时钟）+ 假的 pi。
// 覆盖：到点触发、结果追加、context: previous、Hub 离线期间照常执行并在恢复后补写、执行器离线错过三次只补跑最近一次。
const R = "rtn_01M5AAAAAAAAAAAAAAAAAAAAR1";
const git = Bun.which("git")!;
const hubMain = new URL("../../hub/src/main.ts", import.meta.url).pathname;
let temp: string, vault: string, hubState: string, runtimeState: string, bin: string, log: string, port: number;
let hub: ReturnType<typeof Bun.spawn> | undefined;
let human: string, runtimeToken: string;
let now = Date.parse("2026-10-26T10:05:00Z");
let runtime: { controller: AbortController; done: Promise<void> } | undefined;
const originalArgv1 = process.argv[1];

function hubEnv() {
  return { PATH: dirname(git), HOME: temp, LUMIO_VAULT: vault, LUMIO_STATE_DIR: hubState, LUMIO_HUB_LISTEN: `127.0.0.1:${port}`, LUMIO_AUTOSAVE_IDLE: "3600" };
}
function manage(...args: string[]): string {
  const result = Bun.spawnSync([process.execPath, hubMain, ...args], { env: hubEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function startHub() {
  hub = Bun.spawn([process.execPath, hubMain], { env: hubEnv(), stdout: "ignore", stderr: "ignore" });
  await eventually(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } });
}
async function stopHub() { hub?.kill("SIGTERM"); await hub?.exited; hub = undefined; }
function startRuntime() {
  const controller = new AbortController();
  const config = readConfig({ LUMIO_HUB_URL: `http://127.0.0.1:${port}`, LUMIO_TOKEN: runtimeToken, LUMIO_RUNTIME_NAME: "server",
    LUMIO_RUNTIME_POLL_SECONDS: "0.1", LUMIO_RUNTIME_STATE_DIR: runtimeState });
  const done = runRuntime(config, { signal: controller.signal, log: () => {}, env: { PATH: `${bin}:${dirname(git)}`, HOME: temp, FAKE_LOG: log }, now: () => new Date(now) });
  runtime = { controller, done };
}
async function stopRuntime() { runtime?.controller.abort(); await runtime?.done; runtime = undefined; }
async function eventually(check: () => boolean | Promise<boolean>, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(50); }
  throw new Error("timed out");
}
const api = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${human}` } })).json();
const note = async () => (await readFile(join(vault, "plan/routines/日报.md"))).toString();
function local<T>(sql: string): T[] {
  const db = new Database(join(runtimeState, "runtime.sqlite"), { readonly: true });
  try { return db.query<T, []>(sql).all(); } finally { db.close(); }
}

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-routines-e2e-"));
  vault = join(temp, "vault"); hubState = join(temp, "hub"); runtimeState = join(temp, "runtime"); bin = join(temp, "bin"); log = join(temp, "prompts.log");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  await Bun.write(join(temp, "proj/README.md"), "proj\n");
  await Bun.write(join(bin, "pi.ts"), `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.4.0"); process.exit(0); }
const prompt = args[args.indexOf("-p") + 1];
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, prompt }) + "\\n");
console.log("日报：GPU 一切正常");
`);
  await writeFile(join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "pi.ts")}" "$@"\n`);
  await chmod(join(bin, "pi"), 0o755);
  await Bun.write(join(vault, "plan/routines/日报.md"), `---\nid: ${R}\ntype: routine\ntitle: 日报\ncreated: 2026-10-26T00:00:00Z\nupdated: 2026-10-26T00:00:00Z\n`
    + `schedule: "*/10 * * * *"\ntimezone: UTC\nassignee: {agent: pi, device: server}\ncontext: previous\nworkdir: ${join(temp, "proj")}\n---\n总结 GPU 使用情况。\n`);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); port = probe.port!; await probe.stop(true);
  manage("actor", "create", "owner", "--role", "human"); manage("actor", "create", "server", "--role", "runtime");
  human = manage("token", "create", "owner", "--actor", "owner"); runtimeToken = manage("token", "create", "server", "--actor", "server");
  // 执行器在进程内运行，执行每一轮时用 `bun <main.ts> --job-worker` 启动 worker。
  process.argv[1] = new URL("../src/main.ts", import.meta.url).pathname;
  await startHub();
});
afterAll(async () => {
  await stopRuntime(); await stopHub();
  process.argv[1] = originalArgv1!;
  await rm(temp, { recursive: true, force: true });
});

test("routines fire on the runtime's clock, survive Hub and runtime outages, and append results in order", async () => {
  startRuntime();
  // Hub 每 5 秒为还没有执行器的计划重新挑一次。
  await eventually(async () => RoutineInfo.array().parse(await api("/v1/routines"))[0]?.runtime === "server");
  await eventually(() => local<{ routine: string }>("SELECT routine FROM routines").length === 1);

  now = Date.parse("2026-10-26T10:10:30Z");
  await eventually(async () => (await note()).includes("### 2026-10-26 10:10 的结果"));
  expect(await note()).toContain("日报：GPU 一切正常");
  // context: previous —— 执行器拿到带上这一次摘要的新计划。
  await eventually(() => local<{ spec: string }>("SELECT spec FROM routines")[0]!.spec.includes("上一次的结果（2026-10-26 10:10）"));

  // Hub 离线：执行器照常触发并执行，结果留在待交回队列；Hub 恢复后补写。
  await stopHub();
  now = Date.parse("2026-10-26T10:20:30Z");
  await eventually(() => local<{ id: string }>("SELECT id FROM outbox").length === 1);
  await startHub();
  await eventually(async () => (await note()).includes("### 2026-10-26 10:20 的结果"));

  // 执行器离线错过 10:30、10:40、10:50、11:00：恢复后只补跑最近的 11:00。
  await stopRuntime();
  now = Date.parse("2026-10-26T11:05:30Z");
  startRuntime();
  await eventually(async () => (await note()).includes("### 2026-10-26 11:00 的结果"));
  const text = await note();
  expect(text).toContain("上一次之后有 3 次计划触发没有执行");
  expect(text.indexOf("10:10 的结果")).toBeLessThan(text.indexOf("10:20 的结果"));
  expect(text.indexOf("10:20 的结果")).toBeLessThan(text.indexOf("11:00 的结果"));
  const jobs = Job.array().parse(await api(`/v1/jobs?routine=${R}`));
  expect(jobs.map((j) => j.spec.source?.fired_at)).toEqual(["2026-10-26T10:10:00.000Z", "2026-10-26T10:20:00.000Z", "2026-10-26T11:00:00.000Z"]);
  expect(jobs.every((j) => j.status === "done")).toBe(true);
  const prompts = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; prompt: string });
  expect(prompts).toHaveLength(3);
  expect(prompts[0]!.prompt).not.toContain("上一次的结果");
  expect(prompts[1]!.prompt).toContain("上一次的结果（2026-10-26 10:10）");
  expect(prompts.every((p) => !p.args.includes("--session-id"))).toBe(true); // 每次都是新会话
}, 90_000);

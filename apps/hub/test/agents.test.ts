import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Job, RuntimeInfo } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { HubStore } from "../src/store.ts";

// P2-3：用假的 agent 程序端到端测试适配器（真实 agent 只做人工验证）。
let temp: string, bin: string, repo: string, fakeLog: string;
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let daemons: ReturnType<typeof Bun.spawn>[] = [];
let human: string, runtime: string;
const agentFixture = new URL("./fixtures/agent.ts", import.meta.url).pathname;
const git = Bun.which("git")!;
const base = () => `http://127.0.0.1:${hub!.server.port}`;
async function request(path: string, body?: unknown) {
  return fetch(`${base()}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${human}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function get(id: string) { return Job.parse(await (await request(`/v1/jobs/${id}`)).json()); }
async function eventually(check: () => boolean | Promise<boolean>, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(30); }
  throw new Error("timed out");
}
async function submit(run: object, fields: object = {}) {
  const response = await request("/v1/jobs", { runtime: "server", workdir: repo, run: { kind: "agent", ...run }, ...fields });
  return { response, job: response.status === 200 ? Job.parse(await response.json()) : undefined };
}
async function done(id: string) { await eventually(async () => (await get(id)).result !== undefined); return get(id); }
async function calls() { try { return (await readFile(fakeLog, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
async function startRuntime(env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, new URL("../../runtime/src/main.ts", import.meta.url).pathname], { env: {
    PATH: `${bin}:${dirname(git)}`, HOME: temp, LUMIO_HUB_URL: base(), LUMIO_TOKEN: runtime, LUMIO_RUNTIME_NAME: "server",
    LUMIO_RUNTIME_POLL_SECONDS: "0.03", LUMIO_RUNTIME_STATE_DIR: join(temp, "runtime"), FAKE_LOG: fakeLog, ...env,
  }, stdout: "pipe", stderr: "pipe" });
  daemons.push(child);
  await eventually(async () => RuntimeInfo.array().parse(await (await request("/v1/runtimes")).json()).length === 1);
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-agents-")); bin = join(temp, "bin"); repo = join(temp, "repo"); fakeLog = join(temp, "calls.jsonl");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, join(temp, "vault"), { recursive: true });
  for (const name of ["codex", "claude", "pi"]) {
    await Bun.write(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${agentFixture}" ${name} "$@"\n`);
    await chmod(join(bin, name), 0o755);
  }
  await Bun.write(join(repo, "README.md"), "repo\n");
  for (const a of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]]) Bun.spawnSync([git, "-C", repo, ...a]);
  const store = await HubStore.open(join(temp, "hub"));
  store.createActor("owner", "human"); store.createActor("server", "runtime");
  human = store.createToken("owner", "owner"); runtime = store.createToken("server", "server"); store.close();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: join(temp, "vault"), LUMIO_STATE_DIR: join(temp, "hub") }), port: 0 }, { log: () => {} });
});
afterEach(async () => {
  for (const child of daemons) { child.kill("SIGTERM"); await child.exited; }
  daemons = [];
  await hub?.stop(); hub = undefined;
  await rm(temp, { recursive: true, force: true });
});

test("registers fake agents; three engines run non-interactively and return report, session and engine info", async () => {
  await startRuntime();
  const engines = RuntimeInfo.array().parse(await (await request("/v1/runtimes")).json())[0]!.registration.engines;
  expect(engines.map((e) => [e.name, e.version, e.sandbox])).toEqual([["codex", "0.163.0", "os"], ["claude-code", "2.1.310", "none"], ["pi", "1.4.0", "none"]]);
  for (const engine of ["codex", "claude-code", "pi"] as const) {
    const { job } = await submit({ engine, prompt: `你好 ${engine}`, session: { id: "s-1", resume: false } });
    const r = (await done(job!.spec.id)).result!;
    expect(r.status).toBe("done");
    expect(r.report).toBe(`完成：你好 ${engine}`);
    expect(r.engine).toEqual(engines.find((e) => e.name === engine)!);
    expect(r.session_id).toBe(engine === "codex" ? "thr-fake-1" : "s-1");
    expect(await readFile(r.log!, "utf8")).toContain("agent stderr");
  }
  const recorded = await calls();
  expect(recorded.map((c) => c.stdin)).toEqual(["", "", ""]); // stdin 是 /dev/null
  expect(recorded.every((c) => c.cwd.endsWith("/repo"))).toBe(true);
  expect(recorded[0].args.slice(0, 5)).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--json"]);
  expect(recorded[1].args).toContain("bypassPermissions");
  expect(recorded[2].args).toEqual(["-p", "你好 pi", "--session-id", "s-1"]);
});

test("question marker ends the round as waiting_for_human; resume passes the session; failures and git state are recorded", async () => {
  await startRuntime();
  const asked = (await done((await submit({ engine: "pi", prompt: "ASK 一下", session: { id: "task_x", resume: false } })).job!.spec.id)).result!;
  expect(asked.status).toBe("waiting_for_human");
  expect(asked.question).toBe("要不要顺手重构？");
  expect(asked.report).toBe("完成：ASK 一下");
  const resumed = (await done((await submit({ engine: "codex", prompt: "继续", session: { id: "thr-7", resume: true } })).job!.spec.id)).result!;
  expect(resumed.session_id).toBe("thr-7");
  expect((await calls()).at(-1).args.slice(0, 2)).toEqual(["exec", "resume"]);
  const failed = (await done((await submit({ engine: "claude-code", prompt: "FAIL 了" })).job!.spec.id)).result!;
  expect(failed.status).toBe("failed"); expect(failed.exit_code).toBe(3);
  const head = Bun.spawnSync([git, "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
  const committed = (await done((await submit({ engine: "pi", prompt: "COMMIT 一个文件" })).job!.spec.id)).result!;
  expect(committed.git?.before).toEqual({ branch: expect.any(String), commit: head, dirty: false });
  expect(committed.git?.after?.commit).not.toBe(head);
  expect(committed.git?.after?.dirty).toBe(false);
});

test("versions outside the verified range fail without running; Hub rejects engines the runtime lacks; timeout kills the agent", async () => {
  await startRuntime({ FAKE_PI_VERSION: "2.0.1" });
  const before = (await calls()).length;
  const old = (await done((await submit({ engine: "pi", prompt: "不该执行" })).job!.spec.id)).result!;
  expect(old.status).toBe("failed"); expect(old.error).toContain("版本范围");
  expect((await calls()).length).toBe(before);
  const rejected = await submit({ engine: "codex", prompt: "x" }, { runtime: "nope" });
  expect(rejected.response.status).toBe(400);
  // 执行器上没有登记的 agent：先让 PATH 里只剩 pi 再重启执行器。
  for (const child of daemons) { child.kill("SIGTERM"); await child.exited; }
  daemons = [];
  await rm(join(bin, "codex"));
  await startRuntime();
  await eventually(async () => !RuntimeInfo.array().parse(await (await request("/v1/runtimes")).json())[0]!.registration.engines.some((e) => e.name === "codex"));
  expect((await submit({ engine: "codex", prompt: "x" })).response.status).toBe(400);
  const slow = (await done((await submit({ engine: "pi", prompt: "SLEEP" }, { timeout_seconds: 1 })).job!.spec.id)).result!;
  expect(slow.status).toBe("failed"); expect(slow.error).toBe("超时");
}, 40_000);

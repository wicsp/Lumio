import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { FSWatcher, watch } from "node:fs";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@lumio/core";
import { ApiError, Job, OperationResult, RuntimeInfo } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { HubStore } from "../src/store.ts";
import { lineDiff } from "../src/tasks.ts";

// P2-4：任务笔记里的一问一答，端到端（合成 vault + 假 agent）。
let temp: string, vault: string, bin: string, workdir: string;
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let daemons: ReturnType<typeof Bun.spawn>[] = [];
let human: string, agentToken: string, runtime: string;
let notify: (path: string) => void = () => {};
const agentFixture = new URL("./fixtures/agent.ts", import.meta.url).pathname;
const git = Bun.which("git")!;
const TASK = "task_01M5AAAAAAAAAAAAAAAAAAAAT1";
const path = "plan/tasks/加 XML 包装.md";
const base = () => `http://127.0.0.1:${hub!.server.port}`;
const file = () => join(vault, path);
async function request(p: string, body?: unknown, token = human) {
  return fetch(`${base()}${p}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function rounds() { return Job.array().parse(await (await request(`/v1/jobs?task=${TASK}`)).json()); }
async function eventually(check: () => boolean | Promise<boolean>, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(40); }
  throw new Error("timed out");
}
const note = async () => (await readFile(file())).toString();
const front = async () => parseFrontmatter(await readFile(file())).data;
async function writeNote(fields: Record<string, string>, body: string) {
  const header = Object.entries({ id: TASK, type: "task", title: "加 XML 包装", created: "2026-10-26T10:00:00+08:00", updated: "2026-10-26T10:00:00+08:00",
    status: "todo", assignee: "{agent: pi, device: server}", workdir, ...fields }).map(([k, v]) => `${k}: ${v}`).join("\n");
  await writeFile(file(), `---\n${header}\n---\n${body}`);
  notify(path);
}
async function setTurnAgent(append = "") {
  const text = (await note()).replace(/^turn: \w+$/m, "turn: agent") + append;
  await writeFile(file(), text.includes("turn: agent") ? text : text.replace("status:", "turn: agent\nstatus:"));
  notify(path);
}
async function startRuntime() {
  const child = Bun.spawn([process.execPath, new URL("../../runtime/src/main.ts", import.meta.url).pathname], { env: {
    PATH: `${bin}:${dirname(git)}`, HOME: temp, LUMIO_HUB_URL: base(), LUMIO_TOKEN: runtime, LUMIO_RUNTIME_NAME: "server",
    LUMIO_RUNTIME_POLL_SECONDS: "0.05", LUMIO_RUNTIME_STATE_DIR: join(temp, "runtime"),
  }, stdout: "pipe", stderr: "pipe" });
  daemons.push(child);
  await eventually(async () => RuntimeInfo.array().parse(await (await request("/v1/runtimes")).json()).length === 1);
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-tasks-")); vault = join(temp, "vault"); bin = join(temp, "bin"); workdir = join(temp, "proj");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  for (const name of ["codex", "claude", "pi"]) {
    await Bun.write(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${agentFixture}" ${name} "$@"\n`);
    await chmod(join(bin, name), 0o755);
  }
  await Bun.write(join(workdir, "README.md"), "proj\n");
  const store = await HubStore.open(join(temp, "hub"));
  store.createActor("owner", "human"); store.createActor("claude-code@mac", "agent"); store.createActor("server", "runtime");
  human = store.createToken("owner", "owner"); agentToken = store.createToken("agent", "claude-code@mac"); runtime = store.createToken("server", "server"); store.close();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: join(temp, "hub") }), port: 0, autosaveIdle: 3600 }, {
    log: () => {}, tasks: { quietMs: 400, tickMs: 50 },
    watch: { watch: ((_p, _o, callback) => {
      notify = (p) => (callback as (event: string, path: string) => void)("change", p);
      return Object.assign(new EventEmitter(), { close() {} }) as FSWatcher;
    }) as typeof watch },
  });
  await startRuntime();
});
afterEach(async () => {
  for (const child of daemons) { child.kill("SIGTERM"); await child.exited; }
  daemons = []; notify = () => {};
  await hub?.stop(); hub = undefined;
  await rm(temp, { recursive: true, force: true });
});

test("lineDiff reports added and removed lines", () => {
  expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual({ added: ["B", "d"], removed: ["b"] });
}, 30_000);

test("turn: agent → one round after the note is quiet; result block written; turn human; status active; human text untouched", async () => {
  const body = "要求：在 wrapper 里加一种 XML 格式。\n";
  await writeNote({ turn: "agent" }, body);
  notify(path); notify(path); // 同一修改被监听多次，只派一次
  await eventually(async () => (await rounds()).length === 1);
  await eventually(async () => (await front()).turn === "human");
  const text = await note();
  expect((await front()).status).toBe("active");
  expect(text).toContain("<!-- lumio:ai start name=round-1 job=");
  expect(text).toContain("### 第 1 轮 · 完成");
  expect(text).toContain("（pi 1.4.0 · 无沙箱 · server ·");
  expect(parseFrontmatter(Buffer.from(text)).body.toString().startsWith(body)).toBe(true);
  const [job] = await rounds();
  expect(job!.spec.source).toMatchObject({ task: TASK, round: 1 });
  expect(job!.spec.run.kind === "agent" && job!.spec.run.prompt).toContain("要求：在 wrapper 里加一种 XML 格式。");
  expect(job!.spec.run.kind === "agent" && job!.spec.run.session).toEqual({ id: TASK, resume: false });
  await Bun.sleep(800);
  expect(await rounds()).toHaveLength(1); // Hub 自己的写回不会再派
}, 30_000);

test("flipping turn back within the quiet window cancels the dispatch", async () => {
  await writeNote({ turn: "agent" }, "要求\n");
  await Bun.sleep(100);
  await writeFile(file(), (await note()).replace("turn: agent", "turn: human")); notify(path);
  await Bun.sleep(3500);
  expect(await rounds()).toHaveLength(0);
}, 30_000);

test("round 2 resumes the session and sends only what the human added; a question is shown and answered", async () => {
  await writeNote({ turn: "agent" }, "要求：ASK 一下要不要重构\n");
  await eventually(async () => (await front()).turn === "human");
  expect(await note()).toContain("### 第 1 轮 · 有问题等你回答");
  expect(await note()).toContain("> **问题**：要不要顺手重构？");
  await setTurnAgent("\n回答：不用重构，只加 XML。\n");
  await eventually(async () => (await rounds()).length === 2 && (await front()).turn === "human");
  const second = (await rounds())[1]!;
  expect(second.spec.source).toMatchObject({ task: TASK, round: 2, previous: (await rounds())[0]!.spec.id });
  const run = second.spec.run.kind === "agent" ? second.spec.run : undefined;
  expect(run?.session).toEqual({ id: TASK, resume: true });
  expect(run?.prompt).toContain("+ 回答：不用重构，只加 XML。");
  expect(run?.prompt).not.toContain("要求：ASK 一下要不要重构");
  expect(await note()).toContain("### 第 2 轮 · 完成");
}, 30_000);

test("without a session the next round gets the human text plus the last report", async () => {
  await writeNote({ turn: "agent", assignee: "{agent: codex, device: server}" }, "要求：NOSESSION 第一版\n");
  await eventually(async () => (await front()).turn === "human");
  await setTurnAgent("\n意见：再改改\n");
  await eventually(async () => (await rounds()).length === 2 && (await front()).turn === "human");
  const run = (await rounds())[1]!.spec.run;
  expect(run.kind === "agent" && run.session).toBeFalsy();
  expect(run.kind === "agent" && run.prompt).toContain("要求：NOSESSION 第一版");
  expect(run.kind === "agent" && run.prompt).toContain("意见：再改改");
  expect(run.kind === "agent" && run.prompt).toContain("## 上一轮的汇报");
}, 30_000);

test("pausing while a round runs cancels it; secrets in reports are not written to the note", async () => {
  await writeNote({ turn: "agent" }, "要求：SLEEP 很久\n");
  await eventually(async () => (await rounds())[0]?.status === "running");
  await writeFile(file(), (await note()).replace("status: active", "status: paused")); notify(path);
  await eventually(async () => (await front()).turn === "human");
  expect(await note()).toContain("### 第 1 轮 · 已取消");
  await writeFile(file(), (await note()).replace("status: paused", "status: active"));
  await setTurnAgent("\n这次：SECRET 打印一下\n");
  await eventually(async () => (await rounds()).length === 2 && (await front()).turn === "human");
  expect(await note()).toContain("汇报中疑似包含敏感信息");
  expect(await note()).not.toContain("sk-aaaa");
}, 40_000);

test("lumio task continue (CLI trigger) dispatches immediately; agents cannot dispatch; workdir inside the vault is refused", async () => {
  await writeNote({ turn: "human" }, "要求：马上做\n");
  const operation = { op: "task.dispatch", args: { task: TASK, trigger: "cli" } };
  const denied = await request("/v1/operations", { operation }, agentToken);
  expect(denied.status).toBe(403);
  expect(ApiError.parse(await denied.json()).error.reason).toBe("agent-cannot-dispatch-tasks");
  const ok = await request("/v1/operations", { operation });
  expect(ok.status).toBe(200); expect(OperationResult.parse(await ok.json()).status).toBe("applied");
  expect(await rounds()).toHaveLength(1);
  expect((await front()).turn).toBe("agent");
  await eventually(async () => (await front()).turn === "human");
  const busy = await request("/v1/operations", { operation });
  expect(busy.status).toBe(200); // 上一轮已结束，可以再派
  await eventually(async () => (await front()).turn === "human");
  const audit = hub!.store.db.query<{ operation: string; authorization: string }, []>("SELECT operation, authorization FROM audit WHERE operation LIKE '%task.dispatch%'").all();
  expect(audit.filter((a) => a.authorization === "allow")).toHaveLength(2);
  expect(audit.some((a) => a.authorization === "deny")).toBe(true);

  await writeNote({ turn: "agent", workdir: join(vault, "research") }, "要求：在笔记库里干活\n");
  await eventually(async () => (await note()).includes("### 无法派出"));
  expect(await note()).toContain("工作目录不能在笔记库里");
  expect((await front()).turn).toBe("human");
  expect(await rounds()).toHaveLength(2);
}, 40_000);

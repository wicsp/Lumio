import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { FSWatcher, watch } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, setFields } from "@lumio/knowledge";
import { ApiError, Job, JobResult, RuntimeRegistration } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { Jobs } from "../src/jobs.ts";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";

// 旧格式笔记 + 旧 task_state，启动真正的 Hub；执行器登记与结果均为合成模拟，不启动真实 agent。
const TASK = "task_00000000000000000000000021";
const ACTIVE = "plan/tasks/LegacyActive.md", DONE = "plan/tasks/LegacyDone.md";
let temp: string, vault: string, actor: string, human: string, time: number;
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
const bytes = (path = ACTIVE) => readFile(join(vault, path));
const front = async (path = ACTIVE) => parseFrontmatter(await bytes(path)).data;
const jobs = () => new Jobs(hub!.store);
async function edit(patch: Record<string, string>, notify = true) {
  await writeFile(join(vault, ACTIVE), setFields(await bytes(), patch));
  if (notify) await hub!.tasks.noteChanged(ACTIVE);
}
async function advance() { time += 31_000; await hub!.tasks.tick(); }
async function complete(job: Job) {
  jobs().ack(actor, [job.spec.id], new Date(time));
  jobs().result(actor, JobResult.parse({ job: job.spec.id, lease: job.spec.lease, status: "done", report: "假的 agent 合成汇报", finished: new Date(time).toISOString() }));
  await hub!.tasks.writeResults();
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-task-upgrade-")); vault = join(temp, "vault");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url), vault, { recursive: true });
  await cp(new URL("./fixtures/upgrade-vault", import.meta.url), vault, { recursive: true });
  time = Date.parse("2026-10-30T08:00:00Z");
  const state = join(temp, "hub"), store = await HubStore.open(state);
  store.db.exec(await readFile(new URL("./fixtures/task-upgrade.sql", import.meta.url), "utf8"));
  store.createActor("owner", "human"); actor = store.createActor("server", "runtime").id;
  human = store.createToken("owner", "owner");
  store.registerRuntime(actor, RuntimeRegistration.parse({ protocol_version: 2, name: "server", engines: [{ name: "pi", version: "1.4.0", sandbox: "none" }], tags: [], max_concurrent: 1 }), new Date(time));
  store.close();
  const clock = { now: () => time, set: () => undefined, clear: () => {} };
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state }), port: 0 }, {
    log() {}, now: () => new Date(time), tasks: { clock }, routines: { clock },
    watch: { clock, watch: (() => Object.assign(new EventEmitter(), { close() {} }) as FSWatcher) as typeof watch },
  });
});
afterEach(async () => { await hub?.stop(); hub = undefined; await rm(temp, { recursive: true, force: true }); });

test("upgrading last_turn=human never dispatches old active or done notes; old turn still dispatches and hands back without migration", async () => {
  const before = await bytes(), beforeDone = await bytes(DONE);
  await advance();
  expect(jobs().list()).toHaveLength(0);
  expect(await bytes()).toEqual(before); expect(await bytes(DONE)).toEqual(beforeDone);
  await edit({ turn: "agent" }); await advance();
  const [job] = Job.array().parse(jobs().list()); expect(jobs().list()).toHaveLength(1);
  expect(job!.spec).toMatchObject({ runtime: actor, source: { task: TASK, round: 1 } });
  await complete(job!);
  expect(await front()).toEqual({ ...parseFrontmatter(before).data, turn: "human" });
  expect((await bytes()).toString()).toContain("assignee: {agent: pi, device: server} # 保留旧负责人");
  expect(parseFrontmatter(await bytes()).body.toString()).toStartWith(parseFrontmatter(before).body.toString());
  expect(await bytes(DONE)).toEqual(beforeDone);
  await hub!.tasks.noteChanged(ACTIVE); await advance(); expect(jobs().list()).toHaveLength(1);
});

for (const status of ["done", "cancelled", "paused"]) {
  test(`new ${status} task does not dispatch until status is restored, including CLI attempts`, async () => {
    await writeFile(join(vault, ACTIVE), (await bytes()).toString().replace(/^turn:.*\n/m, ""));
    await edit({ status, assignee: "human" });
    await edit({ assignee: "pi@server" }); await advance();
    expect(jobs().list()).toHaveLength(0);
    const before = await bytes();
    const response = await fetch(`http://127.0.0.1:${hub!.server.port}/v1/operations`, {
      method: "POST", headers: { Authorization: `Bearer ${human}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: { op: "task.dispatch", args: { task: TASK, trigger: "cli", to: "pi@server" } } }),
    });
    expect(response.status).toBe(409); expect(ApiError.parse(await response.json()).error.message).toContain("status 改回 active 或 todo");
    expect(await bytes()).toEqual(before); expect(jobs().list()).toHaveLength(0);
    await edit({ status: "active" }); await advance(); expect(jobs().list()).toHaveLength(1);
  });
  test(`dispatch rechecks ${status} after the quiet window even if the watcher missed that edit`, async () => {
    await edit({ turn: "agent" }); await edit({ status }, false);
    const before = await bytes(); await advance();
    expect(jobs().list()).toHaveLength(0); expect(await bytes()).toEqual(before);
    await edit({ status: "todo" }); await advance(); expect(jobs().list()).toHaveLength(1);
  });
}

test("a missed turn: human edit cancels an already pending legacy dispatch without rewriting the note", async () => {
  await edit({ turn: "agent" }); await edit({ turn: "human" }, false);
  const before = await bytes(); await advance();
  expect(jobs().list()).toHaveLength(0); expect(await bytes()).toEqual(before);
});

test("legacy CLI continue and refused dispatch return turn to human and preserve the original assignee", async () => {
  const identity = { actor: hub!.store.actors().find((a) => a.role === "human")!, label: "test" };
  const job = await hub!.tasks.dispatch(TASK, "cli", identity);
  expect((await front()).turn).toBe("agent"); expect((await front()).assignee).toEqual({ agent: "pi", device: "server" });
  await complete(job); expect((await front()).turn).toBe("human");
  await writeFile(join(vault, ACTIVE), (await bytes()).toString().replace("agent: pi", "agent: codex"));
  await edit({ turn: "agent" }); await advance();
  expect(jobs().list()).toHaveLength(1);
  expect((await front()).turn).toBe("human"); expect((await front()).assignee).toEqual({ agent: "codex", device: "server" });
  expect((await bytes()).toString()).toContain("无法派出");
});

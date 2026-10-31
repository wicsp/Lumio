import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { FSWatcher, watch } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, routineJobId } from "@lumio/core";
import { ApiError, Job, OperationResult, RoutineInfo, RuntimeInfo, RuntimeSync, Task, type JobResult } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";

// P2-5 的 Hub 一侧：计划、认出执行器自己触发的 Job、结果按时间追加、追问任务。执行器用 HTTP 直接模拟。
let temp: string, vault: string, workdir: string;
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let human: string, agent: string, runtime: string, other: string;
let notify: (path: string) => void = () => {};
let now = Date.parse("2026-10-26T10:05:00Z");
const R = "rtn_01M5AAAAAAAAAAAAAAAAAAAAR1";
const path = "plan/routines/日报.md";
const file = () => join(vault, path);
const base = () => `http://127.0.0.1:${hub!.server.port}`;
async function request(p: string, token: string, body?: unknown) {
  return fetch(`${base()}${p}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function writeRoutine(fields: Record<string, string> = {}, body = "总结今天的 GPU 使用情况。\n") {
  const header = Object.entries({ id: R, type: "routine", title: "日报", created: "2026-10-26T00:00:00Z", updated: "2026-10-26T00:00:00Z",
    schedule: '"*/10 * * * *"', timezone: "UTC", assignee: "{agent: pi, device: server}", workdir, ...fields }).map(([k, v]) => `${k}: ${v}`).join("\n");
  await writeFile(file(), `---\n${header}\n---\n${body}`);
  notify(path);
}
async function sync(heartbeat = { running: [] as string[], queued: [] as string[], outbox: 0 }, token = runtime) {
  return RuntimeSync.parse(await (await request("/v1/runtime/sync", token, heartbeat)).json());
}
async function eventually(check: () => boolean | Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(30); }
  throw new Error("timed out");
}
const note = async () => (await readFile(file())).toString();
function result(id: string, lease: string, fields: Partial<JobResult> = {}): JobResult {
  return { job: id, lease, status: "done", started: "2026-10-26T10:10:01Z", finished: "2026-10-26T10:11:00Z",
    engine: { name: "pi", version: "1.4.0", sandbox: "none" }, report: "GPU 0 空闲，GPU 1 跑着训练。", ...fields };
}
const fire = (hm: string) => new Date(`2026-10-26T${hm}:00Z`);

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-hub-routines-")); vault = join(temp, "vault"); workdir = join(temp, "proj");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  await Bun.write(join(vault, "plan/routines/.keep"), "");
  const store = await HubStore.open(join(temp, "hub"));
  store.createActor("owner", "human"); store.createActor("codex", "agent"); store.createActor("server", "runtime"); store.createActor("laptop", "runtime");
  human = store.createToken("owner", "owner"); agent = store.createToken("codex", "codex"); runtime = store.createToken("server", "server"); other = store.createToken("laptop", "laptop");
  store.close();
  now = Date.parse("2026-10-26T10:05:00Z");
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: join(temp, "hub") }), port: 0, autosaveIdle: 3600 }, {
    log: () => {}, tasks: { tickMs: 3_600_000 },
    routines: { tickMs: 50, timezone: "UTC", clock: { now: () => now, set: (cb, ms) => setTimeout(cb, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) } },
    watch: { watch: ((_p, _o, callback) => {
      notify = (p) => (callback as (event: string, path: string) => void)("change", p);
      return Object.assign(new EventEmitter(), { close() {} }) as FSWatcher;
    }) as typeof watch },
  });
  for (const [token, name] of [[runtime, "server"], [other, "laptop"]] as const) {
    RuntimeInfo.parse(await (await request("/v1/runtime/register", token, { protocol_version: 2, name, engines: [{ name: "pi", version: "1.4.0", sandbox: "none" }], tags: [], max_concurrent: 1 })).json());
  }
});
afterEach(async () => { notify = () => {}; await hub?.stop(); hub = undefined; await rm(temp, { recursive: true, force: true }); });

test("the plan reaches only the assigned runtime; pausing removes it and edits change the revision", async () => {
  await writeRoutine();
  await eventually(async () => (await sync()).routines.length === 1);
  const [plan] = (await sync()).routines;
  expect(plan).toMatchObject({ routine: R, schedule: "*/10 * * * *", timezone: "UTC", template: { workdir, timeout_seconds: 7200, run: { kind: "agent", engine: "pi" } } });
  expect(plan!.template.run.prompt).toContain("总结今天的 GPU 使用情况。");
  expect(plan!.template.run.prompt).toContain("没有之前的对话");
  expect(plan!.template.run.session).toBeUndefined();
  expect((await sync(undefined, other)).routines).toEqual([]);
  const list = RoutineInfo.array().parse(await (await request("/v1/routines", agent)).json());
  expect(list).toEqual([{ routine: { id: R, type: "routine", title: "日报", path }, schedule: "*/10 * * * *", timezone: "UTC", status: "active", runtime: "server", next: "2026-10-26T10:10:00.000Z" }]);

  await writeRoutine({ schedule: '"0 9 * * *"' });
  await eventually(async () => (await sync()).routines[0]?.schedule === "0 9 * * *");
  const changed = (await sync()).routines[0]!;
  expect(changed.revision).not.toBe(plan!.revision);
  expect(changed.lease).toBe(plan!.lease); // 同一个执行器：lease 不变
  await writeRoutine({ status: "paused" });
  await eventually(async () => (await sync()).routines.length === 0);
  expect(RoutineInfo.array().parse(await (await request("/v1/routines", human)).json())[0]).toMatchObject({ status: "paused" });
  expect((await request("/v1/routines", runtime)).status).toBe(403);

  await writeRoutine({ workdir: join(vault, "research") });
  await eventually(async () => RoutineInfo.array().parse(await (await request("/v1/routines", human)).json())[0]?.problem === "工作目录不能在笔记库里（ADR 0019）");
  expect((await sync()).routines).toEqual([]);
}, 30_000);

test("runtime-fired jobs are recognised by ID, results are appended in order, skipped fires noted, secrets withheld", async () => {
  await writeRoutine({ context: "previous" });
  await eventually(async () => (await sync()).routines.length === 1);
  const plan = (await sync()).routines[0]!;
  const first = routineJobId(R, fire("10:10"));
  // 执行器报告正在执行：Hub 补建记录。
  await sync({ running: [first], queued: [], outbox: 0 });
  const adopted = Job.parse(await (await request(`/v1/jobs/${first}`, human)).json());
  expect(adopted).toMatchObject({ status: "running", spec: { source: { routine: R, round: 1, fired_at: "2026-10-26T10:10:00.000Z" }, lease: plan.lease } });
  // 别的执行器、错误的 lease、不属于任何例行任务的编号：都拒绝。
  expect((await request("/v1/runtime/results", other, result(first, plan.lease))).status).toBe(409);
  expect((await request("/v1/runtime/results", runtime, result(first, "x".repeat(32)))).status).toBe(409);
  expect((await request("/v1/runtime/results", runtime, result(routineJobId("rtn_01M5AAAAAAAAAAAAAAAAAAAAR9", fire("10:10")), plan.lease))).status).toBe(409);
  expect((await request("/v1/runtime/results", runtime, result(first, plan.lease))).status).toBe(200);
  await eventually(async () => (await note()).includes("### 2026-10-26 10:10 的结果"));
  expect(await note()).toContain(`<!-- lumio:ai start name=run-20261026-1010 job=${first} -->`);
  expect(await note()).toContain("GPU 0 空闲");
  // context: previous —— 新计划带上这一次的摘要。
  await eventually(async () => (await sync()).routines[0]!.template.run.prompt.includes("## 上一次的结果（2026-10-26 10:10）"));

  // Hub 没见过、直接交回结果（Hub 离线期间执行完的）：同样认出。中间错过了 10:20、10:30。
  const third = routineJobId(R, fire("10:40"));
  expect((await request("/v1/runtime/results", runtime, result(third, plan.lease, { report: `token sk-${"a".repeat(30)}` }))).status).toBe(200);
  await eventually(async () => (await note()).includes("### 2026-10-26 10:40 的结果"));
  const text = await note();
  expect(text.indexOf("10:10 的结果")).toBeLessThan(text.indexOf("10:40 的结果"));
  expect(text).toContain("上一次之后有 2 次计划触发没有执行");
  expect(text).toContain("汇报中疑似包含敏感信息");
  expect(text).not.toContain("sk-aaaa");
  expect(parseFrontmatter(Buffer.from(text)).body.toString().startsWith("总结今天的 GPU 使用情况。")).toBe(true);
  // 重复交回同一结果只记一次。
  expect((await request("/v1/runtime/results", runtime, result(first, plan.lease))).status).toBe(200);
  expect(Job.array().parse(await (await request(`/v1/jobs?routine=${R}`, human)).json()).map((j) => j.spec.id)).toEqual([first, third]);
  now = Date.parse("2026-10-26T10:41:00Z");
  expect(RoutineInfo.array().parse(await (await request("/v1/routines", human)).json())[0]).toMatchObject({ next: "2026-10-26T10:50:00.000Z", last: { job: third, status: "done" } });
}, 30_000);

test("routine.followup opens a task from one run with the routine's assignee and config; agents are refused", async () => {
  await writeRoutine({ model: "pi-large", timeout_minutes: "30" });
  await eventually(async () => (await sync()).routines.length === 1);
  const plan = (await sync()).routines[0]!;
  const id = routineJobId(R, fire("10:10"));
  expect((await request("/v1/runtime/results", runtime, result(id, plan.lease))).status).toBe(200);
  const operation = { op: "routine.followup", args: { routine: R, job: id } };
  const denied = await request("/v1/operations", agent, { operation });
  expect(denied.status).toBe(403);
  expect(ApiError.parse(await denied.json()).error.reason).toBe("agent-cannot-create-tasks");
  const response = await request("/v1/operations", human, { operation });
  expect(response.status).toBe(200);
  const applied = OperationResult.parse(await response.json());
  if (applied.status !== "applied" || !applied.note) throw new Error("expected a note");
  expect(applied.note).toMatchObject({ type: "task", title: "日报 · 2026-10-26 10:10 追问", path: "plan/tasks/日报 · 2026-10-26 10-10 追问.md" });
  const bytes = await readFile(join(vault, applied.note.path));
  const task = Task.parse(parseFrontmatter(bytes).data);
  expect(task).toMatchObject({ id: applied.note.id, status: "todo", assignee: "human", workdir,
    model: "pi-large", timeout_minutes: 30, routine: R });
  expect(bytes.toString()).toContain("[[日报]]");
  expect(bytes.toString()).toContain(`<!-- lumio:ai start name=routine-run job=${id} -->`);
  expect(bytes.toString()).toContain("GPU 0 空闲");
  // 第二次追问同一次：另起一个文件，不覆盖。
  const again = OperationResult.parse(await (await request("/v1/operations", human, { operation })).json());
  expect(again.status === "applied" && again.note?.path).toBe("plan/tasks/日报 · 2026-10-26 10-10 追问 2.md");
  // 不是这个例行任务的 Job：拒绝。
  const bad = await request("/v1/operations", human, { operation: { op: "routine.followup", args: { routine: "rtn_01M5AAAAAAAAAAAAAAAAAAAAR9", job: id } } });
  expect(bad.status).toBe(400);
}, 30_000);


test("string routine assignee without workdir creates a home-directory plan and run", async () => {
  await writeRoutine({ assignee: "pi@server" });
  await writeFile(file(), (await note()).replace(/^workdir:.*\n/m, "")); notify(path);
  await eventually(async () => (await sync()).routines[0]?.template.workdir === "~");
  const plan = (await sync()).routines[0]!;
  const id = routineJobId(R, fire("10:10"));
  await sync({ running: [id], queued: [], outbox: 0 });
  expect(Job.parse(await (await request(`/v1/jobs/${id}`, human)).json()).spec.workdir).toBe("~");
  expect((await request("/v1/runtime/results", runtime, result(id, plan.lease))).status).toBe(200);
  await eventually(async () => (await note()).includes("### 2026-10-26 10:10 的结果"));
});


test.each([
  ["codex", "codex"],
  ["claude-code@mac", "claude-code@mac"],
  ["{agent: codex, device: laptop}", "codex@laptop"],
])("routine.followup describes the routine's own assignee %s", async (assignee, expected) => {
  await writeRoutine();
  await eventually(async () => (await sync()).routines.length === 1);
  const plan = (await sync()).routines[0]!;
  const id = routineJobId(R, fire("10:10"));
  expect((await request("/v1/runtime/results", runtime, result(id, plan.lease))).status).toBe(200);
  await writeRoutine({ assignee, status: "paused" });
  const response = await request("/v1/operations", human, { operation: { op: "routine.followup", args: { routine: R, job: id } } });
  expect(response.status).toBe(200);
  const applied = OperationResult.parse(await response.json());
  if (applied.status !== "applied" || !applied.note) throw new Error("expected a note");
  const bytes = await readFile(join(vault, applied.note.path));
  expect(Task.parse(parseFrontmatter(bytes).data).assignee).toBe("human");
  expect(bytes.toString()).toContain(`把 \`assignee\` 改成 \`${expected}\``);
  expect(bytes.toString()).not.toContain("改成 `pi@server`");
});

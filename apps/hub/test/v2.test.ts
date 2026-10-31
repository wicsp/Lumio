import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, WorkCommandResult, WorkTaskDetail, AssistantChatResult, AssistantEvent, Job, type RuntimeRegistration } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { HubStore } from "../src/store.ts";
import { V2_ROUTES } from "../src/v2.ts";

let temp: string, hub: Awaited<ReturnType<typeof startHub>>, human: string, agent: string, runtime: string, runtimeActor: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-v2-"));
  const store = await HubStore.open(temp);
  store.createActor("owner", "human"); store.createActor("agent", "agent");
  runtimeActor = store.createActor("server", "runtime").id;
  human = store.createToken("owner", "owner"); agent = store.createToken("agent", "agent"); runtime = store.createToken("server", "server");
  const registration: RuntimeRegistration = { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "0.50.1", sandbox: "none" }], tags: [], max_concurrent: 1 };
  store.registerRuntime(runtimeActor, registration, new Date()); store.close();
  hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: temp }), localRuntime: "server", port: 0 }, { log() {},
    assistantModel: { async complete(input, options) { options.token("合成回答"); return { content: `合成回答：${input.messages.at(-1)?.content}`, tool_calls: [] }; } },
  });
});
afterEach(async () => { await hub?.stop(); await rm(temp, { recursive: true, force: true }); });
function request(path: string, body?: unknown, token = human) {
  return fetch(`http://127.0.0.1:${hub.server.port}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
let sequence = 0;
async function command(op: string, args: Record<string, unknown>, requestId = `synthetic-command-${++sequence}`) {
  const response = await request("/v2/work/commands", { request_id: requestId, operation: { op, args } });
  expect(response.status).toBe(200); return WorkCommandResult.parse(await response.json());
}
test("Hub manages Work without a Knowledge directory, uses explicit dispatch and keeps v1 objects distinct", async () => {
  expect(hub.modules.work.tasks()).toEqual([]);
  expect(await (await request("/v1/status")).json()).toMatchObject({ watching: false });
  const created = await command("work.task.create", { title: "合成工作", description: "固定输入", assignee: "pi@server" });
  if (created.kind !== "task") throw new Error("task expected");
  expect(hub.store.db.query("SELECT * FROM jobs").all()).toEqual([]);
  expect("path" in created.task).toBe(false);
  const old = await request("/v1/operations", { operation: { op: "task.dispatch", args: { task: created.task.id, trigger: "cli" } } });
  expect(old.status).toBe(409); expect(ApiError.parse(await old.json()).error.message).toContain("新版");
  const first = await command("work.task.dispatch", { task: created.task.id }, "synthetic-dispatch-0001");
  const repeated = await command("work.task.dispatch", { task: created.task.id }, "synthetic-dispatch-0001");
  expect(repeated).toEqual(first); expect(hub.store.db.query("SELECT * FROM jobs").all()).toHaveLength(1);
  if (first.kind !== "job") throw new Error("job expected");
  await request("/v1/runtime/ack", { accepted: [first.job.spec.id] }, runtime);
  const result = { job: first.job.spec.id, lease: first.job.spec.lease, status: "done", finished: new Date().toISOString(), report: "合成结果" };
  expect((await request("/v1/runtime/results", result, runtime)).status).toBe(200);
  expect((await request("/v1/runtime/results", result, runtime)).status).toBe(200);
  const detail = WorkTaskDetail.parse(await (await request(`/v2/work/tasks/${created.task.id}`)).json());
  expect(detail.task.status).toBe("active"); expect(detail.task.assignee).toBe("pi@server");
  expect(detail.comments).toHaveLength(1); expect(detail.executions[0]!.applied).toBe(true);
  expect(Job.parse(first.job).spec.protocol_version).toBe(2);
  await hub.stop();
  hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: temp }), port: 0 }, { log() {} });
  expect(hub.modules.work.detail(created.task.id).comments).toHaveLength(1);
});

test("v2 retains shared authorization, request validation, revision conflicts and actor-owned dialogue", async () => {
  const denied = await request("/v2/work/commands", { request_id: "synthetic-denied-0001", operation: { op: "work.task.create", args: { title: "拒绝" } } }, agent);
  expect(denied.status).toBe(403); expect(hub.modules.work.tasks()).toEqual([]);
  const created = await command("work.task.create", { title: "合成工作" });
  if (created.kind !== "task") throw new Error("task expected");
  const saved = await command("work.task.update", { task: created.task.id, expected_revision: 1, patch: { description: "已保存" } });
  expect(saved.kind).toBe("task");
  const conflict = await request("/v2/work/commands", { request_id: "synthetic-conflict-0001", operation: { op: "work.task.update", args: { task: created.task.id, expected_revision: 1, patch: { description: "陈旧" } } } });
  expect(conflict.status).toBe(409); expect(ApiError.parse(await conflict.json()).error.code).toBe("CONFLICT");
  const chat = AssistantChatResult.parse(await (await request("/v2/assistant/chat", { request_id: "synthetic-chat-0001", message: "你好" })).json());
  expect(chat.turn.status).toBe("done"); expect(chat.messages.at(-1)?.content).toContain("你好");
  expect((await request("/v2/assistant/chat", { request_id: "synthetic-chat-0002", message: "越权" }, agent)).status).toBe(403);
  const stranger = hub.store.createActor("stranger", "human");
  const strangerToken = hub.store.createToken("stranger", stranger.name);
  expect((await request(`/v2/assistant/conversations/${chat.conversation.id}`, undefined, strangerToken)).status).toBe(404);
  expect((await request(`/v2/work/tasks?status=bad`)).status).toBe(400);
});

test("all v2 routes obey the shared deny policy before reading bodies or exposing objects", async () => {
  await hub.stop(); hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: temp }), port: 0 }, { log() {}, authorize: () => ({ result: "deny", reason: "synthetic denial" }) });
  for (const route of V2_ROUTES) {
    const path = route.path.replace("<id>", route.path.includes("conversations") ? "conv_00000000000000000000000001" : route.path.includes("projects") ? "prj_00000000000000000000000001" : "task_00000000000000000000000001");
    const response = await request(path, route.method === "POST" ? {} : undefined);
    expect(response.status).toBe(403); expect(ApiError.parse(await response.json()).error.reason).toBe("synthetic denial");
  }
});

test("CLI uses database tasks and projects, preserves conflicting edit files, and exposes assistant JSON and streams", async () => {
  async function cli(args: string[]) {
    const child = Bun.spawn([process.execPath, new URL("../../cli/src/main.ts", import.meta.url).pathname, ...args], {
      env: { HOME: temp, PATH: process.env.PATH, LUMIO_HUB_URL: `http://127.0.0.1:${hub.server.port}`, LUMIO_TOKEN: human }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  const projectOutput = await cli(["project", "new", "合成项目", "--json"]);
  expect(projectOutput.code).toBe(0);
  const project = WorkCommandResult.parse(JSON.parse(projectOutput.stdout));
  if (project.kind !== "project") throw new Error("project expected");
  const path = join(temp, "description.md"); await writeFile(path, "第一版正文");
  const output = await cli(["task", "new", "合成任务", "--project", project.project.id, "--file", path, "--json"]);
  expect(output.code).toBe(0);
  const task = WorkCommandResult.parse(JSON.parse(output.stdout)); if (task.kind !== "task") throw new Error("task expected");
  expect((await cli(["task", "status", task.task.id, "active", "--json"])).code).toBe(0);
  await writeFile(path, "第二版正文");
  const conflict = await cli(["task", "edit", task.task.id, "--file", path, "--revision", "1", "--json"]);
  expect(conflict.code).toBe(1); expect(ApiError.parse(JSON.parse(conflict.stdout)).error.code).toBe("CONFLICT");
  expect(await readFile(path, "utf8")).toBe("第二版正文");
  expect((await cli(["task", "edit", task.task.id, "--file", path, "--revision", "2", "--json"])).code).toBe(0);
  const shown = await cli(["task", "show", task.task.id, "--json"]);
  expect(WorkTaskDetail.parse(JSON.parse(shown.stdout)).task.description).toBe("第二版正文");
  const chat = await cli(["chat", "你好", "--json"]); expect(chat.code).toBe(0);
  const dialogue = AssistantChatResult.parse(JSON.parse(chat.stdout)); expect(dialogue.turn.status).toBe("done");
  const streamed = await cli(["chat", "继续", "--conversation", dialogue.conversation.id, "--stream"]);
  expect(streamed.code).toBe(0);
  const events = streamed.stdout.trim().split("\n").map((line) => AssistantEvent.parse(JSON.parse(line)));
  expect(events.some((value) => value.type === "token")).toBe(true); expect(events.at(-1)?.type).toBe("result");
});

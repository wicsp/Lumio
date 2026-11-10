import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Job, JobResult, RuntimeInfo, WorkAttention, WorkCommandRequest, WorkCommandResult } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { HubStore } from "../src/store.ts";

let temp: string, human: string, agent: string, runtime: string, sequence: number;
let hub: Awaited<ReturnType<typeof startHub>>;
let daemon: ReturnType<typeof Bun.spawn> | undefined;
const runtimeName = "mac";
const requested = "Need synthetic Git write access.";
const state = () => join(temp, "hub");
const boot = () => startHub({ ...readConfig({ LUMIO_STATE_DIR: state() }), localRuntime: runtimeName, port: 0 }, { log() {} });
const url = () => hub.server.url.href.replace(/\/$/, "");

function request(path: string, body?: unknown, token = human) {
  return fetch(url() + path, { method: body === undefined ? "GET" : "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept-Language": "en",
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function send(op: string, args: Record<string, unknown>, token = human, id = `synthetic-permission-${++sequence}`) {
  return request("/v2/work/commands", WorkCommandRequest.parse({ request_id: id, operation: { op, args } }), token);
}
async function command(op: string, args: Record<string, unknown>, id?: string) {
  const response = await send(op, args, human, id);
  if (!response.ok) throw new Error(await response.text());
  return WorkCommandResult.parse(await response.json());
}
async function newTask() {
  const result = await command("work.task.create", { title: "Synthetic permission task", workdir: join(temp, "project"), description: "Use the synthetic workspace." });
  if (result.kind !== "task") throw new Error("task expected");
  return result.task;
}
async function dispatch(task: string, extra = {}) {
  const result = await command("work.task.dispatch", { task, ...extra });
  if (result.kind !== "job") throw new Error("job expected");
  return result.job;
}
async function complete(job: Job, permission?: { git: true; access?: "full" }) {
  const ack = await request("/v1/runtime/ack", { accepted: [job.spec.id] }, runtime);
  expect(ack.status).toBe(200);
  const data = JobResult.parse({ job: job.spec.id, lease: job.spec.lease, status: permission ? "waiting_for_human" : "done",
    finished: new Date().toISOString(), session_id: "synthetic-permission-session", report: requested, permission });
  expect((await request("/v1/runtime/results", data, runtime)).status).toBe(200);
  hub.modules.reconcile();
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(30); }
  throw new Error("Timed out waiting for the synthetic permission round");
}

beforeEach(async () => {
  sequence = 0; temp = await mkdtemp(join(tmpdir(), "lumio-stage-permission-"));
  await mkdir(join(temp, "project"));
  const store = await HubStore.open(state());
  store.createActor("owner", "human"); store.createActor("agent", "agent");
  const device = store.createActor(runtimeName, "runtime");
  human = store.createToken("human", "owner"); agent = store.createToken("agent", "agent"); runtime = store.createToken("runtime", runtimeName);
  store.registerRuntime(device.id, { protocol_version: 2, name: runtimeName, tags: [], max_concurrent: 1,
    engines: [{ name: "codex", version: "0.166.0", sandbox: "os" }], features: ["stage_permissions", "hooks", "permission_request"] }, new Date());
  store.close(); hub = await boot();
});
afterEach(async () => {
  if (daemon) { daemon.kill("SIGTERM"); await daemon.exited; daemon = undefined; }
  await hub.stop(); await rm(temp, { recursive: true, force: true });
});

test("Runtime delivers a permission marker, human approval resumes the same Codex session, and grants expire", async () => {
  const git = Bun.which("git")!;
  expect(Bun.spawnSync([git, "init", join(temp, "project")], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
  const bin = join(temp, "bin"); await mkdir(bin);
  const fixture = new URL("./fixtures/permission-agent.ts", import.meta.url).pathname;
  await writeFile(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, { mode: 0o700 });
  daemon = Bun.spawn([process.execPath, new URL("../../runtime/src/main.ts", import.meta.url).pathname], { env: {
    HOME: temp, PATH: `${bin}:${dirname(git)}:/usr/bin:/bin`, LUMIO_HUB_URL: url(), LUMIO_TOKEN: runtime,
    LUMIO_RUNTIME_NAME: runtimeName, LUMIO_RUNTIME_STATE_DIR: join(temp, "runtime"), LUMIO_RUNTIME_POLL_SECONDS: "0.05",
    LUMIO_SECRET_fixture: "synthetic-permission-secret", LUMIO_SECRET_other: "synthetic-unapproved-secret",
  }, stdout: "ignore", stderr: "ignore" });
  const task = await newTask();
  const first = await dispatch(task.id, { to: "codex@mac" });
  expect(first.spec.run.kind === "agent" && first.spec.run.prompt).toContain("<lumio-permission>git</lumio-permission>");
  await eventually(() => hub.modules.work.task(task.id).turn.reason === "answer");
  const firstResult = Job.parse(await (await request(`/v1/jobs/${first.spec.id}`)).json());
  expect(firstResult.result).toMatchObject({ permission: { git: true, secrets: ["fixture"] }, session_id: "synthetic-permission-session" });
  expect(firstResult.result?.report).not.toContain("<lumio-permission>");
  const attention = WorkAttention.array().parse(await (await request("/v2/work/attention")).json());
  expect(attention).toMatchObject([{ task: task.id, kind: "question", job: first.spec.id, summary: expect.stringContaining("fetch") }]);
  const expected_revision = hub.modules.work.task(task.id).revision;
  const grant = { task: task.id, expected_revision, permissions: { git: true, secrets: ["fixture"] }, scope: "next_round" };
  expect((await send("work.task.grant", grant, agent)).status).toBe(403);
  expect((await send("work.task.grant", { ...grant, permissions: { access: "full" } })).status).toBe(400);
  const reply = await command("work.task.grant", grant, "synthetic-permission-approval");
  expect(reply).toMatchObject({ kind: "job", job: { spec: { source: { previous: first.spec.id },
    run: { permissions: { git: true, secrets: ["fixture"] }, session: { id: "synthetic-permission-session", resume: true } },
  } } });
  expect(await command("work.task.grant", grant, "synthetic-permission-approval")).toEqual(reply);
  expect((await send("work.task.grant", grant)).status).toBe(409);
  if (reply.kind !== "job") throw new Error("resumed job expected");
  await eventually(() => hub.modules.work.task(task.id).turn.reason === "review");
  const last = Job.parse(await (await request(`/v1/jobs/${reply.job.spec.id}`)).json());
  expect(last.status).toBe("done");
  expect(last.result?.report).toContain("[REDACTED]");
  expect(last.result?.report).not.toContain("synthetic-permission-secret");
  expect(await Bun.file(last.result!.log!).text()).not.toContain("synthetic-permission-secret");
  expect(hub.modules.work.task(task.id).grants).toBeUndefined();
  const third = await dispatch(task.id);
  expect(third.spec.run.kind === "agent" && third.spec.run.permissions).toBeUndefined();
}, 20000);

test("deferred approvals survive restart and stay on the approved stage, while refusal resumes without extra access", async () => {
  const task = await newTask();
  const first = { kind: "agent", id: "review", agent: "codex@mac", instruction: "Synthetic review", access: "read" } as const;
  const second = { kind: "agent", id: "deliver", agent: "codex@mac", instruction: "Synthetic delivery" } as const;
  await command("work.task.plan.set", { task: task.id, expected_revision: task.revision, plan: { stages: [first, second] } });
  const job = await dispatch(task.id);
  await complete(job, { git: true, access: "full" });
  const grant = (scope: "task" | "next_round", permissions: unknown) => command("work.task.grant", {
    task: task.id, expected_revision: hub.modules.work.task(task.id).revision, permissions, scope, continue: false,
  });
  await grant("task", { git: true });
  await grant("next_round", { access: "full" });
  await hub.stop(); hub = await boot();
  const updated = hub.modules.work.task(task.id);
  expect(updated.plan?.plan.stages).toEqual([{ ...first, git: true }, second]);
  const next = await dispatch(task.id);
  expect(next.spec.run).toMatchObject({ permissions: { git: true, access: "full" }, session: { resume: true } });
  await complete(next);
  const stages = Job.array().parse(await (await request(`/v1/jobs?task=${task.id}`)).json());
  expect(stages.at(-1)?.spec.run).toMatchObject({ permissions: { access: "write", git: false } });

  const refused = await newTask();
  const pending = await dispatch(refused.id, { to: "codex@mac" });
  await complete(pending, { git: true });
  const denied = await dispatch(refused.id, { comment: "Declined. Finish the report without Git writes." });
  expect(denied.spec.run).toMatchObject({ kind: "agent", session: { resume: true }, prompt: expect.stringContaining("Declined.") });
  expect(denied.spec.run.kind === "agent" && denied.spec.run.permissions).toBeUndefined();
  await complete(denied, { git: true });
  const saved = await command("work.task.grant", { task: refused.id, expected_revision: hub.modules.work.task(refused.id).revision,
    permissions: { git: true }, scope: "task", continue: false });
  expect(saved).toMatchObject({ kind: "task", task: { grants: { git: true } } });
  await hub.stop(); hub = await boot();
  const persistent = await dispatch(refused.id);
  expect(persistent.spec.run).toMatchObject({ permissions: { git: true }, session: { resume: true } });
});

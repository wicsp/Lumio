import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, Proposal, WorkCommandResult, ExecutionTarget, Job, WorkProject, WorkTask, WorkTaskDetail } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { HubStore } from "../src/store.ts";
let temp: string, hub: Awaited<ReturnType<typeof startHub>>, human: string, agent: string, other: string, runtime: string;
let seq = 0;
const base = () => hub.server.url.href;
const client = () => ({
  async targets(args: { online?: boolean } = {}) { return ExecutionTarget.array().parse(await (await api(`/v2/execution/targets${args.online === undefined ? "" : `?online=${args.online}`}`)).json()); },
  async jobs(_status: undefined, task: string) { return Job.array().parse(await (await api(`/v1/jobs?task=${task}`)).json()); },
  async workProject(id: string) { return WorkProject.parse(await (await api(`/v2/work/projects/${id}`)).json()); },
});
async function api(path: string, body?: unknown, token = human) {
  return fetch(new URL(path, base()), { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function command(op: string, args: object, token = human, id = `synthetic-r48-request-${++seq}`) {
  return api("/v2/work/commands", { request_id: id, operation: { op, args } }, token);
}
async function applied(op: string, args: object) {
  const r = await command(op, args); if (r.status !== 200) throw Error(await r.text()); return WorkCommandResult.parse(await r.json());
}
async function task(args: object = {}) { const r = await applied("work.task.create", { title: "Synthetic task", ...args }); if (r.kind !== "task") throw Error(); return r.task; }
async function project(args: object = {}) { const r = await applied("work.project.create", { title: "Synthetic project", workdir: "/synthetic/project", repo: "https://example.test/repo", ...args }); if (r.kind !== "project") throw Error(); return r.project; }
async function proposed(op: string, args: object, token = agent, id?: string) { const r = await command(op, args, token, id); expect(r.status).toBe(202); const value = WorkCommandResult.parse(await r.json()); if (value.kind !== "proposal") throw Error(); return value.proposal; }
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-r48-")); const store = await HubStore.open(temp);
  for (const [name, role] of [["owner", "human"], ["agent", "agent"], ["other", "agent"], ["mac", "runtime"]] as const) store.createActor(name, role);
  human = store.createToken("owner", "owner"); agent = store.createToken("agent", "agent"); other = store.createToken("other", "other"); runtime = store.createToken("mac", "mac");
  store.registerRuntime(store.actors().find(a => a.name === "mac")!.id, { protocol_version: 2, name: "mac", engines: [{ name: "codex", version: "synthetic", sandbox: "os" }], tags: [], max_concurrent: 1 }, new Date(0)); store.close();
  hub = await startHub({ ...readConfig({ HOME: temp, LUMIO_STATE_DIR: temp }), localRuntime: "mac", port: 0 }, { log() {} });
});
afterEach(async () => { await hub?.stop(); await rm(temp, { recursive: true, force: true }); });
test("directory precedence, repo snapshots, changed project directory, clear, and automatic handoff", async () => {
  const p = await project();
  for (const [args, expected] of [[{ project: p.id, workdir: "/synthetic/task" }, "/synthetic/task"], [{ project: p.id }, "/synthetic/project"], [{}, "~"]] as const) {
    const t = await task(args), r = await applied("work.task.dispatch", { task: t.id, to: "codex" }); if (r.kind !== "job") throw Error();
    expect(r.job.spec.workdir).toBe(expected);
    if (t.project) expect(r.job.spec.run.kind === "agent" && r.job.spec.run.prompt).toContain("Repository: https://example.test/repo");
  }
  const t = await task({ project: p.id });
  await applied("work.task.plan.set", { task: t.id, expected_revision: t.revision, plan: { stages: [{ kind: "agent", id: "one", agent: "codex@mac", instruction: "Synthetic one" }, { kind: "agent", id: "two", agent: "codex@mac", instruction: "Synthetic two" }] } });
  const first = await applied("work.task.dispatch", { task: t.id }); if (first.kind !== "job") throw Error();
  await applied("work.project.update", { project: p.id, expected_revision: p.revision, patch: { workdir: "/synthetic/new" } });
  await api("/v1/runtime/ack", { accepted: [first.job.spec.id] }, runtime);
  expect((await api("/v1/runtime/results", { job: first.job.spec.id, lease: first.job.spec.lease, status: "done", finished: new Date().toISOString(), report: "Synthetic result" }, runtime)).status).toBe(200);
  hub.modules.reconcile();
  const jobs = await client().jobs(undefined, t.id); expect(jobs.map(j => j.spec.workdir)).toEqual(["/synthetic/project", "/synthetic/new"]);
  expect(jobs.every(j => j.spec.run.kind === "agent" && j.spec.run.prompt.includes("Repository: https://example.test/repo"))).toBe(true);
  await applied("work.project.update", { project: p.id, expected_revision: p.revision + 1, patch: { workdir: null } });
  expect((await client().workProject(p.id)).workdir).toBeUndefined();
});
test("Chinese dispatch explains the round's scope and available permissions", async () => {
  const t = await task({ description: "合成任务描述" });
  const response = await fetch(new URL("/v2/work/commands", base()), {
    method: "POST",
    headers: { Authorization: `Bearer ${human}`, "Content-Type": "application/json", "Accept-Language": "zh-CN" },
    body: JSON.stringify({ request_id: "synthetic-zh-round-permissions", operation: { op: "work.task.dispatch", args: { task: t.id, to: "codex@mac" } } }),
  });
  expect(response.status).toBe(200);
  const result = WorkCommandResult.parse(await response.json());
  if (result.kind !== "job" || result.job.spec.run.kind !== "agent") throw Error("agent job expected");
  const { prompt } = result.job.spec.run;
  expect(prompt).toContain("只做本轮交代的工作，有阶段时只做当前阶段");
  expect(prompt).toContain("Git 元数据受保护");
  expect(prompt).toContain("没有注入阶段专用密钥");
  expect(prompt).toContain("<lumio-question>所需权限和理由</lumio-question>");
  expect(prompt).toContain("确实需要 root 的系统命令使用 `lumio-runtime sudo --");
  expect(prompt).toContain("合成任务描述");
});
test("target discovery, validation before proposals, offline acceptance, and runtime denial", async () => {
  const list = ExecutionTarget.array().parse(await client().targets()); expect(list).toMatchObject([{ target: "codex@mac", online: false }]);
  expect(await client().targets({ online: true })).toEqual([]);
  expect((await api("/v2/execution/targets", undefined, agent)).status).toBe(200);
  expect((await api("/v2/execution/targets", undefined, runtime)).status).toBe(403);
  const t = await task();
  for (const token of [human, agent]) for (const [op, args] of [["work.task.dispatch", { task: t.id, to: "codex@missing" }], ["work.task.plan.set", { task: t.id, expected_revision: t.revision, plan: { stages: [{ kind: "agent", id: "bad", agent: "codex@missing", instruction: "Synthetic" }] } }]] as const) {
    const r = await command(op, args, token); expect(r.status).toBe(400); const e = ApiError.parse(await r.json()); expect(e.error.code).toBe("INVALID"); expect(e.error.message).toContain("codex@mac");
  }
  expect(hub.store.proposals("pending")).toEqual([]);
  const r = await command("work.task.dispatch", { task: t.id, to: "codex@mac" }, agent); expect(r.status).toBe(202); expect(r.headers.get("X-Lumio-Offline-Targets")).toBe("codex@mac");
  const value = WorkCommandResult.parse(await r.json()); if (value.kind !== "proposal") throw Error(); expect(hub.store.proposal(value.proposal)?.reason).toMatch(/Offline/);
});
test("supersession scopes, replay, withdrawal ownership, terminal conflicts and audit rollback", async () => {
  const t = await task(), args = { task: t.id, to: "codex@mac" };
  const first = await proposed("work.task.dispatch", args, agent, "synthetic-original");
  const another = await proposed("work.task.dispatch", args, other);
  const plan = await proposed("work.task.plan.set", { task: t.id, expected_revision: t.revision, plan: null });
  const separate = await task(), separateProposal = await proposed("work.task.dispatch", { task: separate.id, to: "codex@mac" });
  const eventCount = hub.store.db.query("SELECT * FROM notification_events").all().length;
  const second = await proposed("work.task.dispatch", args);
  expect(hub.store.proposal(separateProposal)?.status).toBe("pending");
  expect(hub.store.db.query("SELECT * FROM notification_events").all()).toHaveLength(eventCount + 1);
  expect(Proposal.parse(hub.store.proposal(first))).toMatchObject({ status: "withdrawn", superseded_by: second });
  expect(hub.store.proposal(another)?.status).toBe("pending"); expect(hub.store.proposal(plan)?.status).toBe("pending");
  expect(await proposed("work.task.dispatch", args, agent, "synthetic-original")).toBe(first); expect(hub.store.proposal(second)?.status).toBe("pending");
  expect((await api(`/v2/approval/proposals/${second}/withdraw`, {}, other)).status).toBe(403);
  const events = hub.store.db.query("SELECT * FROM notification_events").all().length;
  const withdrew = Proposal.parse(await (await api(`/v2/approval/proposals/${second}/withdraw`, {}, agent)).json()); expect(withdrew.status).toBe("withdrawn"); expect(withdrew.superseded_by).toBeUndefined();
  expect(hub.store.db.query("SELECT * FROM notification_events").all()).toHaveLength(events);
  expect((await api(`/v2/approval/proposals/${second}/withdraw`, {}, agent)).status).toBe(409);
  for (const id of [first, second]) for (const action of ["accept", "reject"]) expect((await api(`/v1/proposals/${id}/${action}`, {})).status).toBe(409);
  expect(hub.store.db.query("SELECT * FROM audit WHERE operation='approval.proposal.withdraw'").all()).toHaveLength(2);
  hub.store.db.exec("CREATE TRIGGER fail_withdraw BEFORE INSERT ON audit WHEN NEW.operation='approval.proposal.withdraw' BEGIN SELECT RAISE(FAIL,'synthetic failure'); END");
  expect((await api(`/v2/approval/proposals/${plan}/withdraw`, {}, agent)).status).toBe(500); expect(hub.store.proposal(plan)?.status).toBe("pending");
  const pendingBefore = hub.store.proposals("pending"), eventsBefore = hub.store.db.query("SELECT * FROM notification_events").all();
  expect((await command("work.task.plan.set", { task: t.id, expected_revision: t.revision, plan: null }, agent)).status).toBe(500);
  expect(hub.store.proposals("pending")).toEqual(pendingBefore); expect(hub.store.db.query("SELECT * FROM notification_events").all()).toEqual(eventsBefore);
  hub.store.db.exec("DROP TRIGGER fail_withdraw");
  const newPlan = await proposed("work.task.plan.set", { task: t.id, expected_revision: t.revision, plan: null });
  expect(hub.store.proposal(plan)).toMatchObject({ status: "withdrawn", superseded_by: newPlan });
  await hub.stop(); hub = await startHub({ ...readConfig({ HOME: temp, LUMIO_STATE_DIR: temp }), localRuntime: "mac", port: 0 }, { log() {} });
  expect(hub.store.proposal(plan)).toMatchObject({ status: "withdrawn", superseded_by: newPlan });
});

test("inherited directories pass the existing local vault guard", async () => {
  await hub.stop();
  const vault = join(temp, "synthetic-vault");
  await (await import("node:fs/promises")).mkdir(vault);
  hub = await startHub({ ...readConfig({ HOME: temp, LUMIO_STATE_DIR: temp, LUMIO_VAULT: vault }), localRuntime: "mac", port: 0 }, { log() {} });
  const created = await applied("work.project.create", { title: "Synthetic guarded project", workdir: vault }); if (created.kind !== "project") throw Error();
  const t = await task({ project: created.project.id });
  const response = await command("work.task.dispatch", { task: t.id, to: "codex@mac" });
  expect(response.status).toBe(400); expect(ApiError.parse(await response.json()).error.code).toBe("INVALID");
  expect(hub.modules.work.detail(t.id).executions).toEqual([]);
});

test("implicit dispatch and task reads share plan, last round, and project precedence", async () => {
  const p = await project({ default_target: "codex" });
  const mac = hub.store.runtimes(new Date())[0]!;
  hub.store.registerRuntime(mac.actor, { ...mac.registration, engines: [...mac.registration.engines,
    { name: "claude-code", version: "synthetic", sandbox: "os" }] }, new Date(0));
  const projectDefault = { target: "codex@mac", source: "project" } as const;
  const t = await task({ project: p.id });
  const untouched = await task({ project: p.id });
  const implicit = await task({ project: p.id });
  expect(t.next_target).toEqual(projectDefault);
  expect((await client().workProject(p.id)).default_target).toBe("codex");
  const show = async (id: string) => WorkTaskDetail.parse(await (await api(`/v2/work/tasks/${id}`)).json());
  const list = async () => WorkTask.array().parse(await (await api("/v2/work/tasks")).json());
  expect((await show(t.id)).task.next_target).toEqual(projectDefault);
  expect((await list()).find(value => value.id === t.id)?.next_target).toEqual(projectDefault);
  const request = "synthetic-project-dispatch";
  const queued = await command("work.task.dispatch", { task: implicit.id }, human, request);
  expect(queued.status).toBe(200);
  expect(queued.headers.get("X-Lumio-Offline-Targets")).toBe("codex@mac");
  const initial = WorkCommandResult.parse(await queued.json());
  expect(initial).toMatchObject({ kind: "job", target: "codex@mac", target_source: "project", job: { status: "queued" } });

  const first = await applied("work.task.dispatch", { task: t.id, to: "claude-code@mac" });
  if (first.kind !== "job") throw Error("Expected a job");
  expect(first).toMatchObject({ target: "claude-code@mac", target_source: "explicit" });
  await api("/v1/runtime/ack", { accepted: [first.job.spec.id] }, runtime);
  const question = await api("/v1/runtime/results", { job: first.job.spec.id, lease: first.job.spec.lease,
    status: "waiting_for_human", finished: new Date().toISOString(), question: "Synthetic question?" }, runtime);
  expect(question.status).toBe(200);
  hub.modules.reconcile();
  await applied("work.project.update", { project: p.id, expected_revision: p.revision, patch: { default_target: "claude-code@mac" } });
  expect((await list()).find(value => value.id === untouched.id)?.next_target).toEqual({ target: "claude-code@mac", source: "project" });
  expect((await show(implicit.id)).task.next_target).toEqual({ target: "codex@mac", source: "last_round" });
  expect((await client().jobs(undefined, implicit.id))[0]?.spec.run).toMatchObject({ engine: "codex" });
  const replay = await command("work.task.dispatch", { task: implicit.id }, human, request);
  expect(replay.headers.get("X-Lumio-Offline-Targets")).toBe("codex@mac");
  expect(WorkCommandResult.parse(await replay.json())).toEqual(initial);
  expect((await show(t.id)).task).toMatchObject({ turn: { reason: "answer" }, next_target: { target: "claude-code@mac", source: "last_round" } });
  const answer = await applied("work.task.dispatch", { task: t.id, comment: "Synthetic answer" });
  expect(answer).toMatchObject({ kind: "job", target: "claude-code@mac", target_source: "last_round" });
  expect((await show(t.id)).executions.at(-1)?.input_snapshot).toContain("Synthetic answer");

  if (answer.kind !== "job") throw Error("Expected a job");
  await api("/v1/runtime/ack", { accepted: [answer.job.spec.id] }, runtime);
  const done = await api("/v1/runtime/results", { job: answer.job.spec.id, lease: answer.job.spec.lease,
    status: "done", finished: new Date().toISOString(), report: "Synthetic completion" }, runtime);
  expect(done.status).toBe(200);
  hub.modules.reconcile();
  const plan = { stages: [{ kind: "agent", id: "first", agent: "codex", instruction: "Synthetic plan" }] };
  const planned = await applied("work.task.plan.set", { task: t.id, expected_revision: (await show(t.id)).task.revision, plan });
  expect(planned).toMatchObject({ task: { next_target: { target: "codex@mac", source: "plan" } } });
  expect(await applied("work.task.dispatch", { task: t.id })).toMatchObject({ target: "codex@mac", target_source: "plan" });
  const explicitPlan = await applied("work.task.plan.set", { task: untouched.id, expected_revision: untouched.revision, plan });
  expect(explicitPlan).toMatchObject({ task: { next_target: { target: "codex@mac", source: "plan" } } });
  expect(await applied("work.task.dispatch", { task: untouched.id, to: "codex" })).toMatchObject({ target: "codex@mac", target_source: "explicit" });
});

test("project defaults are validated, cleared and detached while blocked or unavailable targets fail safely", async () => {
  const badCreate = await command("work.project.create", { title: "Synthetic invalid", default_target: "codex@missing" });
  expect(badCreate.status).toBe(400);
  expect(ApiError.parse(await badCreate.json()).error).toMatchObject({ code: "INVALID" });
  const mac = hub.store.runtimes(new Date())[0]!;
  hub.store.registerRuntime(mac.actor, { ...mac.registration, engines: [...mac.registration.engines,
    { name: "claude-code", version: "synthetic", sandbox: "os" }] }, new Date(0));
  const p = await project({ default_target: "claude-code@mac" });
  const blocked = await task({ project: p.id, dependencies: [(await task()).id] });
  for (const token of [human, agent]) expect((await command("work.task.dispatch", { task: blocked.id }, token)).status).toBe(409);
  const t = await task({ project: p.id });
  const badUpdate = await command("work.project.update", { project: p.id, expected_revision: p.revision, patch: { default_target: "codex@missing" } });
  expect(badUpdate.status).toBe(400);
  expect((await client().workProject(p.id)).revision).toBe(p.revision);

  hub.store.registerRuntime(mac.actor, mac.registration, new Date(0));
  const unavailable = await command("work.task.dispatch", { task: t.id });
  expect(unavailable.status).toBe(400);
  const error = ApiError.parse(await unavailable.json()).error;
  expect(error.code).toBe("INVALID");
  expect(error.message).toContain("Project default claude-code@mac");
  expect(error.message).toContain("codex@mac");
  const clear = await applied("work.project.update", { project: p.id, expected_revision: p.revision, patch: { default_target: null } });
  expect(clear.kind === "project" && clear.project.default_target).toBeUndefined();
  const missing = await command("work.task.dispatch", { task: t.id });
  expect(missing.status).toBe(400);
  expect(ApiError.parse(await missing.json()).error.message).toContain("set a default target");
  await applied("work.project.update", { project: p.id, expected_revision: p.revision + 1, patch: { default_target: "codex" } });
  await applied("work.project.delete", { project: p.id, expected_revision: p.revision + 2 });
  const read = WorkTaskDetail.parse(await (await api(`/v2/work/tasks/${t.id}`)).json()).task;
  expect(read.project).toBeUndefined();
  expect(read.next_target).toBeUndefined();
  expect(await client().jobs(undefined, t.id)).toEqual([]);
});

test("an agent's implicit proposal preserves its shown target and source through approval", async () => {
  const p = await project({ default_target: "codex" }), t = await task({ project: p.id });
  const request = "synthetic-default-proposal";
  const response = await command("work.task.dispatch", { task: t.id }, agent, request);
  expect(response.status).toBe(202);
  expect(response.headers.get("X-Lumio-Offline-Targets")).toBe("codex@mac");
  const pending = WorkCommandResult.parse(await response.json());
  if (pending.kind !== "proposal") throw Error("Expected a proposal");
  const proposal = Proposal.parse(hub.store.proposal(pending.proposal));
  expect(proposal.operation).toMatchObject({ args: { operation: { args: { to: "codex@mac", expected_revision: t.revision } } } });
  expect(await client().jobs(undefined, t.id)).toEqual([]);

  await applied("work.project.update", { project: p.id, expected_revision: p.revision, patch: { default_target: null } });
  expect((await api(`/v1/proposals/${proposal.id}/accept`, {})).status).toBe(200);
  const result = hub.modules.workStore.receipt(proposal.author, request)?.result;
  expect(result).toMatchObject({ kind: "job", target: "codex@mac", target_source: "project" });
  expect(await client().jobs(undefined, t.id)).toHaveLength(1);
});

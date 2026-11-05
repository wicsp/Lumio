import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, Proposal, WorkCommandResult, ExecutionTarget, Job, WorkProject } from "@lumio/schema";
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
async function project() { const r = await applied("work.project.create", { title: "Synthetic project", workdir: "/synthetic/project", repo: "https://example.test/repo" }); if (r.kind !== "project") throw Error(); return r.project; }
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

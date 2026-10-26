import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { FSWatcher, watch } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@lumio/core";
import { Actor, ApiError, Job, OperationResult, Proposal, type Operation } from "@lumio/schema";
import { authorize } from "../src/authorize.ts";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";

// 操作与提议的框架（ADR 0016）。正式规则里 task.dispatch 只有允许 / 拒绝；为了覆盖"需要批准 → 提议 → 接受后执行"，
// 这里注入一张规则表，把 agent 的 task.dispatch 当作需要批准的样例操作（P2-6 的 exec.privileged 走同一条路）。
const approvalRules: typeof authorize = (actor, request) =>
  actor?.role === "agent" && request.operation === "task.dispatch" ? { result: "needs_approval" } : authorize(actor, request);

let temp: string, vault: string, state: string;
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let human: string, agent: string, other: string, author: Actor, owner: Actor;
const TASK = "task_01M5AAAAAAAAAAAAAAAAAAAAT2";
const path = "plan/tasks/样例任务.md";
const operation: Operation = { op: "task.dispatch", args: { task: TASK, trigger: "cli" } };
const base = () => `http://127.0.0.1:${hub!.server.port}`;
async function request(p: string, token: string, body?: unknown) {
  return fetch(`${base()}${p}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function propose(token = agent, reason = "请帮我派出") {
  const response = await request("/v1/operations", token, { operation, reason });
  expect(response.status).toBe(202);
  const result = OperationResult.parse(await response.json());
  if (result.status !== "pending_approval") throw new Error("expected proposal");
  return result.proposal;
}
async function decide(p: Proposal, action: "accept" | "reject", token = human, expected = 200) {
  const response = await request(`/v1/proposals/${p.id}/${action}`, token, {});
  expect(response.status).toBe(expected);
  return expected === 200 ? Proposal.parse(await response.json()) : ApiError.parse(await response.json()).error;
}
async function jobs() { return Job.array().parse(await (await request(`/v1/jobs?task=${TASK}`, human)).json()); }

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-operations-")); vault = join(temp, "vault"); state = join(temp, "hub");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url), vault, { recursive: true });
  await writeFile(join(vault, path), `---\nid: ${TASK}\ntype: task\ntitle: 样例任务\ncreated: 2026-10-26T10:00:00+08:00\nupdated: 2026-10-26T10:00:00+08:00\nstatus: todo\nturn: human\nassignee: {agent: pi, device: server}\nworkdir: ${join(temp, "proj")}\n---\n要求\n`);
  const store = await HubStore.open(state);
  owner = store.createActor("owner", "human"); author = store.createActor("codex", "agent"); store.createActor("other", "agent");
  store.createActor("server", "runtime");
  human = store.createToken("owner-mac", "owner"); agent = store.createToken("codex-mac", "codex"); other = store.createToken("other-mac", "other");
  const runtime = store.createToken("server", "server"); store.close();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state }), port: 0, autosaveIdle: 3600 }, {
    log() {}, authorize: approvalRules, tasks: { tickMs: 3_600_000 },
    watch: { watch: ((_p, _o, _cb) => Object.assign(new EventEmitter(), { close() {} }) as FSWatcher) as typeof watch },
  });
  // 只登记一个执行器（不启动进程）：派出的一轮停在 queued，足够验证审批流程。
  const registered = await request("/v1/runtime/register", runtime, { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "1.4.0", sandbox: "none" }], tags: [], max_concurrent: 1 });
  expect(registered.status).toBe(200);
});
afterEach(async () => { await hub?.stop(); hub = undefined; await rm(temp, { recursive: true, force: true }); });

test("needs_approval creates a proposal without executing; only humans decide; accepting executes the stored operation once", async () => {
  const p = await propose();
  expect(p).toMatchObject({ operation, reason: "请帮我派出", author: author.id, status: "pending" });
  expect(await jobs()).toHaveLength(0);
  for (const action of ["accept", "reject"] as const) {
    const error = await decide(p, action, agent, 403) as ApiError["error"];
    expect(error).toMatchObject({ code: "FORBIDDEN", operation, reason: "agent-cannot-decide-proposals", proposal: p.id });
  }
  const accepted = await decide(p, "accept") as Proposal;
  expect(accepted).toMatchObject({ status: "accepted", decided_by: owner.id });
  expect(await jobs()).toHaveLength(1);
  expect(parseFrontmatter(await readFile(join(vault, path))).data.turn).toBe("agent");
  expect((await decide(accepted, "accept", human, 409) as ApiError["error"]).code).toBe("CONFLICT");
  expect(await jobs()).toHaveLength(1);
});

test("rejection executes nothing; duplicates are refused; reason is required; agents only see their own proposals", async () => {
  const p = await propose();
  const dup = await request("/v1/operations", agent, { operation, reason: "再来一次" });
  expect(dup.status).toBe(409); expect(ApiError.parse(await dup.json()).error.proposal).toBe(p.id);
  const noReason = await request("/v1/operations", other, { operation });
  expect(noReason.status).toBe(400);
  expect(((await decide(p, "reject")) as Proposal).status).toBe("rejected");
  expect(await jobs()).toHaveLength(0);
  const mine = Proposal.array().parse(await (await request("/v1/proposals?status=rejected", agent)).json());
  expect(mine.map((x) => x.id)).toEqual([p.id]);
  expect(Proposal.array().parse(await (await request("/v1/proposals?status=rejected", other)).json())).toHaveLength(0);
});

test("proposals persist across restarts; actors are listed for both roles; audit records every step with actor IDs only", async () => {
  const p = await propose();
  await hub!.stop();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state }), port: 0, autosaveIdle: 3600 }, {
    log() {}, authorize: approvalRules, tasks: { tickMs: 3_600_000 },
    watch: { watch: ((_p, _o, _cb) => Object.assign(new EventEmitter(), { close() {} }) as FSWatcher) as typeof watch },
  });
  expect(Proposal.array().parse(await (await request("/v1/proposals", human)).json()).map((x) => x.id)).toEqual([p.id]);
  for (const token of [human, agent]) {
    const actors = Actor.array().parse(await (await request("/v1/actors", token)).json());
    expect(actors.map((a) => a.name)).toContain("owner");
  }
  await decide(p, "accept");
  const rows = hub!.store.db.query<{ actor_id: string; authorization: string; proposal_id: string | null; execution_result: string | null }, []>(
    "SELECT actor_id, authorization, proposal_id, execution_result FROM audit WHERE operation LIKE '%task.dispatch%'").all();
  expect(rows).toContainEqual({ actor_id: author.id, authorization: "needs_approval", proposal_id: p.id, execution_result: "pending_approval" });
  expect(rows).toContainEqual({ actor_id: owner.id, authorization: "allow", proposal_id: p.id, execution_result: "accepted" });
  expect(JSON.stringify(rows)).not.toContain(agent); expect(JSON.stringify(rows)).not.toContain(human);
});

test("with the real rules agents cannot dispatch at all: 403, nothing written, no proposal", async () => {
  await hub!.stop();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state }), port: 0, autosaveIdle: 3600 }, {
    log() {}, tasks: { tickMs: 3_600_000 },
    watch: { watch: ((_p, _o, _cb) => Object.assign(new EventEmitter(), { close() {} }) as FSWatcher) as typeof watch },
  });
  const before = await readFile(join(vault, path));
  const response = await request("/v1/operations", agent, { operation, reason: "想派" });
  expect(response.status).toBe(403);
  expect(ApiError.parse(await response.json()).error).toMatchObject({ code: "FORBIDDEN", reason: "agent-cannot-dispatch-tasks", operation });
  expect(await readFile(join(vault, path))).toEqual(before);
  expect(hub!.store.proposals("pending")).toHaveLength(0);
});

test("without assignee.device an offline runtime still gets the round; it waits on the Hub until that runtime polls", async () => {
  await writeFile(join(vault, path), (await readFile(join(vault, path), "utf8")).replace("{agent: pi, device: server}", "{agent: pi}"));
  const later = Date.now() + 3_600_000; // 执行器一小时没心跳：已离线
  expect(hub!.store.runtimes(new Date(later)).every((r) => !r.online)).toBe(true);
  const job = await hub!.tasks.dispatch(TASK, "cli", { actor: owner, label: "test" }, later);
  expect(job.status).toBe("queued");
  expect((await jobs()).map((j) => j.spec.id)).toEqual([job.spec.id]);
});

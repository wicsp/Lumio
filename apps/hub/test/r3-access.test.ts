import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInfo, AgentTokenIssued, Job, RuntimeSync, WorkCommandResult } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { HubStore } from "../src/store.ts";

let temp: string, hub: Awaited<ReturnType<typeof startHub>>, human: string, runtime: string, manual: string, logs: string[];
let now: Date, seq = 0;
let daemon: ReturnType<typeof Bun.spawn> | undefined;
const url = () => `http://127.0.0.1:${hub.server.port}`;
async function api(path: string, body?: unknown, token = human, features = false) {
  return fetch(url() + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(features ? { "X-Lumio-Features": "other, job-access" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function command(op: string, args: object, token = human) {
  const response = await api("/v2/work/commands", { request_id: `synthetic-access-${++seq}`, operation: { op, args } }, token);
  expect(response.status).toBe(200); return WorkCommandResult.parse(await response.json());
}
async function round(timeout_seconds = 120) {
  const created = await command("work.task.create", { title: "Synthetic access" });
  if (created.kind !== "task") throw new Error("Expected task");
  const dispatched = await command("work.task.dispatch", { task: created.task.id, to: "pi@server" });
  if (dispatched.kind !== "job") throw new Error("Expected job");
  if (timeout_seconds !== 120) hub.store.executionStore.save({ ...dispatched.job, spec: { ...dispatched.job.spec, timeout_seconds } });
  return { task: created.task, job: dispatched.job };
}
const heartbeat = { running: [], queued: [], outbox: 0 };
async function delivery() { return RuntimeSync.parse(await (await api("/v1/runtime/sync", heartbeat, runtime, true)).json()); }
async function ack(job: Job) { expect((await api("/v1/runtime/ack", { accepted: [job.spec.id] }, runtime)).status).toBe(200); }

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-agent-access-")); now = new Date(); logs = [];
  const state = join(temp, "state"), store = await HubStore.open(state);
  store.createActor("owner", "human"); store.createActor("server", "runtime");
  human = store.createToken("human", "owner"); runtime = store.createToken("runtime", "server"); manual = store.issueAgentToken("personal").token;
  const actor = store.actors().find(value => value.name === "server")!;
  store.registerRuntime(actor.id, { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "1.4.0", sandbox: "none" }], tags: [], max_concurrent: 1 }, now);
  store.close();
  await cp(new URL("../../../fixtures/query-vault", import.meta.url), join(temp, "vault"), { recursive: true });
  hub = await startHub({ ...readConfig({ HOME: temp, LUMIO_STATE_DIR: state, LUMIO_VAULT: join(temp, "vault") }), localRuntime: "server", port: 0 }, { now: () => now, log: line => logs.push(line) });
});
afterEach(async () => { daemon?.kill("SIGTERM"); await daemon?.exited; daemon = undefined; await hub?.stop(); await rm(temp, { recursive: true, force: true }); });

test("human manages agent tokens; labels are scoped to the agent; listings and audit contain no plaintext", async () => {
  for (const token of [manual, runtime]) for (const [path, body] of [["/v2/agents", undefined], ["/v2/agents/tokens", { name: "test" }], ["/v2/agents/revoke", { name: "personal" }]] as const) expect((await api(path, body, token)).status).toBe(403);
  const issued = AgentTokenIssued.parse(await (await api("/v2/agents/tokens", { name: "codex@mac", label: "synthetic-first" })).json());
  const second = AgentTokenIssued.parse(await (await api("/v2/agents/tokens", { name: issued.actor.name, label: "synthetic-second" })).json());
  expect(second.actor).toEqual(issued.actor);
  expect((await api("/v2/agents/tokens", { name: "owner" })).status).toBe(409);
  expect((await api("/v2/agents/tokens", { name: "agent", label: "../bad" })).status).toBe(400);
  expect((await api("/v2/work/tasks", undefined, issued.token)).status).toBe(200);
  const listed = AgentInfo.array().parse(await (await api("/v2/agents")).json());
  expect(listed.find(value => value.actor.name === issued.actor.name)?.tokens).toEqual(expect.arrayContaining([expect.objectContaining({ label: issued.label, kind: "manual", last_used: expect.any(String) })]));
  expect(JSON.stringify(listed)).not.toContain(issued.token);
  expect((await api("/v2/agents/revoke", { name: "personal", label: issued.label })).status).toBe(404);
  expect((await api("/v2/agents/revoke", { name: issued.actor.name, label: issued.label })).status).toBe(204);
  expect((await api("/v2/work/tasks", undefined, issued.token)).status).toBe(401);
  expect((await api("/v2/work/tasks", undefined, second.token)).status).toBe(200);
  expect((await api("/v2/agents/revoke", { name: issued.actor.name })).status).toBe(204);
  expect((await api("/v2/work/tasks", undefined, second.token)).status).toBe(401);
  expect(JSON.stringify(hub.store.db.query("SELECT * FROM tokens").all())).not.toContain(issued.token);
  expect(JSON.stringify(hub.store.db.query("SELECT * FROM audit").all()) + logs.join("\n")).not.toContain(issued.token);
});

test("feature negotiation, redelivery rotation, per-round identity, permissions and result invalidation", async () => {
  const { task, job } = await round();
  const legacy = await (await api("/v1/runtime/sync", heartbeat, runtime)).json();
  expect(Object.keys(legacy as object).sort()).toEqual(["cancel", "jobs", "routines"]);
  const first = (await delivery()).access![0]!, access = (await delivery()).access![0]!;
  expect(first.token).not.toBe(access.token); expect((await api("/v2/work/tasks", undefined, first.token)).status).toBe(401);
  await ack(job);
  expect((await delivery()).access).toEqual([]);
  expect((await api("/v2/work/tasks", undefined, access.token)).status).toBe(200);
  const comment = await command("work.task.comment", { task: task.id, body: "Synthetic round comment" }, access.token);
  expect(comment.kind).toBe("comment");
  const denied = await api("/v2/work/commands", { request_id: `synthetic-denied-${++seq}`, operation: { op: "work.task.finish", args: { task: task.id, expected_revision: task.revision, outcome: "done" } } }, access.token);
  expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ error: { reason: "agent-operation-not-allowed" } });
  expect((await api("/v1/search?q=test&include_private=true", undefined, access.token)).status).toBe(403);
  const agents = AgentInfo.array().parse(await (await api("/v2/agents")).json());
  expect(agents.find(value => value.actor.id === access.actor)).toMatchObject({ actor: { name: "pi@server" }, tokens: [expect.objectContaining({ kind: "job", job: job.spec.id })] });
  expect((await api("/v1/runtime/results", { job: job.spec.id, lease: job.spec.lease, status: "done", finished: now.toISOString(), report: "Synthetic round report" }, runtime)).status).toBe(200);
  expect((await api("/v2/work/tasks", undefined, access.token)).status).toBe(401);
  expect((await api("/v2/work/tasks", undefined, manual)).status).toBe(200);
  expect(JSON.stringify(hub.store.executionStore.get(job.spec.id)) + logs.join("\n")).not.toContain(access.token);
});

for (const condition of ["cancel", "lease", "expires"] as const) test(`job credential immediately fails after ${condition}`, async () => {
  const { job } = await round(1), access = (await delivery()).access![0]!; await ack(job);
  expect((await api("/v2/work/tasks", undefined, access.token)).status).toBe(200);
  if (condition === "cancel") expect((await api(`/v1/jobs/${job.spec.id}/cancel`, {})).status).toBe(200);
  else if (condition === "lease") hub.store.executionStore.save({ ...hub.store.executionStore.get(job.spec.id)!, spec: { ...job.spec, lease: "synthetic-replacement-lease" } });
  else {
    now = new Date(Date.parse(access.expires));
    const listed = AgentInfo.array().parse(await (await api("/v2/agents")).json());
    expect(listed.flatMap(value => value.tokens).some(value => value.job === job.spec.id)).toBe(false);
  }
  expect((await api("/v2/work/tasks", undefined, access.token)).status).toBe(401);
});

test("synthetic runtime agent queries and comments with only its round credential; output is redacted", async () => {
  const { task, job } = await round();
  const bin = join(temp, "bin"); await mkdir(bin);
  await writeFile(join(bin, "pi"), `#!${process.execPath}\n` + await readFile(new URL("./fixtures/access-agent.ts", import.meta.url), "utf8"), { mode: 0o700 });
  daemon = Bun.spawn([process.execPath, new URL("../../runtime/src/main.ts", import.meta.url).pathname], { env: { HOME: temp, PATH: bin, LUMIO_HUB_URL: url(), LUMIO_TOKEN: runtime, LUMIO_RUNTIME_NAME: "server", LUMIO_RUNTIME_POLL_SECONDS: "0.03", LUMIO_RUNTIME_STATE_DIR: join(temp, "runtime"), SYNTHETIC_TASK: task.id }, stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 15000;
  while (!hub.store.executionStore.get(job.spec.id)?.result && Date.now() < deadline) await Bun.sleep(30);
  const result = hub.store.executionStore.get(job.spec.id)?.result;
  expect(result!.status).toBe("done");
  expect(result!.report).toContain("Synthetic access succeeded");
  expect(result!.report).toContain("[REDACTED]");
  expect(hub.modules.work.detail(task.id).comments.some(value => value.body === "Synthetic process comment")).toBe(true);
  expect(await readFile(result!.log!, "utf8")).toContain("[REDACTED]");
  const actor = hub.store.actors().find(value => value.name === "pi@server")!;
  expect(hub.store.agents().find(value => value.actor.id === actor.id)?.tokens).toEqual([]);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ApiError, HandoffPlan, Job, PlanTemplate, RuntimeInfo, WorkAttention, WorkCommandRequest, WorkCommandResult, WorkTaskDetail } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { HubStore } from "../src/store.ts";

let temp: string, human: string, agent: string, runtime: string, runtimeActor: string;
let hub: Awaited<ReturnType<typeof startHub>>;
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let sequence = 0;
const plan = HandoffPlan.parse({ stages: [
  { kind: "agent", id: "implement", agent: "codex@mac", instruction: "Implement the synthetic change" },
  { kind: "agent", id: "review", agent: "claude-code@mac", instruction: "Review the synthetic change", back_to: "implement" },
  { kind: "checkpoint", id: "approve", prompt: "Merge this synthetic change?" },
  { kind: "agent", id: "merge", agent: "claude-code@mac", instruction: "Merge the synthetic change" },
] });
const base = () => hub.server.url.href.replace(/\/$/, "");
const client = () => ({
  async workCommand(input: WorkCommandRequest) {
    const response = await request("/v2/work/commands", input); expect(response.status).toBe(200);
    return WorkCommandResult.parse(await response.json());
  },
  async workTask(id: string) { return WorkTaskDetail.parse(await (await request(`/v2/work/tasks/${id}`)).json()); },
  async workAttention() { return WorkAttention.array().parse(await (await request("/v2/work/attention")).json()); },
  async workPlanTemplates() { return PlanTemplate.array().parse(await (await request("/v2/work/plan-templates")).json()); },
});
function request(path: string, body?: unknown, token = human, language = "en") {
  return fetch(`${base()}${path}`, { method: body === undefined ? "GET" : "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept-Language": language,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function command(op: string, args: Record<string, unknown>, request_id = `synthetic-plan-${++sequence}`) {
  return client().workCommand(WorkCommandRequest.parse({ request_id, operation: { op, args } }));
}
async function createTask(selectedPlan = plan, from?: string) {
  const created = await command("work.task.create", { title: "Synthetic planned task", description: "Synthetic requirements", workdir: join(temp, "project") });
  if (created.kind !== "task") throw new Error("task expected");
  await command("work.task.plan.set", { task: created.task.id, expected_revision: created.task.revision, plan: selectedPlan, from });
  return created.task.id;
}
async function eventually(check: () => boolean | Promise<boolean>, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(30); }
  throw new Error("Synthetic handoff timed out");
}
async function startRuntime() {
  const bin = join(temp, "bin"), fixture = new URL("./fixtures/handoff-agent.ts", import.meta.url).pathname;
  await mkdir(bin);
  for (const engine of ["codex", "claude"]) {
    const path = join(bin, engine);
    await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" ${engine} "$@"\n`);
    await chmod(path, 0o755);
  }
  daemon = Bun.spawn([process.execPath, new URL("../../runtime/src/main.ts", import.meta.url).pathname], { env: {
    HOME: temp, PATH: `${bin}:${dirname(Bun.which("git")!)}`, LUMIO_HUB_URL: base(), LUMIO_TOKEN: runtime,
    LUMIO_RUNTIME_NAME: "mac", LUMIO_RUNTIME_STATE_DIR: join(temp, "runtime"), LUMIO_RUNTIME_POLL_SECONDS: "0.05",
    SYNTHETIC_AGENT_LOG: join(temp, "agent-log.jsonl"), SYNTHETIC_REVIEW_COUNT: join(temp, "review-count"),
  }, stdout: "pipe", stderr: "pipe" });
  await eventually(async () => RuntimeInfo.array().parse(await (await request("/v1/runtimes")).json()).some(value => value.registration.name === "mac" && value.registration.features?.includes("permission_request")));
}
async function cli(args: string[], language = "en", token = human) {
  const child = Bun.spawn([process.execPath, new URL("../../cli/src/main.ts", import.meta.url).pathname, ...args], {
    env: { HOME: temp, PATH: process.env.PATH, LUMIO_HUB_URL: base(), LUMIO_TOKEN: token, LUMIO_LANG: language }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-handoff-")); await mkdir(join(temp, "project"));
  const store = await HubStore.open(join(temp, "hub"));
  store.createActor("synthetic-owner", "human"); store.createActor("synthetic-agent", "agent");
  runtimeActor = store.createActor("mac", "runtime").id;
  human = store.createToken("human", "synthetic-owner"); agent = store.createToken("agent", "synthetic-agent"); runtime = store.createToken("runtime", "mac");
  store.registerRuntime(runtimeActor, { protocol_version: 2, name: "mac", engines: [
    { name: "codex", version: "0.163.0", sandbox: "os" }, { name: "claude-code", version: "2.1.310", sandbox: "os" },
  ], tags: [], max_concurrent: 1 }, new Date()); store.close();
  hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: join(temp, "hub") }), localRuntime: "mac", port: 0 }, { log() {} });
});
afterEach(async () => {
  if (daemon) { daemon.kill("SIGTERM"); await daemon.exited; daemon = undefined; }
  await hub?.stop(); await rm(temp, { recursive: true, force: true });
});

test("fake agents run implementation → review (one send-back) → checkpoint continue → merge → human end in five rounds", async () => {
  await startRuntime(); const task = await createTask();
  expect(hub.modules.work.detail(task).executions).toHaveLength(0);
  const started = await command("work.task.dispatch", { task });
  expect(started.kind).toBe("job");
  await eventually(() => {
    const detail = hub.modules.work.detail(task);
    if (detail.task.turn.holder === "human" && detail.task.turn.reason !== "review") throw new Error(JSON.stringify(detail));
    return detail.task.turn.stage === "approve";
  });
  let detail = WorkTaskDetail.parse(await client().workTask(task));
  expect(detail.task).toMatchObject({ plan: { rounds: 4, stage: "approve" }, turn: { holder: "human", reason: "review", stage: "approve" } });
  const attention = WorkAttention.array().parse(await client().workAttention());
  expect(attention).toMatchObject([{ task, stage: "approve", prompt: "Merge this synthetic change?", kind: "review" }]);
  const continued = await cli(["task", "checkpoint", task, "--stage", "approve", "--action", "continue", "--json", "--request-id", "synthetic-continue"]);
  expect(continued.code).toBe(0); WorkCommandResult.parse(JSON.parse(continued.stdout));
  expect((await cli(["task", "checkpoint", task, "--stage", "approve", "--action", "finish", "--json"])).code).toBe(1);
  await eventually(() => {
    const detail = hub.modules.work.detail(task);
    if (detail.task.turn.holder === "human" && detail.task.turn.reason !== "review") throw new Error(JSON.stringify(detail));
    return detail.task.turn.stage === "end";
  });
  detail = await client().workTask(task);
  expect(detail.task).toMatchObject({ outcome: "open", plan: { rounds: 5, stage: "end" }, turn: { holder: "human", reason: "review", stage: "end" } });
  expect(detail.executions.map(value => value.round)).toEqual([1, 2, 3, 4, 5]);
  const invocations = (await readFile(join(temp, "agent-log.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(invocations.map(value => [value.engine, value.stage])).toEqual([["codex", "implement"], ["claude", "review"], ["codex", "implement"], ["claude", "review"], ["claude", "merge"]]);
  for (const { engine, prompt } of invocations) {
    expect(prompt).toContain("Do only the work assigned for this round and its current stage");
    expect(prompt).toContain(engine === "codex" ? "Git metadata is protected" : "without an OS sandbox");
    expect(prompt).toContain("no stage-specific secrets");
    expect(prompt).toContain("<lumio-permission>git</lumio-permission>");
    expect(prompt).toContain("For system commands that require root, use `lumio-runtime sudo --");
  }
  expect(invocations[2].prompt).toContain("Fix the synthetic edge case");
  const system = hub.store.workActor();
  const autoTurns = detail.turns.filter(turn => turn.by === system.id);
  expect(autoTurns).toHaveLength(5);
  expect(autoTurns.slice(0, 3).every(turn => turn.to.note?.includes("Plan "))).toBe(true);
  const audits = hub.store.db.query<{ actor_id: string; operation: string }, []>("SELECT actor_id,operation FROM audit WHERE operation LIKE '%work.task.plan.advance%'").all();
  expect(audits.filter(row => row.actor_id === system.id)).toHaveLength(5);
  expect(audits.map(row => JSON.parse(row.operation).stage)).toContain("merge");
  expect(audits.every(row => JSON.parse(row.operation).plan.approved.by)).toBe(true);
  expect(hub.store.db.query("SELECT * FROM tokens WHERE actor_id=?").all(system.id)).toEqual([]);
  expect((await client().workAttention())[0]).toMatchObject({ stage: "end", kind: "review" });
  const before = detail.executions.length; hub.modules.reconcile(); hub.modules.reconcile();
  expect(hub.modules.work.detail(task).executions).toHaveLength(before);
}, 30000);

for (const [stage, reason] of [["question", "answer"], ["failure", "failed"], ["loop", "review"]] as const) {
  test(`fake ${stage} stops with the human and preserves plan progress`, async () => {
    await startRuntime();
    const task = await createTask(HandoffPlan.parse({ max_rounds: 2, stages: [
      { kind: "agent", id: stage, agent: "codex@mac", instruction: `Synthetic ${stage}`, back_to: stage },
    ] }));
    await command("work.task.dispatch", { task });
    await eventually(() => hub.modules.work.task(task).turn.holder === "human");
    const detail = await client().workTask(task);
    expect(detail.task.turn).toMatchObject({ holder: "human", reason, stage });
    expect(detail.task.plan?.rounds).toBe(stage === "loop" ? 2 : 1);
    expect(detail.executions).toHaveLength(stage === "loop" ? 2 : 1);
    if (stage === "loop") expect(detail.task.turn.note).toMatch(/2/);
  }, 30000);
}

for (const language of ["en", "zh"]) test(`CLI plan/template commands, human-only access and persisted templates (${language})`, async () => {
  const created = await command("work.task.create", { title: "Synthetic CLI task" });
  if (created.kind !== "task") throw new Error("task expected");
  const task = created.task.id, path = join(temp, "plan.json"); await writeFile(path, JSON.stringify(plan));
  const set = await cli(["task", "plan", "set", task, "--file", path, "--from", "approve", "--json"], language);
  expect(set.code).toBe(0); WorkCommandResult.parse(JSON.parse(set.stdout));
  const shown = await cli(["task", "plan", "show", task, "--json"], language);
  expect(shown.code).toBe(0); expect(JSON.parse(shown.stdout)).toMatchObject({ stage: "approve", rounds: 0 });
  const saveArgs = ["plan-template", "save", "Synthetic template", "--file", path, "--json", "--request-id", `synthetic-save-${language}`];
  const saved = await cli(saveArgs, language); expect(saved.code).toBe(0);
  const template = WorkCommandResult.parse(JSON.parse(saved.stdout)); if (template.kind !== "template") throw new Error("template expected");
  expect(JSON.parse((await cli(saveArgs, language)).stdout)).toEqual(template);
  const listed = await cli(["plan-template", "list", "--json"], language);
  expect(PlanTemplate.array().parse(JSON.parse(listed.stdout))).toEqual([template.template]);
  expect((await cli(["plan-template", "save", "Updated", "--file", path, "--template", template.template.id, "--json"], language)).code).toBe(0);
  expect((await request("/v2/work/plan-templates", undefined, agent)).status).toBe(403);
  expect((await request("/v2/work/plan-templates", undefined, runtime)).status).toBe(403);
  for (const operation of [
    { op: "work.task.checkpoint", args: { task, stage: "approve", action: "continue" } },
    { op: "work.plan_template.delete", args: { template: template.template.id } },
  ]) expect((await request("/v2/work/commands", { request_id: `synthetic-denied-${++sequence}`, operation }, agent)).status).toBe(403);
  const proposed = await cli(["task", "plan", "set", task, "--file", path, "--json"], language, agent);
  expect(JSON.parse(proposed.stdout).kind).toBe("proposal");
  const stale = await cli(["task", "checkpoint", task, "--stage", "merge", "--action", "hold", "--json"], language);
  expect(ApiError.parse(JSON.parse(stale.stdout)).error.code).toBe("CONFLICT");
  expect(ApiError.parse(JSON.parse(stale.stdout)).error.message).toMatch(language === "en" ? /stage/ : /阶段/);
  expect((await cli(["task", "checkpoint", task, "--stage", "approve", "--action", "send-back", "--back-to", "implement", "--comment", "Synthetic human feedback", "--json"], language)).code).toBe(0);
  expect(hub.modules.work.detail(task).executions[0]!.input_snapshot).toContain("Synthetic human feedback");
  await hub.stop(); hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: join(temp, "hub") }), port: 0 }, { log() {} });
  expect((await client().workPlanTemplates())[0]?.name).toBe("Updated");
  expect((await cli(["plan-template", "delete", template.template.id, "--json"], language)).code).toBe(0);
  expect(await client().workPlanTemplates()).toEqual([]);
  await writeFile(path, "null");
  // Stop the synthetic queued round before clearing the plan.
  await command("work.task.hand", { task, expected_revision: hub.modules.work.task(task).revision, to: "human" });
  expect((await cli(["task", "plan", "set", task, "--file", path, "--json"], language)).code).toBe(0);
  expect(JSON.parse((await cli(["task", "plan", "show", task, "--json"], language)).stdout)).toBeNull();
}, 30000);

test("automatic plan handoff, execution, result application and system audit roll back together", async () => {
  const task = await createTask(); const first = await command("work.task.dispatch", { task });
  if (first.kind !== "job") throw new Error("job expected");
  await request("/v1/runtime/ack", { accepted: [first.job.spec.id] }, runtime);
  hub.store.db.exec("CREATE TRIGGER fail_plan_audit BEFORE INSERT ON audit WHEN NEW.operation LIKE '%work.task.plan.advance%' BEGIN SELECT RAISE(FAIL,'synthetic plan audit failure'); END");
  const result = { job: first.job.spec.id, lease: first.job.spec.lease, status: "done", finished: new Date().toISOString(), report: "Synthetic delivery" };
  await request("/v1/runtime/results", result, runtime);
  const failed = hub.modules.work.detail(task);
  expect(failed.executions).toHaveLength(1); expect(failed.executions[0]?.applied).toBe(false);
  expect(failed.comments).toEqual([]); expect(failed.task.plan?.rounds).toBe(1);
  expect(Job.array().parse(await (await request(`/v1/jobs?task=${task}`)).json())).toHaveLength(1);
  hub.store.db.exec("DROP TRIGGER fail_plan_audit"); hub.modules.reconcile();
  expect(hub.modules.work.detail(task).executions).toHaveLength(2);
  expect(hub.modules.work.task(task).plan?.rounds).toBe(2);
});

test("an unavailable approved agent stops for human handling without replaying the delivered round", async () => {
  const task = await createTask(), started = await command("work.task.dispatch", { task });
  if (started.kind !== "job") throw new Error("job expected");
  await request("/v1/runtime/ack", { accepted: [started.job.spec.id] }, runtime);
  hub.store.registerRuntime(runtimeActor, { protocol_version: 2, name: "mac", engines: [
    { name: "codex", version: "0.163.0", sandbox: "os" },
  ], tags: [], max_concurrent: 1 }, new Date());
  expect((await request("/v1/runtime/results", { job: started.job.spec.id, lease: started.job.spec.lease,
    status: "done", finished: new Date().toISOString(), report: "Synthetic successful implementation" }, runtime)).status).toBe(200);
  hub.modules.reconcile();
  const detail = await client().workTask(task);
  expect(detail.task).toMatchObject({ plan: { stage: "review", rounds: 1 }, turn: { holder: "human", reason: "failed", stage: "review" } });
  expect(detail.task.turn.note).toContain("review");
  expect(detail.executions).toHaveLength(1); expect(detail.executions[0]?.applied).toBe(true);
  expect(detail.comments).toHaveLength(1);
});

test("an agent proposes saving a plan template and only human approval persists it", async () => {
  const operation = { op: "work.plan_template.save", args: { name: "Synthetic proposed plan", plan } };
  const input = { request_id: "synthetic-template-proposal", operation };
  const response = await request("/v2/work/commands", input, agent);
  expect(response.status).toBe(202);
  const result = WorkCommandResult.parse(await response.json());
  if (result.kind !== "proposal") throw new Error("proposal expected");
  expect(await (await request("/v2/work/commands", input, agent)).json()).toEqual(result);
  expect(await client().workPlanTemplates()).toEqual([]);
  const accept = `/v1/proposals/${result.proposal}/accept`;
  expect((await request(accept, {}, agent)).status).toBe(403);
  expect((await request(accept, {})).status).toBe(200);
  expect(await client().workPlanTemplates()).toMatchObject([{ name: "Synthetic proposed plan", plan }]);
  expect((await request(accept, {})).status).toBe(409);
});

test("Hub persists parallel turns, resumes the interrupted branch and cancels active siblings", async () => {
  const registered = hub.store.runtimes(new Date()).find(value => value.actor === runtimeActor)!;
  hub.store.registerRuntime(runtimeActor, { ...registered.registration, features: ["stage_permissions"] }, new Date());
  const graph = HandoffPlan.parse({ stages: [
    { kind: "agent", id: "first", agent: "codex@mac", instruction: "First", access: "read" },
    { kind: "agent", id: "second", agent: "codex@mac", instruction: "Second", access: "read", after: [] },
  ] });
  const task = await createTask(graph);
  await command("work.task.dispatch", { task });
  const [first, second] = (await client().workTask(task)).task.turn.parallel!;
  const jobs = Job.array().parse(await (await request(`/v1/jobs?task=${task}`)).json());
  expect(jobs.map(job => job.spec.source?.previous)).toEqual([undefined, undefined]);
  await request("/v1/runtime/ack", { accepted: [first!.job, second!.job] }, runtime);
  const result = async (id: string, status: "done" | "waiting_for_human") => {
    const job = jobs.find(job => job.spec.id === id)!;
    const response = await request("/v1/runtime/results", { job: id, lease: job.spec.lease, status,
      finished: new Date().toISOString(), report: "Synthetic result", session_id: `synthetic-session-${id}`,
      ...(status === "waiting_for_human" ? { question: "Synthetic question?" } : {}) }, runtime);
    expect(response.status).toBe(200);
    hub.modules.reconcile();
  };
  await result(first!.job, "waiting_for_human");
  expect((await client().workTask(task)).task.turn.stage).toBe("second");
  await hub.stop();
  hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: join(temp, "hub") }), localRuntime: "mac", port: 0 }, { log() {} });
  await result(second!.job, "done");
  expect((await client().workTask(task)).task.turn).toMatchObject({ stage: "first", reason: "answer" });
  const resumed = await command("work.task.dispatch", { task, comment: "Synthetic answer" });
  expect(resumed).toMatchObject({ kind: "job", job: { spec: { source: { previous: first!.job },
    run: { session: { id: `synthetic-session-${first!.job}`, resume: true } } } } });

  const cancelled = await createTask(graph);
  await command("work.task.dispatch", { task: cancelled });
  const current = (await client().workTask(cancelled)).task;
  await command("work.task.finish", { task: cancelled, expected_revision: current.revision, outcome: "cancelled" });
  expect(Job.array().parse(await (await request(`/v1/jobs?task=${cancelled}`)).json()).map(job => job.status)).toEqual(["cancelled", "cancelled"]);
  expect((await client().workTask(cancelled)).task.plan?.active).toBeUndefined();
});

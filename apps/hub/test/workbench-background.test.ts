import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantModel } from "@lumio/assistant";
import { Exploration, ExplorationList, NoticeList, WorkCommandResult, toolName, type Job, type WorkTask } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";
import { WATCHDOG_LIMITS, watchdogEvent, watchdogFindings } from "../src/workbench-background.ts";

const now = new Date("2026-11-11T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

test("watchdog reports silent or long rounds and stale delegated tasks, nothing else", () => {
  const job = (id: string, status: Job["status"], assigned?: string, last_seen?: string) => ({
    spec: { id, created: minutesAgo(600) }, status, ...(assigned ? { assigned } : {}), ...(last_seen ? { last_seen } : {}),
  }) as unknown as Job;
  const task = (id: string, holder: string, updated: string, outcome = "open") => ({ id, outcome, updated, turn: { holder } }) as unknown as WorkTask;
  const findings = watchdogFindings(now, [
    job("job_00000000000000000000000001", "running", minutesAgo(40), minutesAgo(31)),
    job("job_00000000000000000000000002", "running", minutesAgo(5), minutesAgo(1)),
    job("job_00000000000000000000000003", "running", minutesAgo(7 * 60), minutesAgo(1)),
    job("job_00000000000000000000000004", "done", minutesAgo(9000), minutesAgo(9000)),
  ], [
    task("task_00000000000000000000000001", "codex@mac", minutesAgo(15 * 1440)),
    task("task_00000000000000000000000002", "human", minutesAgo(30 * 1440)),
    task("task_00000000000000000000000003", "nobody", minutesAgo(30 * 1440)),
    task("task_00000000000000000000000004", "external", minutesAgo(15 * 1440), "done"),
    task("task_00000000000000000000000005", "external", minutesAgo(3 * 1440)),
  ]);
  expect(findings.map(finding => `${finding.kind}:${finding.subject.id}`)).toEqual([
    "stalled_turn:job_00000000000000000000000001", "stalled_turn:job_00000000000000000000000003", "stale_task:task_00000000000000000000000001",
  ]);
  expect(WATCHDOG_LIMITS.stale_days).toBe(14);
  // Same findings on the same day share one event; order does not matter.
  expect(watchdogEvent(now, findings)).toBe(watchdogEvent(now, [...findings].reverse()));
  expect(watchdogEvent(new Date("2026-11-12T00:00:00Z"), findings)).not.toBe(watchdogEvent(now, findings));
});

async function fixture(model: AssistantModel) {
  const root = await mkdtemp(join(tmpdir(), "lumio-a1-9-"));
  const vault = join(root, "vault");
  await cp(new URL("../../../fixtures/k4-ai-notes", import.meta.url), vault, { recursive: true });
  const config = { ...readConfig({ HOME: root, LUMIO_STATE_DIR: join(root, "state"), LUMIO_VAULT: vault, LUMIO_WATCHDOG_INTERVAL_MINUTES: "0" }), port: 0 };
  const hub = await startHub(config, { assistantModel: model, assistantHome: join(root, "assistant"), log() {} });
  hub.store.createActor("owner", "human");
  const token = hub.store.createToken("owner", "owner");
  hub.store.createActor("helper", "agent");
  const agent = hub.store.createToken("helper", "helper");
  const api = (path: string, method: string, body?: unknown, bearer = token) => fetch(new URL(path, hub.server.url), {
    method, headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json", "Accept-Language": "en" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const created = WorkCommandResult.parse(await (await api("/v2/work/commands", "POST", {
    request_id: randomUUID(), operation: { op: "work.task.create", args: { title: "Try contrastive warmup" } } })).json());
  if (created.kind !== "task") throw new Error("task");
  const start = async (budget?: object) => {
    const response = await api("/v2/explorations/commands", "POST", { op: "start", request_id: randomUUID(), target: { module: "work", id: created.task.id }, ...(budget ? { budget } : {}) });
    expect(response.status).toBe(200);
    return Exploration.parse(await response.json());
  };
  const finish = async (id: string) => {
    await hub.modules.explorations.drain();
    await hub.modules.notices.drain();
    return Exploration.parse(await (await api("/v2/explorations/" + id, "GET")).json());
  };
  return { hub, api, agent, task: created.task, vault, start, finish,
    async close() { await hub.stop(); await rm(root, { recursive: true, force: true }); } };
}

test("an exploration reads as the assistant, writes an AI note from the target and leaves a notice", async () => {
  const inputs: string[] = [];
  const model: AssistantModel = { async complete(input) {
    inputs.push(JSON.stringify(input.messages));
    if (input.messages.at(-1)?.role === "user") return { content: "", tool_calls: [{ id: "c1", name: toolName("work.task.list"), args: {} }] };
    return { content: "Feasible: the warmup schedule already exists in lumio:" + "task_x" + ". Smallest step: rerun one seed.", tool_calls: [] };
  } };
  const f = await fixture(model);
  try {
    const started = await f.start();
    expect(started.state).toBe("queued");
    // Starting again while it is queued returns the same exploration.
    expect((await f.start()).id).toBe(started.id);
    const done = await f.finish(started.id);
    expect(done.state).toBe("found");
    expect(done.ai_note).toMatch(/^ain_/);
    expect(done.used!.tokens).toBeGreaterThan(0);
    expect(inputs[0]).toContain("Try contrastive warmup");
    expect(inputs[1]).toContain(f.task.id);
    const notices = NoticeList.parse(await (await f.api("/v2/notices", "GET")).json());
    const notice = notices.notices.find(value => value.source === "exploration");
    expect(notice?.ai_note).toBe(done.ai_note);
    expect(notice?.level).toBe("digest"); // no Jev configured: gate falls back to digest
    const list = ExplorationList.parse(await (await f.api("/v2/explorations?active=false", "GET")).json());
    expect(list.explorations.map(value => value.id)).toContain(started.id);
  } finally { await f.close(); }
});

test("nothing found is recorded silently; a budget overrun stops; cancel is versioned", async () => {
  let reply = "NOTHING";
  const model: AssistantModel = { async complete() { return { content: reply, tool_calls: [] }; } };
  const f = await fixture(model);
  try {
    const nothing = await f.finish((await f.start()).id);
    expect(nothing.state).toBe("nothing");
    expect(nothing.ai_note).toBeUndefined();
    const silent = NoticeList.parse(await (await f.api("/v2/notices?level=silent", "GET")).json());
    expect(silent.notices.some(value => value.source === "exploration")).toBe(true);
    expect(NoticeList.parse(await (await f.api("/v2/notices", "GET")).json()).notices.some(value => value.source === "exploration")).toBe(false);

    reply = "x".repeat(20_000);
    const stopped = await f.finish((await f.start({ max_tokens: 1000 })).id);
    expect(stopped.state).toBe("stopped");

    const queued = await f.start();
    const stale = await f.api("/v2/explorations/commands", "POST", { op: "cancel", request_id: randomUUID(), exploration: queued.id, expected_revision: queued.revision + 1 });
    expect(stale.status).toBe(409);
    const cancelled = await f.api("/v2/explorations/commands", "POST", { op: "cancel", request_id: randomUUID(), exploration: queued.id, expected_revision: queued.revision });
    expect(Exploration.parse(await cancelled.json()).state).toBe("cancelled");
    expect((await f.finish(queued.id)).state).toBe("cancelled");
  } finally { await f.close(); }
});

test("only humans manage explorations; the target must be readable by the assistant", async () => {
  const f = await fixture({ async complete() { return { content: "NOTHING", tool_calls: [] }; } });
  try {
    const agent = await f.api("/v2/explorations/commands", "POST", { op: "start", request_id: randomUUID(), target: { module: "work", id: f.task.id } }, f.agent);
    expect(agent.status).toBe(403);
    expect((await f.api("/v2/explorations", "GET", undefined, f.agent)).status).toBe(403);
    const missing = await f.api("/v2/explorations/commands", "POST", { op: "start", request_id: randomUUID(), target: { module: "work", id: "task_00000000000000000000000009" } });
    expect(missing.status).toBe(403);
    const source = await f.api("/v2/explorations/commands", "POST", { op: "start", request_id: randomUUID(), target: { module: "knowledge", id: "src_00000000000000000000000001" } });
    expect(source.status).toBe(400);
  } finally { await f.close(); }
});

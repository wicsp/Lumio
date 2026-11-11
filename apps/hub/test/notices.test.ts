import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIConnection, AssistantEvent, AssistantMain, Capture, CaptureCreate, CaptureCreateResult, DecisionGateBinding,
  Job, JobResult, NoticeCommand, NoticeCommandResult, NoticeList, ResourceRef, RuntimeRegistration, TYPESAFE_JEV_BASE_URL,
  WorkCommandRequest, WorkCommandResult, WorkTaskDetail, type AssistantModelRequest, type NoticeLevel,
} from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";
import { pushReceiver } from "./fixtures/push.ts";

const listPath = "/v2/notices";
const privateNote = ResourceRef.parse({ module: "knowledge", id: "ast_00000000000000000000000001" });

async function fixture(options: Parameters<typeof startHub>[1] = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lumio-a1-7-")), vault = join(dir, "vault");
  await cp(new URL("../../../fixtures/k4-ai-notes", import.meta.url), vault, { recursive: true });
  const config = { ...readConfig({
    HOME: dir, LUMIO_STATE_DIR: join(dir, "state"), LUMIO_VAULT: vault, LUMIO_PUBLIC_URL: "https://hub.example.test",
  }), port: 0, localRuntime: "server" };
  const start = () => startHub(config, { assistantHome: join(dir, "assistant"), log() {}, ...options });
  let hub = await start();
  const credential = (name: string, role: "human" | "agent" | "runtime" = "human") => {
    const actor = hub.store.createActor(name, role);
    return { actor, token: hub.store.createToken(name, name) };
  };
  const owner = credential("owner"), agent = credential("agent", "agent"), runtime = credential("server", "runtime");
  hub.store.registerRuntime(runtime.actor.id, RuntimeRegistration.parse({
    protocol_version: 2, name: "server", engines: [{ name: "pi", version: "synthetic", sandbox: "none" }], tags: [], max_concurrent: 2,
  }), new Date());
  const api = (path: string, method = "GET", body?: unknown, token = owner.token, accept = "application/json") =>
    fetch(new URL(path, hub.server.url), { method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Accept-Language": "en", Accept: accept },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const command = async (op: string, args: object, token = owner.token) => {
    const input = WorkCommandRequest.parse({ request_id: randomUUID(), operation: { op, args } });
    const response = await api("/v2/work/commands", "POST", input, token);
    expect([200, 202]).toContain(response.status);
    return WorkCommandResult.parse(await response.json());
  };
  const task = async (title: string, args: object = {}) => {
    const result = await command("work.task.create", { title, ...args });
    if (result.kind !== "task") throw new Error("Expected a task");
    return result.task;
  };
  const dispatch = async (task: string) => {
    const result = await command("work.task.dispatch", { task, to: "pi@server" });
    if (result.kind !== "job") throw new Error("Expected a job");
    const job = Job.parse(result.job);
    expect((await api("/v1/runtime/ack", "POST", { accepted: [job.spec.id] }, runtime.token)).status).toBe(200);
    return job;
  };
  const result = async (job: Job, report: string) => {
    const body = JobResult.parse({ job: job.spec.id, lease: job.spec.lease, status: "done", finished: new Date().toISOString(), report });
    return { body, submit: () => api("/v1/runtime/results", "POST", body, runtime.token) };
  };
  const ensure = async () => AssistantMain.parse(await (await api("/v2/assistant/main", "POST", { request_id: randomUUID() })).json()).conversation;
  const list = async (query = "", token = owner.token) => NoticeList.parse(await (await api(listPath + query, "GET", undefined, token)).json());
  const detail = async (task: string) => WorkTaskDetail.parse(await (await api("/v2/work/tasks/" + task)).json());
  const bind = async () => {
    const connection = AIConnection.parse(await (await api("/v2/ai/connections", "POST", {
      name: "Synthetic Jev", kind: "typesafe-jev", host: "hub", base_url: TYPESAFE_JEV_BASE_URL, api_key: "${secret:synthetic-jev}",
    })).json());
    const response = await api("/v2/ai/decision-binding", "PUT", { request_id: randomUUID(), connection: connection.id });
    return DecisionGateBinding.parse(await response.json());
  };
  return { get hub() { return hub; }, owner, agent, runtime, credential, api, command, task, dispatch, result, list, detail, ensure, bind,
    async restart() { await hub.stop(); hub = await start(); },
    async close() { await hub.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}

const reply = { content: "Synthetic reply", tool_calls: [] };
async function stream(response: Response) {
  expect(response.status).toBe(200);
  return (await response.text()).trim().split("\n").map(line => AssistantEvent.parse(JSON.parse(line)));
}

test("round pre-read waits for the main turn, preserves the terminal frame, and survives duplicate delivery and restart", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const requests: AssistantModelRequest[] = [];
  const receiver = pushReceiver(), pushes: unknown[] = [];
  const f = await fixture({
    assistantModel: { async complete(input) {
      requests.push(input);
      if (requests.length === 1) { entered.resolve(); await release.promise; }
      return reply;
    } },
    pushFetch: (async (_: string, init: RequestInit) => {
      pushes.push(receiver.decrypt(Buffer.from(init.body as Uint8Array)));
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch,
    jevFetch: async () => { throw new Error("A required action uses the rule"); },
  });
  try {
    const subject = await f.task("Synthetic task to review");
    const job = await f.dispatch(subject.id);
    const conversation = await f.ensure();
    expect((await f.api("/v2/notifications/push/devices", "POST", receiver.subscription)).status).toBe(200);
    const foreground = f.api("/v2/assistant/chat", "POST", {
      request_id: randomUUID(), conversation, message: "Keep discussing the current topic",
    }, f.owner.token, "application/x-ndjson").then(stream);
    await entered.promise;
    const report = "Synthetic result to pre-read.";
    const sent = await f.result(job, report);
    expect((await sent.submit()).status).toBe(200);
    expect((await sent.submit()).status).toBe(200);
    await f.hub.modules.notices.drain();
    expect(await f.list()).toEqual({ notices: [], unread: 0 });
    const taskBefore = await f.detail(subject.id);
    expect(taskBefore.comments.some(comment => comment.author === f.hub.store.assistantActor().id)).toBe(false);
    expect(JSON.stringify(requests[0])).not.toContain(report);

    release.resolve();
    const events = await foreground;
    expect(events.map(event => event.type)).toEqual(["notice", "result"]);
    const announcement = events[0];
    if (announcement?.type !== "notice") throw new Error("Expected a notice");
    const notice = announcement.notice;
    expect(announcement.turn).toBe(events[1]!.turn);
    expect(notice).toMatchObject({
      source: "turn", level: "important", graded: { by: "rule" }, subject: { module: "work", id: subject.id }, summary: report,
    });
    const taskAfter = await f.detail(subject.id);
    expect(taskAfter.task.revision).toBe(taskBefore.task.revision);
    const comment = taskAfter.comments.find(comment => comment.id === notice.comment);
    expect(comment).toMatchObject({ author: f.hub.store.assistantActor().id });
    expect(comment?.body).toContain(report);
    expect(f.hub.store.db.query("SELECT token_label FROM audit WHERE token_label='assistant-pre-read' AND operation='work.task.comment'").all()).toHaveLength(1);
    await f.hub.modules.notifications.drain();
    expect(pushes).toEqual([{ kind: "turn.review", title: subject.title, path: "#work/" + subject.id }]);

    const follow = await stream(await f.api("/v2/assistant/chat", "POST", {
      request_id: randomUUID(), conversation, message: "How did the round go?", focus: { primary: notice.subject },
    }, f.owner.token, "application/x-ndjson"));
    expect(follow.some(event => event.type === "notice")).toBe(false);
    expect(requests.at(-1)?.messages[0]?.content).toContain(report);

    const stranger = f.credential("other");
    const read = NoticeCommand.parse({ request_id: randomUUID(), op: "read", notices: [notice.id, notice.id] });
    const post = async (token: string) => f.api(listPath + "/commands", "POST", read, token);
    expect((await f.api(listPath, "GET", undefined, f.agent.token)).status).toBe(403);
    expect((await post(f.runtime.token)).status).toBe(403);
    expect(await f.list("", stranger.token)).toEqual({ notices: [], unread: 0 });
    expect(NoticeCommandResult.parse(await (await post(stranger.token)).json())).toEqual({ updated: [] });
    expect(NoticeCommandResult.parse(await (await post(f.owner.token)).json())).toEqual({ updated: [notice.id] });

    await f.restart();
    expect(NoticeCommandResult.parse(await (await post(f.owner.token)).json())).toEqual({ updated: [notice.id] });
    expect((await f.list("?unread=true")).notices).toEqual([]);
    expect((await f.list("?unread=false")).notices[0]?.read).toBeDefined();
    expect((await sent.submit()).status).toBe(200);
    await f.hub.modules.notices.drain();
    expect((await f.detail(subject.id)).comments.filter(comment => comment.author === f.hub.store.assistantActor().id)).toHaveLength(1);
    expect((await f.list()).notices).toHaveLength(1);
  } finally { release.resolve(); await f.close(); }
});

function jevAnswer(level: NoticeLevel, confidence = 0.94) {
  return Response.json({
    model: "jev-1.14.0", usage: { input_tokens: 12, output_tokens: 4 },
    answers: { notice_level: { type: "choice", choice: level, confidence,
      probabilities: Object.fromEntries(["important", "digest", "silent"].map(value => [value, value === level ? 0.9 : 0.05])) } },
  });
}

test("rules, capture and Watchdog use the durable notice pipeline with graded fallbacks and no source content sent to Jev", async () => {
  let level: NoticeLevel = "important", confidence = 0.94, rateLimited = false;
  const requests: { state: Record<string, unknown> }[] = [];
  const receiver = pushReceiver(), pushes: unknown[] = [];
  const f = await fixture({
    jevFetch: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return rateLimited ? new Response(null, { status: 429 }) : jevAnswer(level, confidence);
    },
    pushFetch: (async (_: string, init: RequestInit) => {
      pushes.push(receiver.decrypt(Buffer.from(init.body as Uint8Array)));
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch,
  });
  try {
    await f.bind();
    expect((await f.api("/v2/notifications/push/devices", "POST", receiver.subscription)).status).toBe(200);
    const captured = CaptureCreate.parse({
      request_id: randomUUID(), channel: "cli", title: "External title from a synthetic capture",
      content: { format: "text", body: "Synthetic source body that must stay out of Jev." },
    });
    const capture = CaptureCreateResult.parse(await (await f.api("/v2/inbox/captures", "POST", captured)).json()).capture;
    let ready = capture;
    for (let attempt = 0; attempt < 100 && ready.state !== "ready"; attempt++) {
      await Bun.sleep(15);
      ready = Capture.parse(await (await f.api("/v2/inbox/captures/" + capture.id)).json());
    }
    expect(ready.state).toBe("ready");
    await f.hub.modules.notices.drain();
    const initial = await f.list();
    expect(initial.notices[0]).toMatchObject({ source: "capture", level: "important", subject: { id: ready.entity?.id } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.state).toEqual({ event_kind: "capture", structured_summary: { status: "ready" } });
    await f.hub.modules.notifications.drain();
    expect(pushes).toEqual([{ title: "Important Lumio reminder", path: "#inbox" }]);

    const task = await f.task("Synthetic Watchdog task");
    const proposal = await f.command("work.task.dispatch", { task: task.id, to: "pi@server" }, f.agent.token);
    expect(proposal.kind).toBe("proposal");
    await f.hub.modules.notices.drain();
    expect((await f.list("?level=important")).notices.find(notice => notice.source === "proposal")).toMatchObject({ graded: { by: "rule" } });
    expect(requests).toHaveLength(1);

    const finding = { kind: "stale_task", subject: ResourceRef.parse({ module: "work", id: task.id }), since: task.created } as const;
    const hidden = { ...finding, subject: privateNote };
    level = "silent";
    f.hub.modules.notices.watchdog("synthetic-silent", [finding, hidden]);
    f.hub.modules.notices.watchdog("synthetic-silent", [finding, hidden]);
    await f.hub.modules.notices.drain();
    const silent = await f.list("?level=silent");
    expect(silent.notices).toHaveLength(1);
    expect(silent.notices[0]?.findings).toEqual([finding]);
    expect((await f.list()).notices.some(notice => notice.level === "silent")).toBe(false);
    expect(requests.at(-1)?.state).toEqual({ event_kind: "watchdog", structured_summary: { status: "report", count: 1 } });

    level = "important"; confidence = 0.55;
    f.hub.modules.notices.watchdog("synthetic-low-confidence", [finding]);
    await f.hub.modules.notices.drain();
    rateLimited = true;
    f.hub.modules.notices.watchdog("synthetic-rate-limit", [finding]);
    await f.hub.modules.notices.drain();
    expect((await f.list("?level=digest&unread=true")).notices.map(notice => notice.graded)).toEqual(expect.arrayContaining([
      { by: "fallback", reason: "low_confidence" }, { by: "fallback", reason: "error" },
    ]));
    expect((await f.api(listPath + "?unread=no")).status).toBe(400);
    expect((await f.api(listPath + "?limit=201")).status).toBe(400);
    expect((await f.api(listPath + "?level=other")).status).toBe(400);
  } finally { await f.close(); }
});

test("a round that leaves Work with an external holder gets digest classification using Hub task signals", async () => {
  const states: unknown[] = [];
  const f = await fixture({ jevFetch: async (_url, init) => {
    states.push(JSON.parse(String(init.body)).state);
    return jevAnswer("digest");
  } });
  try {
    const makeRound = async (title: string) => {
      const task = await f.task(title, { due: new Date(Date.now() + 2.5 * 86_400_000).toISOString() });
      await f.task("Synthetic dependent for " + title, { dependencies: [task.id] });
      const job = await f.dispatch(task.id);
      const assigned = await f.detail(task.id);
      await f.command("work.task.hand", { task: task.id, expected_revision: assigned.task.revision,
        to: "external", note: "Waiting on an external check" });
      const sent = await f.result(job, "Synthetic execution output that never enters Jev.");
      expect((await sent.submit()).status).toBe(200);
      await f.hub.modules.notices.drain();
      return task.id;
    };
    const unconfigured = await makeRound("Synthetic unconfigured task");
    expect((await f.list("?level=digest")).notices.find(notice => notice.subject?.id === unconfigured)).toMatchObject({
      graded: { by: "fallback", reason: "unconfigured" }, summary: "Synthetic execution output that never enters Jev.",
    });
    expect((await f.detail(unconfigured)).comments).toHaveLength(1);
    expect(states).toHaveLength(0);

    await f.bind();
    await f.ensure();
    const graded = await makeRound("Synthetic task with a due date");
    expect((await f.list("?level=digest")).notices.find(notice => notice.subject?.id === graded)).toMatchObject({
      level: "digest", graded: { by: "gate", model: "jev-1.14.0" },
    });
    expect(states).toEqual([{
      event_kind: "turn", subject_title: "Synthetic task with a due date",
      structured_summary: { status: "delivered", dependent_tasks: 1, days_until_due: 3 },
    }]);
    expect(f.hub.store.db.query("SELECT * FROM notification_events").all()).toHaveLength(0);
  } finally { await f.close(); }
});

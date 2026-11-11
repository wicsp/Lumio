import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIConnection, AIConnectionInput, CAPABILITIES, DECISION_GATE_DEFAULTS, DECISION_GATE_DISCLOSURE,
  DecisionGateBinding, DecisionGateBindingUpdate, NoticeGrader, TYPESAFE_JEV_BASE_URL,
} from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { buildDecisionGateRequest, DecisionGate, type NoticeDecisionInput, type ProgressDecisionInput } from "../src/decision-gate.ts";
import type { JevFetch } from "../src/jev.ts";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";

const path = "/v2/ai/decision-binding";
const key = "${secret:synthetic-jev}";
const model = "jev-1.14.1";
const notice: NoticeDecisionInput = {
  source: "hub", visibility: "public", event_kind: "turn", subject_title: "Synthetic task",
  structured_summary: { status: "delivered", count: 2 },
};
const progress: ProgressDecisionInput = {
  source: "hub", visibility: "public",
  structured_summary: {
    previous: { tool_calls: 3, files_changed: 0, error_kind: "command" },
    current: { tool_calls: 6, files_changed: 1 },
  },
};
const tokens = { input_tokens: 123, output_tokens: 7 };
const choice = {
  type: "choice", choice: "important", confidence: 0.92,
  probabilities: { important: 0.89, digest: 0.08, silent: 0.03 },
};
const result = (answers: unknown) => Response.json({ model, answers, usage: tokens });
const digest = (reason: Extract<NoticeGrader, { by: "fallback" }>["reason"]) =>
  ({ level: "digest", graded: { by: "fallback", reason } }) as const;

async function fixture(jevFetch: JevFetch = async () => { throw new Error("Unexpected inference"); }, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lumio-decision-gate-"));
  const store = await HubStore.open(dir);
  const actor = (name: string, role: "human" | "agent" | "runtime") => {
    const owner = store.createActor(name, role);
    return { owner: owner.id, token: store.createToken(name, name) };
  };
  const first = actor("synthetic-gate-owner", "human");
  const second = actor("synthetic-other-owner", "human");
  const agent = actor("synthetic-external-agent", "agent");
  const runtime = actor("synthetic-runtime", "runtime");
  store.close();

  const config = readConfig({ LUMIO_STATE_DIR: dir, LUMIO_HUB_LISTEN: "127.0.0.1:0", ...env });
  let hub: Awaited<ReturnType<typeof startHub>>;
  const start = () => startHub(config, { jevFetch, log: () => {} });
  try {
    hub = await start();
  } catch (cause) {
    await rm(dir, { recursive: true, force: true });
    throw cause;
  }
  const request = (url: string, method = "GET", body?: unknown, token = first.token) =>
    fetch(new URL(url, hub.server.url), {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const connection = async (kind: "typesafe-jev" | "openai-compatible" = "typesafe-jev") => {
    const response = await request("/v2/ai/connections", "POST", AIConnectionInput.parse({
      name: "Synthetic " + kind, host: "hub", kind, api_key: key,
      base_url: kind === "typesafe-jev" ? TYPESAFE_JEV_BASE_URL : "https://fixture.example.test/v1",
    }));
    expect(response.status).toBe(200);
    return AIConnection.parse(await response.json());
  };
  const update = (patch: Pick<DecisionGateBindingUpdate, "connection" | "model" | "expected_revision">, token?: string) =>
    request(path, "PUT", DecisionGateBindingUpdate.parse({ ...patch, request_id: crypto.randomUUID() }), token);
  const bind = async () => {
    const owned = await connection();
    const response = await update({ connection: owned.id });
    expect(response.status).toBe(200);
    return DecisionGateBinding.parse(await response.json());
  };
  return {
    get hub() { return hub; },
    ...first, second, agent, runtime, request, connection, update, bind,
    async restart() { await hub.stop(); hub = await start(); },
    async close() { await hub.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}

test("human decision binding uses the approved wire schemas, persists and scopes by owner", async () => {
  const f = await fixture();
  try {
    const initial = await f.request(path);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(DecisionGateBinding.nullable().parse(await initial.json())).toBeNull();
    const jev = await f.connection();
    const other = await f.connection("openai-compatible");
    expect((await f.update({ connection: other.id })).status).toBe(400);
    expect((await f.update({ connection: jev.id }, f.second.token)).status).toBe(404);
    for (const token of [f.agent.token, f.runtime.token]) {
      expect((await f.request(path, "GET", undefined, token)).status).toBe(403);
      expect((await f.update({ connection: jev.id }, token)).status).toBe(403);
    }
    expect(CAPABILITIES.some(capability => capability.name.includes("decision"))).toBe(false);

    const input = DecisionGateBindingUpdate.parse({ connection: jev.id, request_id: crypto.randomUUID() });
    const created = await f.request(path, "PUT", input);
    expect(created.status).toBe(200);
    const binding = DecisionGateBinding.parse(await created.json());
    expect(binding).toEqual({ purpose: "decision.gate", connection: jev.id, model: DECISION_GATE_DEFAULTS.model, revision: 1 });
    expect(DecisionGateBinding.parse(await (await f.request(path, "PUT", input)).json())).toEqual(binding);
    expect((await f.request(path, "PUT", { ...input, model })).status).toBe(409);
    expect((await f.request(path, "PUT", { ...input, model: "jev-latest" })).status).toBe(400);
    expect(DecisionGateBinding.nullable().parse(await (await f.request(path, "GET", undefined, f.second.token)).json())).toBeNull();

    await f.restart();
    expect(DecisionGateBinding.parse(await (await f.request(path)).json())).toEqual(binding);
    const deleteConnection = () => f.request("/v2/ai/connections/" + jev.id, "DELETE",
      { request_id: crypto.randomUUID(), expected_revision: jev.revision });
    expect((await deleteConnection()).status).toBe(409);
    const [left, right] = await Promise.all([
      f.update({ connection: jev.id, model, expected_revision: binding.revision }),
      f.update({ connection: jev.id, model, expected_revision: binding.revision }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const updated = DecisionGateBinding.parse(await (await f.request(path)).json());
    expect(updated).toMatchObject({ model, revision: 2 });

    const removed = await f.update({ connection: null, expected_revision: updated.revision });
    expect(removed.status).toBe(200);
    expect(DecisionGateBinding.nullable().parse(await removed.json())).toBeNull();
    const rebound = DecisionGateBinding.parse(await (await f.update({ connection: jev.id })).json());
    expect(rebound.revision).toBeGreaterThan(updated.revision);
    expect((await f.update({ connection: null, expected_revision: updated.revision })).status).toBe(409);
    await f.update({ connection: null, expected_revision: rebound.revision });
    expect((await deleteConnection()).status).toBe(200);
  } finally {
    await f.close();
  }
});

test("the gate sends only the disclosed fields and meters provider-reported model and usage", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const f = await fixture(async (url, init) => {
    requests.push({ url, init });
    return result({ notice_level: choice });
  });
  try {
    expect(await f.hub.modules.decisionGate.gradeNotice(f.owner, notice)).toEqual(digest("unconfigured"));
    const binding = await f.bind();
    const decision = await f.hub.modules.decisionGate.gradeNotice(f.owner, notice);
    expect(decision).toEqual({ level: "important", graded: { by: "gate", model, confidence: choice.confidence } });
    NoticeGrader.parse(decision.graded);
    expect(requests).toHaveLength(1);
    const { url, init } = requests[0]!;
    expect(url).toBe(TYPESAFE_JEV_BASE_URL + "/systemone");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer " + key);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(DECISION_GATE_DEFAULTS.model);
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(Object.keys(body.state).sort()).toEqual([...DECISION_GATE_DISCLOSURE].sort());
    expect(body.state).toEqual({
      event_kind: notice.event_kind, subject_title: notice.subject_title, structured_summary: notice.structured_summary,
    });
    expect(body.questions.notice_level).toMatchObject({ type: "choice", criteria: { important: expect.any(String),
      digest: expect.any(String), silent: expect.any(String) } });
    expect(String(init.body)).not.toContain(key);

    const usage = f.hub.store.db.query<{ execution_result: string; actor_id: string }, []>(
      "SELECT execution_result, actor_id FROM audit WHERE operation='decision.gate'",
    ).all();
    expect(usage).toHaveLength(1);
    expect(JSON.parse(usage[0]!.execution_result)).toEqual({ owner: f.owner, connection: binding.connection, model, ...tokens });
    expect(usage[0]!.actor_id).toBe(f.hub.store.decisionGateActor().id);
    expect(usage[0]!.execution_result).not.toContain(notice.subject_title!);
  } finally {
    await f.close();
  }
});

test("private, external and unstructured input never reaches the fetch adapter", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return result({ notice_level: choice }); });
  try {
    await f.bind();
    for (const input of [
      { ...notice, visibility: "private" },
      { ...notice, source: "external" },
      { ...notice, subject_title: "Synthetic\nexternal text" },
      { ...notice, structured_summary: "Copied provider text" },
      { ...notice, structured_summary: { ...notice.structured_summary, output: "Synthetic raw execution output" } },
      { ...notice, content: "Synthetic email body" },
      { ...notice, visibility: undefined },
    ]) {
      expect(buildDecisionGateRequest("notice", input)).toBeUndefined();
      expect(await f.hub.modules.decisionGate.gradeNotice(f.owner, input as NoticeDecisionInput)).toEqual(digest("error"));
    }
    for (const input of [
      { ...progress, visibility: "private" },
      { ...progress, source: "external" },
      { ...progress, structured_summary: { ...progress.structured_summary, current: { tool_calls: 2, files_changed: 0, error_kind: "copied error" } } },
      { ...progress, structured_summary: { ...progress.structured_summary, current: { tool_calls: 2, files_changed: 0, output: "raw log" } } },
    ]) {
      expect(await f.hub.modules.decisionGate.assessProgress(f.owner, input as ProgressDecisionInput)).toEqual({ by: "fallback", reason: "error" });
    }
    expect(calls).toBe(0);
  } finally {
    await f.close();
  }
});

test("HTTP failures and invalid answers fall back once; low-confidence and noul answers are interpreted", async () => {
  let next: () => Response = () => result({ notice_level: choice });
  let calls = 0;
  let body: unknown;
  const f = await fixture(async (_url, init) => {
    calls++;
    body = JSON.parse(String(init.body));
    return next();
  }, { LUMIO_DECISION_GATE_MIN_CONFIDENCE: "0.9" });
  try {
    await f.bind();
    for (const status of [401, 422, 429, 529, 302]) {
      next = () => new Response("Synthetic provider failure", { status });
      const before = calls;
      expect(await f.hub.modules.decisionGate.gradeNotice(f.owner, notice)).toEqual(digest("error"));
      expect(calls).toBe(before + 1);
    }
    for (const malformed of [
      () => new Response("{invalid-json"),
      () => Response.json({ model: "jev-latest", answers: { notice_level: choice }, usage: tokens }),
      () => result({ unrelated: choice }),
      () => result({ notice_level: { ...choice, choice: "unrecognized" } }),
      () => result({ notice_level: { ...choice, choice: "digest" } }),
      () => result({ notice_level: { ...choice, probabilities: { important: 0.99, silent: 0.02 } } }),
      () => result({ notice_level: { ...choice, confidence: -0.01 } }),
    ]) {
      next = malformed;
      expect(await f.hub.modules.decisionGate.gradeNotice(f.owner, notice)).toEqual(digest("error"));
    }
    next = () => result({ notice_level: { ...choice, confidence: 0.89 } });
    expect(await f.hub.modules.decisionGate.gradeNotice(f.owner, notice)).toEqual(digest("low_confidence"));
    for (const probability of [0.95, 0.05]) {
      next = () => result({ progress: { type: "noul", noul: probability } });
      expect(await f.hub.modules.decisionGate.assessProgress(f.owner, progress)).toEqual({
        by: "gate", model, made_progress: probability > 0.5, confidence: 0.95,
      });
      expect(body).toMatchObject({
        model: DECISION_GATE_DEFAULTS.model, state: { event_kind: "watchdog", structured_summary: progress.structured_summary },
        questions: { progress: { type: "noul" } },
      });
    }
    next = () => result({ progress: { type: "noul", noul: 0.55 } });
    expect(await f.hub.modules.decisionGate.assessProgress(f.owner, progress)).toEqual({ by: "fallback", reason: "low_confidence" });
  } finally {
    await f.close();
  }
});

test("the total deadline covers fetching and reading the response body", async () => {
  let hangAtHeaders = true;
  const signals: AbortSignal[] = [];
  const f = await fixture(async (_url, init) => {
    signals.push(init.signal!);
    if (hangAtHeaders) return new Promise<Response>(() => {});
    return new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener("abort", () => controller.close(), { once: true });
      controller.enqueue(new TextEncoder().encode("{"));
    } }));
  }, { LUMIO_DECISION_GATE_TIMEOUT_MS: "15" });
  try {
    await f.bind();
    expect(await f.hub.modules.decisionGate.gradeNotice(f.owner, notice)).toEqual(digest("timeout"));
    hangAtHeaders = false;
    expect(await f.hub.modules.decisionGate.gradeNotice(f.owner, notice)).toEqual(digest("timeout"));
    expect(signals.map(signal => signal.aborted)).toEqual([true, true]);
  } finally {
    await f.close();
  }
});

test("a response from an unbound connection is metered and falls back", async () => {
  const pending = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const f = await fixture(() => { started.resolve(); return pending.promise; });
  try {
    const binding = await f.bind();
    const decision = f.hub.modules.decisionGate.gradeNotice(f.owner, notice);
    await started.promise;
    expect((await f.update({ connection: null, expected_revision: binding.revision })).status).toBe(200);
    pending.resolve(result({ notice_level: choice }));
    expect(await decision).toEqual(digest("unconfigured"));
    expect(f.hub.store.db.query("SELECT 1 FROM audit WHERE operation='decision.gate'").all()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a metering failure returns the ordinary decision fallback", async () => {
  const f = await fixture();
  try {
    await f.bind();
    let metered = 0;
    const gate = new DecisionGate(f.hub.modules.ai.decisionGate, {
      signal: new AbortController().signal,
      fetch: async () => result({ notice_level: choice }),
      meter: () => { metered++; throw new Error("Synthetic storage failure"); },
    });
    expect(await gate.gradeNotice(f.owner, notice)).toEqual(digest("error"));
    expect(metered).toBe(1);
  } finally {
    await f.close();
  }
});

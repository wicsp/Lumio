import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalSummaryAnalysis, ApprovalSummaryRequest, ApprovalSummaryResult, Proposal } from "@lumio/schema";
import { AIConfigurationService } from "../src/ai-config.ts";
import { ApprovalSummaries } from "../src/approval-summary.ts";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";

const argv = ["/bin/sh", "-c", "ssh fixture-host 'cat \"/tmp/fixture file\"'"];
const analysis = ApprovalSummaryAnalysis.parse({
  intent: "Read a file on a remote machine.",
  access: "read",
  targets: ["fixture-host", "/tmp/fixture file"],
  network: "connection",
  recommendation: "caution",
  reason: "Verify the intended remote machine before approving.",
});
const runtime = "act_00000000000000000000000001";
const job = "job_00000000000000000000000001";
const cmd = (argv: string[]) => ({ op: "exec.privileged" as const, args: { runtime, job, argv } });
const pathFor = (id: string) => `/v2/approval/proposals/${id}/summary`;

test("command summary route is human-only, uses frozen arguments without tools, and caches by account, language and model revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lumio-approval-summary-"));
  let modelReply: unknown = analysis;
  let queuedCalls = 0;
  let hold: Promise<void> | undefined;
  let called = Promise.withResolvers<void>();
  const received: { route: string; body: Record<string, unknown> }[] = [];
  const modelGateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as Record<string, unknown>;
      received.push({ route: new URL(request.url).pathname, body });
      queuedCalls++;
      called.resolve();
      await hold;
      return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify(modelReply) }, finish_reason: "stop" }] });
    },
  });
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  try {
    const store = await HubStore.open(dir);
    const named = (name: string, role: "human" | "agent" | "runtime") => ({
      id: store.createActor(name, role).id, token: store.createToken(name, name),
    });
    const owner = named("fixture-owner", "human");
    const other = named("fixture-other", "human");
    const agent = named("fixture-agent", "agent");
    const runner = named("fixture-runner", "runtime");
    const service = new AIConfigurationService(store.aiStore);
    const connection = service.connection(owner.id, { name: "Fixture gateway", kind: "openai-compatible", host: "hub",
      base_url: new URL("/v1", modelGateway.url).href });
    const profileInput = { name: "Fixture small", connection: connection.id, engine: "lumio", model: "fixture-small" };
    const profile = service.profile(owner.id, profileInput);
    const proposal = store.createProposal(cmd(argv), "Fixture reason for human eyes only.", runner.id);
    const work = store.createProposal({
      op: "work.command", args: { request_id: "fixture-plan-request", operation: {
        op: "work.task.plan.set", args: { task: "task_00000000000000000000000001", expected_revision: 1, plan: null },
      } },
    }, "Fixture work approval", agent.id);
    const sensitive = [
      ["/bin/sh", "-c", "API_KEY=fixture-value some-command"],
      ["/bin/sh", "-c", "PGPASSWORD=fixture-value psql"],
      ["/usr/bin/curl", "-ufixture-user:fixture-password", "https://fixture.example.test"],
    ].map(args => store.createProposal(cmd(args), "Fixture", runner.id));
    const oversized = store.createProposal(cmd(["/bin/echo", "x".repeat(8192)]), "Fixture", runner.id);
    store.close();

    hub = await startHub(readConfig({ LUMIO_STATE_DIR: dir, LUMIO_HUB_LISTEN: "127.0.0.1:0", LUMIO_APPROVAL_SUMMARY_PROFILE: profile.id }), { log: () => {} });
    const request = (path: string, body?: unknown, token = owner.token, lang = "en") => fetch(new URL(path, hub!.server.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, "Accept-Language": lang, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const path = pathFor(proposal.id);
    const empty = { status: "empty", model: "fixture-small" } as const;
    const ready = { status: "ready", summary: { ...analysis, model: "fixture-small", privileged: true } } as const;
    const generate = ApprovalSummaryRequest.parse({});
    const refresh = ApprovalSummaryRequest.parse({ refresh: true });
    const initial = await request(path);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(ApprovalSummaryResult.parse(await initial.json())).toEqual(empty);
    expect(ApprovalSummaryResult.parse(await (await request(path, undefined, other.token)).json())).toEqual({ status: "disabled" });
    for (const token of [agent.token, runner.token]) {
      expect((await request(path, undefined, token)).status).toBe(403);
      expect((await request(path, generate, token)).status).toBe(403);
    }
    expect((await request(pathFor(work.id), generate)).status).toBe(404);
    expect((await request(path, { argv: ["/bin/echo", "forged"] })).status).toBe(400);
    for (const approval of sensitive) {
      expect(ApprovalSummaryResult.parse(await (await request(pathFor(approval.id), generate)).json())).toEqual({ status: "blocked", reason: "sensitive" });
    }
    expect(ApprovalSummaryResult.parse(await (await request(pathFor(oversized.id), generate)).json())).toEqual({ status: "blocked", reason: "too_large" });
    expect(queuedCalls).toBe(0);

    const unblock = Promise.withResolvers<void>();
    hold = unblock.promise;
    called = Promise.withResolvers<void>();
    const first = request(path, generate);
    await called.promise;
    const second = request(path, generate);
    try {
      expect(ApprovalSummaryResult.parse(await (await request(path)).json())).toEqual(empty);
      expect(Proposal.parse(await (await request(`/v2/approval/proposals/${proposal.id}/reject`, {})).json()).status).toBe("rejected");
    } finally { unblock.resolve(); }
    for (const response of await Promise.all([first, second])) {
      expect(ApprovalSummaryResult.parse(await response.json())).toEqual(ready);
    }
    expect(queuedCalls).toBe(1);
    expect(received[0]?.route).toBe("/v1/chat/completions");
    expect(received[0]?.body).toMatchObject({ model: "fixture-small", messages: [
      { role: "system", content: expect.stringContaining("untrusted data") },
      { role: "user", content: JSON.stringify(argv) },
    ] });
    expect(received[0]?.body).not.toHaveProperty("tools");
    expect(JSON.stringify(received[0]?.body)).not.toContain(proposal.reason);
    expect(ApprovalSummaryResult.parse(await (await request(path, generate)).json())).toEqual(ready);
    expect(queuedCalls).toBe(1);

    modelReply = { ...analysis, targets: ["inferred-host"] };
    expect(ApprovalSummaryResult.parse(await (await request(path, refresh)).json())).toEqual({
      status: "failed", model: "fixture-small", previous: ready.summary,
    });
    expect(ApprovalSummaryResult.parse(await (await request(path)).json())).toEqual(ready);
    modelReply = { ...analysis, intent: "Use --unknown to read the file." };
    expect(ApprovalSummaryResult.parse(await (await request(path, refresh)).json()).status).toBe("failed");
    modelReply = analysis;
    expect(ApprovalSummaryResult.parse(await (await request(path, refresh)).json())).toEqual(ready);
    expect(queuedCalls).toBe(4);

    expect(ApprovalSummaryResult.parse(await (await request(path, undefined, owner.token, "zh")).json())).toEqual(empty);
    expect(ApprovalSummaryResult.parse(await (await request(path, generate, owner.token, "zh")).json())).toEqual(ready);
    expect(JSON.stringify(received.at(-1)?.body)).toContain("in Chinese");
    hub.modules.ai.profile(owner.id, { ...profileInput, model: "fixture-small-new" }, profile.id);
    expect(ApprovalSummaryResult.parse(await (await request(path)).json())).toEqual({ status: "empty", model: "fixture-small-new" });
    expect(queuedCalls).toBe(5);
  } finally {
    await hub?.stop();
    await modelGateway.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("summary deadline releases the HTTP request and permits retry even if a model ignores cancellation", async () => {
  const created = "2026-11-21T10:00:00Z";
  const proposal = Proposal.parse({ id: "prop_00000000000000000000000001", operation: cmd(argv), author: runtime, reason: "Fixture", status: "pending", created });
  let calls = 0;
  let signal: AbortSignal | undefined;
  const dir = await mkdtemp(join(tmpdir(), "lumio-summary-deadline-"));
  const store = await HubStore.open(dir);
  try {
    const owner = store.createActor("fixture-owner", "human");
    const config = new AIConfigurationService(store.aiStore);
    const connection = config.connection(owner.id, { name: "Fixture", kind: "openai-compatible", host: "hub", base_url: "http://127.0.0.1:0" });
    const profile = config.profile(owner.id, { name: "Fixture", connection: connection.id, engine: "lumio", model: "fixture-small" });
    const previous = Promise.withResolvers<never>();
    const summaries = new ApprovalSummaries({
      get: config.get.bind(config),
      model: () => ({
        ...config.model(owner.id, profile.id),
        model: { async complete(_input, options) {
          calls++;
          if (calls === 1) { signal = options.signal; return previous.promise; }
          return { content: JSON.stringify(analysis), tool_calls: [] };
        } },
      }),
    }, profile.id, 10);
    const generate = () => summaries.handle(new Request(`http://fixture${pathFor(proposal.id)}`, { method: "POST", body: "{}" }),
      proposal.id, owner, { proposal: () => proposal }, "en");
    expect(ApprovalSummaryResult.parse(await (await generate()).json())).toEqual({ status: "failed", model: "fixture-small" });
    expect(signal?.aborted).toBe(true);
    expect(ApprovalSummaryResult.parse(await (await generate()).json()).status).toBe("ready");
    previous.reject(new Error("late model failure"));
    expect(calls).toBe(2);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { createClient } from "../src/index.ts";
import { AssistantConfigView, WorkAttention } from "@lumio/schema";
const U = "00000000000000000000000001";
const view = { base_url: "http://localhost/v1", model: "synthetic", api_key_set: true, managed: true };
const attention = [{ task: `task_${U}`, title: "Synthetic task", kind: "review" as const, job: `job_${U}`, round: 1, since: "2026-11-04T00:00:00Z" }];

test("R3 config, attention, tool history and undo use the endpoint methods and result contracts", async () => {
  const task = { schema_version: 2, type: "task", id: `task_${U}`, title: "Synthetic task", description: "", revision: 2, status: "todo", assignee: "human", tags: [], dependencies: [], references: [], created: "2026-11-04T00:00:00Z", updated: "2026-11-04T00:00:00Z" };
  const job = { spec: { id: `job_${U}`, protocol_version: 2, runtime: `act_${U}`, lease: "synthetic-job-lease", run: { kind: "command", argv: ["true"] }, workdir: "~", timeout_seconds: 60, created: "2026-11-04T00:00:00Z" }, status: "queued" };
  const cases: { path: string; method: string; result: unknown; body?: unknown; call(client: ReturnType<typeof createClient>): Promise<unknown> }[] = [
    { path: "/v2/execution/jobs", method: "GET", result: [], call: client => client.executionJobs({ task: undefined }) },
    { path: `/v2/execution/jobs/job_${U}`, method: "GET", result: job, call: client => client.executionJob(`job_${U}`) },
    { path: "/v2/assistant/config", method: "GET", result: view, call: (client: ReturnType<typeof createClient>) => client.assistantConfig() },
    { path: "/v2/assistant/config", method: "PUT", result: view, body: { base_url: view.base_url, model: view.model, api_key: "synthetic-private-key" }, call: (client: ReturnType<typeof createClient>) => client.updateAssistantConfig({ base_url: view.base_url, model: view.model, api_key: "synthetic-private-key" }) },
    { path: "/v2/assistant/config", method: "DELETE", result: { api_key_set: false, managed: true }, call: (client: ReturnType<typeof createClient>) => client.clearAssistantConfig() },
    { path: "/v2/work/attention", method: "GET", result: attention, call: (client: ReturnType<typeof createClient>) => client.workAttention() },
    { path: `/v2/assistant/conversations/conv_${U}/tools`, method: "GET", result: [], call: (client: ReturnType<typeof createClient>) => client.assistantTools(`conv_${U}`) },
    { path: `/v2/assistant/tools/tool_${U}/undo`, method: "POST", body: { request_id: "synthetic-undo-request" }, result: { kind: "task", task }, call: (client: ReturnType<typeof createClient>) => client.undoAssistantTool(`tool_${U}`, "synthetic-undo-request") },
  ];
  for (const item of cases) {
    const client = createClient({ url: "http://localhost", token: "synthetic", fetch: (async (url: URL, init?: RequestInit) => {
      expect(url.pathname).toBe(item.path); expect(init?.method).toBe(item.method);
      expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual("body" in item ? item.body : undefined);
      return Response.json(item.result);
    }) as unknown as typeof fetch });
    expect(await item.call(client)).toEqual(item.result);
  }
  expect(AssistantConfigView.parse(view)).toEqual(view); expect(WorkAttention.array().parse(attention)).toEqual(attention);
});

test("config validation rejects credential-bearing URLs and malformed views without echoing keys", async () => {
  const secret = "synthetic-private-key";
  const client = createClient({ url: "http://localhost", fetch: (async () => Response.json({ ...view, api_key: secret })) as unknown as typeof fetch });
  expect(() => client.updateAssistantConfig({ base_url: `http://user:${secret}@invalid`, model: "fake" })).toThrow();
  try { await client.assistantConfig(); throw new Error("expected failure"); }
  catch (cause) { expect(cause).toMatchObject({ code: "INTERNAL" }); expect(String(cause)).not.toContain(secret); }
});

test("agent management validates requests and responses and supports empty revoke responses", async () => {
  const actor = { id: `act_${U}`, name: "synthetic-agent", role: "agent" as const, created: "2026-11-04T00:00:00Z" };
  const issued = { actor, token: "lumio_" + "synthetic".repeat(6), label: "synthetic-label", created: actor.created };
  const seen: string[] = [];
  const client = createClient({ url: "http://localhost", token: "synthetic-human", fetch: (async (url: URL, init: RequestInit) => {
    seen.push(`${init.method} ${url.pathname}`);
    if (url.pathname.endsWith("/tokens")) { expect(JSON.parse(String(init.body))).toEqual({ name: actor.name, label: issued.label }); return Response.json(issued); }
    if (url.pathname.endsWith("/revoke")) { expect(JSON.parse(String(init.body))).toEqual({ name: actor.name, label: issued.label }); return new Response(null, { status: 204 }); }
    return Response.json([{ actor, tokens: [{ label: issued.label, created: actor.created, kind: "manual" }] }]);
  }) as unknown as typeof fetch });
  expect(await client.issueAgentToken({ name: actor.name, label: issued.label })).toEqual(issued);
  expect(JSON.stringify(await client.agents())).not.toContain(issued.token);
  expect(await client.revokeAgent({ name: actor.name, label: issued.label })).toBeUndefined();
  expect(seen).toEqual(["POST /v2/agents/tokens", "GET /v2/agents", "POST /v2/agents/revoke"]);
  expect(() => client.issueAgentToken({ name: actor.name, label: "../bad" })).toThrow();
});

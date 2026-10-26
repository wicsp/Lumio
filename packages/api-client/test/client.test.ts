import { expect, test } from "bun:test";
import { ApiError, CheckResult, LinksResult, NoteDetail, SearchResult } from "@lumio/schema";
import { ApiClientError, createClient } from "../src/index.ts";

const note = { type: "idea", title: "中文 / #", path: "research/ideas/test.md" } as const;
function mock(body: unknown, status = 200, inspect?: (url: URL, init: RequestInit | undefined) => void): typeof fetch {
  return (async (url: URL, init?: RequestInit) => { inspect?.(url, init); return Response.json(body, { status }); }) as typeof fetch;
}

test("client encodes references/options and validates all success schemas", async () => {
  const cases = [
    { method: "search" as const, argument: "中文 &", body: { query: "中文 &", hits: [], total: 0 }, schema: SearchResult },
    { method: "show" as const, argument: "中文 / #", body: { note, frontmatter: {}, body: "text" }, schema: NoteDetail },
    { method: "links" as const, argument: "中文 / #", body: { note, outgoing: [], incoming: [] }, schema: LinksResult },
  ];
  for (const row of cases) {
    const client = createClient({ url: "http://localhost:7420/", token: "synthetic-token", fetch: mock(row.body, 200, (url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token"); expect(init?.redirect).toBe("error");
      expect(url.searchParams.get("include_private")).toBe("true");
      if (row.method === "search") { expect(url.searchParams.get("q")).toBe(row.argument); expect(url.searchParams.get("type")).toBe("idea"); expect(url.searchParams.get("limit")).toBe("2"); }
      else expect(url.pathname).toBe(`/v1/notes/${encodeURIComponent(row.argument)}${row.method === "links" ? "/links" : ""}`);
    }) });
    const result = await client[row.method](row.argument, { includePrivate: true, type: "idea", limit: 2 });
    expect(result).toEqual(row.schema.parse(row.body));
  }
});

test("ApiError becomes a coded error preserving all decision information", async () => {
  const error = ApiError.parse({ error: { code: "FORBIDDEN", message: "Denied", operation: { op: "task.dispatch", args: { task: "task_00000000000000000000000012", trigger: "cli" } }, reason: "agent-cannot-read-private", proposal: "prop_00000000000000000000000001" } });
  const client = createClient({ url: "http://localhost", token: "secret", fetch: mock(error, 403) });
  try { await client.show("Private"); throw new Error("Expected failure"); }
  catch (cause) {
    expect(cause).toBeInstanceOf(ApiClientError);
    expect(cause).toMatchObject({ ...error.error, status: 403 });
  }
});

test("malformed success/error/non-JSON/network responses never escape validation or expose sensitive content", async () => {
  for (const fetcher of [mock({ token: "private-response" }), mock({ error: { code: "unknown", message: "private-response" } }, 500),
    (async () => new Response("private-response")) as unknown as typeof fetch,
    (async () => { throw new Error("private-response secret-token"); }) as unknown as typeof fetch]) {
    const client = createClient({ url: "http://localhost", token: "secret-token", fetch: fetcher });
    for (const method of ["search", "show", "links"] as const) {
      try { await client[method]("ref"); throw new Error("Expected failure"); }
      catch (cause) { expect(cause).toBeInstanceOf(ApiClientError); expect((cause as ApiClientError).code).toBe("INTERNAL"); expect(String(cause)).not.toContain("private-response"); expect(String(cause)).not.toContain("secret-token"); }
    }
  }
});

const operation = { op: "task.dispatch", args: { task: "task_00000000000000000000000012", trigger: "cli" } } as const;
const proposal = { id: "prop_00000000000000000000000001", operation, reason: "Dispatch please", author: "act_00000000000000000000000001", status: "pending", created: "2026-01-01T00:00:00Z" } as const;

test("check encodes visibility, validates CheckResult and propagates authorization errors", async () => {
  const body = CheckResult.parse({ dangling: [{ from: note, source: "wikilink", target: "Missing" }], total: 1 });
  const client = createClient({ url: "http://localhost/", token: "synthetic-token", fetch: mock(body, 200, (url, init) => {
    expect(url.pathname).toBe("/v1/check"); expect(url.searchParams.get("include_private")).toBe("true");
    expect(init?.method).toBe("GET"); expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
  }) });
  expect(await client.check({ includePrivate: true })).toEqual(body);
  const defaultClient = createClient({ url: "http://localhost", token: "token", fetch: mock(body, 200, (url) => expect(url.search).toBe("")) });
  expect(await defaultClient.check()).toEqual(body);
  const invalid = createClient({ url: "http://localhost", token: "token", fetch: mock({ dangling: [], total: 0, extra: "private" }) });
  await expect(invalid.check()).rejects.toMatchObject({ code: "INTERNAL" });
  const denied = createClient({ url: "http://localhost", token: "token", fetch: mock({ error: { code: "FORBIDDEN", message: "Denied", reason: "agent-cannot-read-private" } }, 403) });
  await expect(denied.check({ includePrivate: true })).rejects.toMatchObject({ code: "FORBIDDEN", reason: "agent-cannot-read-private", status: 403 });
});

test("operation/proposal/actors methods use their endpoints, methods, request bodies and success schemas", async () => {
  const cases = [
    { path: "/v1/runtimes", body: [{ actor: proposal.author, registration: { protocol_version: 2, name: "server", engines: [], tags: [], max_concurrent: 1 }, last_seen: proposal.created, online: true }], call: (client: ReturnType<typeof createClient>) => client.runtimes() },
    { path: "/v1/actors", body: [{ id: proposal.author, name: "codex", role: "agent", created: proposal.created }], call: (client: ReturnType<typeof createClient>) => client.actors() },
    { path: "/v1/proposals?status=pending", body: [proposal], call: (client: ReturnType<typeof createClient>) => client.proposals() },
    { path: "/v1/proposals?status=rejected", body: [{ ...proposal, status: "rejected" }], call: (client: ReturnType<typeof createClient>) => client.proposals("rejected") },
    { path: "/v1/operations", body: { status: "pending_approval", proposal }, payload: { operation, reason: proposal.reason }, status: 202, call: (client: ReturnType<typeof createClient>) => client.operation({ operation, reason: proposal.reason }) },
    { path: "/v1/operations", body: { status: "applied", operation }, payload: { operation }, call: (client: ReturnType<typeof createClient>) => client.operation({ operation }) },
    { path: `/v1/proposals/${proposal.id}/accept`, body: { ...proposal, status: "accepted" }, payload: {}, call: (client: ReturnType<typeof createClient>) => client.acceptProposal(proposal.id) },
    { path: `/v1/proposals/${proposal.id}/reject`, body: { ...proposal, status: "rejected" }, payload: {}, call: (client: ReturnType<typeof createClient>) => client.rejectProposal(proposal.id) },
  ];
  for (const row of cases) {
    const client = createClient({ url: "http://localhost", token: "synthetic-token", fetch: mock(row.body, "status" in row ? row.status : 200, (url, init) => {
      expect(url.pathname + url.search).toBe(row.path);
      const post = "payload" in row;
      expect(init?.method).toBe(post ? "POST" : "GET");
      expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(post ? row.payload : undefined);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
    }) });
    expect(await row.call(client) as unknown).toEqual(row.body);
    const invalid = createClient({ url: "http://localhost", token: "synthetic-token", fetch: mock({ private: "secret-response" }) });
    await expect(row.call(invalid)).rejects.toMatchObject({ code: "INTERNAL" });
    const denied = createClient({ url: "http://localhost", token: "synthetic-token", fetch: mock({ error: { code: "FORBIDDEN", message: "Denied", operation, reason: "agent-cannot-decide-proposals", proposal: proposal.id } }, 403) });
    await expect(row.call(denied)).rejects.toMatchObject({ code: "FORBIDDEN", operation, reason: "agent-cannot-decide-proposals", proposal: proposal.id });
  }
});

test("job client validates request defaults, Job output and errors at all four endpoints", async () => {
  const { Job } = await import("@lumio/schema");
  const job = Job.parse({ spec: { protocol_version: 2, id: "job_00000000000000000000000001", runtime: "act_00000000000000000000000001", lease: "synthetic_lease_123456", run: { kind: "command", argv: ["/bin/echo"] }, workdir: "~", timeout_seconds: 7200, created: "2026-01-01T00:00:00Z" }, status: "queued" });
  const cases = [
    { path: "/v1/jobs", payload: { runtime: "server", run: job.spec.run, workdir: "~", timeout_seconds: 7200 }, body: job, call: (c: ReturnType<typeof createClient>) => c.submitJob({ runtime: "server", run: { kind: "command", argv: ["/bin/echo"] } }) },
    { path: "/v1/jobs?status=queued", body: [job], call: (c: ReturnType<typeof createClient>) => c.jobs("queued") },
    { path: `/v1/jobs/${job.spec.id}`, body: job, call: (c: ReturnType<typeof createClient>) => c.job(job.spec.id) },
    { path: `/v1/jobs/${job.spec.id}/cancel`, payload: {}, body: job, call: (c: ReturnType<typeof createClient>) => c.cancelJob(job.spec.id) },
  ];
  for (const row of cases) {
    const client = createClient({ url: "http://localhost", token: "synthetic", fetch: mock(row.body, 200, (url, init) => {
      expect(url.pathname + url.search).toBe(row.path); expect(init!.method).toBe("payload" in row ? "POST" : "GET");
      expect(init!.body ? JSON.parse(String(init!.body)) : undefined).toEqual("payload" in row ? row.payload : undefined);
    }) });
    expect(await row.call(client)).toEqual(row.body);
    await expect(row.call(createClient({ url: "http://localhost", token: "synthetic", fetch: mock({ bad: true }) }))).rejects.toMatchObject({ code: "INTERNAL" });
    await expect(row.call(createClient({ url: "http://localhost", token: "synthetic", fetch: mock({ error: { code: "FORBIDDEN", message: "Denied" } }, 403) }))).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  }
  const client = createClient({ url: "http://localhost", token: "synthetic", fetch: mock(job, 200, () => { throw new Error("must not send invalid input"); }) });
  await expect(Promise.resolve().then(() => client.submitJob({ runtime: "Bad Name", run: { kind: "command", argv: [] } }))).rejects.toMatchObject({ code: "INVALID" });
  await expect(Promise.resolve().then(() => client.job("bad"))).rejects.toMatchObject({ code: "INVALID" });
});

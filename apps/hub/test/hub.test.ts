import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Actor, ApiError, LinksResult, NoteDetail, SearchResult, Timestamp, type ApiErrorCode } from "@lumio/schema";
import { AUTHORIZATION_RULES, authorize, type AuthorizationRequest } from "../src/authorize.ts";
import { readConfig } from "../src/config.ts";
import { ROUTES, startHub } from "../src/server.ts";
import type { HubStatus } from "../src/watch.ts";
import { HubStore } from "../src/store.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/query-vault", import.meta.url));
const cliMain = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
const hubMain = fileURLToPath(new URL("../src/main.ts", import.meta.url));
let temp: string, vault: string, state: string;
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let human: string, human2: string, agent: string, revoked: string;
let logs: string[], decisions: AuthorizationRequest[];
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-hub-")); vault = join(temp, "vault"); state = join(temp, "state");
  await cp(fixture, vault, { recursive: true }); logs = []; decisions = [];
  const store = await HubStore.open(state);
  store.createActor("owner", "human"); store.createActor("codex", "agent");
  human = store.createToken("mac", "owner"); human2 = store.createToken("ipad", "owner");
  agent = store.createToken("codex-mac", "codex"); revoked = store.createToken("old", "owner"); store.revokeToken("old");
  store.close();
  const config = readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state });
  hub = await startHub({ ...config, port: 0 }, { log: (line) => logs.push(line), authorize(actor, request) {
    decisions.push(request); return authorize(actor, request);
  } });
  logs.length = 0;
});
afterEach(async () => { await hub?.stop(); hub = undefined; await rm(temp, { recursive: true, force: true }); });
const base = () => `http://127.0.0.1:${hub!.server.port}`;
function request(path: string, token?: string, headers: Record<string, string> = {}, method = "GET") {
  return fetch(`${base()}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
}
async function error(path: string, token: string | undefined, status: number, code: ApiErrorCode) {
  const response = await request(path, token); expect(response.status).toBe(status);
  const body = ApiError.parse(await response.json()); expect(body.error.code).toBe(code); return body.error;
}

test("default binding is loopback; public health and every registered route call authorize", async () => {
  expect(readConfig({ LUMIO_VAULT: vault }).hostname).toBe("127.0.0.1");
  expect(readConfig({ LUMIO_VAULT: vault }).port).toBe(7420);
  expect(hub!.server.hostname).toBe("127.0.0.1");
  const first = hub!.store.createProposal({ op: "link.add", args: { from: "idea_00000000000000000000000004", to: "idea_00000000000000000000000015" } }, "fixture", hub!.store.actors()[0]!.id);
  const second = hub!.store.createProposal({ op: "link.add", args: { from: "idea_00000000000000000000000015", to: "idea_00000000000000000000000004" } }, "fixture", hub!.store.actors()[0]!.id);
  const paths = { actors: "/v1/actors", proposals: "/v1/proposals", operations: "/v1/operations", "proposal.accept": `/v1/proposals/${first.id}/accept`, "proposal.reject": `/v1/proposals/${second.id}/reject`, status: "/v1/status", health: "/health", search: "/v1/search?q=index", show: "/v1/notes/Main", links: "/v1/notes/Main/links" };
  for (const route of ROUTES) {
    const response = route.operation === "operations"
      ? await fetch(`${base()}/v1/operations`, { method: "POST", headers: { Authorization: `Bearer ${human}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation: { op: "link.add", args: { from: "idea_00000000000000000000000015", to: "pap_00000000000000000000000001" } } }) })
      : await request(paths[route.operation], route.operation === "health" ? undefined : human, {}, "method" in route ? route.method : "GET");
    expect(response.status).toBe(200);
    if (route.operation === "health") expect(await response.json()).toEqual({ ok: true, version: "0.0.0" });
    expect(decisions.at(-1)?.operation).toBe(route.operation === "operations" ? "link.add" : route.operation);
  }
  expect(decisions).toHaveLength(ROUTES.length);
});

test("authentication is required everywhere except health, including unknown routes", async () => {
  for (const path of ["/v1/search?q=index", "/v1/notes/Main", "/v1/notes/Main/links", "/missing"]) {
    for (const token of [undefined, "wrong", `lumio_${"x".repeat(43)}`, revoked]) await error(path, token, 401, "UNAUTHENTICATED");
  }
  const invalid = await fetch(`${base()}/v1/search?q=index`, { headers: { Authorization: `Basic ${human}` } });
  expect(invalid.status).toBe(401); ApiError.parse(await invalid.json());
  await error("/missing", human, 404, "NOT_FOUND");
  const post = await request("/health", undefined, {}, "POST");
  expect(post.status).toBe(401); ApiError.parse(await post.json());
});

test("query endpoints validate against schemas and URL-encoded Unicode references work", async () => {
  const search = SearchResult.parse(await (await request("/v1/search?q=index&type=paper&limit=1", human)).json());
  expect(search.hits).toHaveLength(1); expect(search.hits[0]!.note.type).toBe("paper");
  NoteDetail.parse(await (await request("/v1/notes/Main", human)).json());
  LinksResult.parse(await (await request("/v1/notes/Main/links", human)).json());
  expect(NoteDetail.parse(await (await request(`/v1/notes/${encodeURIComponent("来源笔记")}`, human)).json()).note.type).toBe("source");
  const noId = NoteDetail.parse(await (await request("/v1/notes/NoID", human)).json()); expect("id" in noId.note).toBe(true);
  expect(SearchResult.parse(await (await request("/v1/search?q=cardonlymarker", human)).json()).total).toBe(0);
  await error("/v1/notes/Card", human, 404, "NOT_FOUND");
});

test("private notes are hidden from agents, and only explicit human requests reveal them", async () => {
  for (const token of [human, agent]) {
    expect(SearchResult.parse(await (await request("/v1/search?q=privateonly", token)).json()).total).toBe(0);
    for (const suffix of ["", "/links"]) await error(`/v1/notes/Private${suffix}`, token, 404, "NOT_FOUND");
    const links = LinksResult.parse(await (await request("/v1/notes/Main/links", token)).json());
    expect(links.outgoing.find((l) => l.target === "Private")?.dangling).toBe(true);
  }
  for (const path of ["/v1/search?q=privateonly", "/v1/notes/Private", "/v1/notes/Private/links"]) {
    expect((await error(`${path}${path.includes("?") ? "&" : "?"}include_private=true`, agent, 403, "FORBIDDEN")).reason).toBe("agent-cannot-read-private");
  }
  expect(SearchResult.parse(await (await request("/v1/search?q=privateonly&include_private=true", human)).json()).total).toBe(1);
  NoteDetail.parse(await (await request("/v1/notes/Private?include_private=true", human)).json());
  LinksResult.parse(await (await request("/v1/notes/Private/links?include_private=true", human)).json());
  expect(hub!.store.db.query("SELECT * FROM audit").all()).toHaveLength(3);
  expect(hub!.store.db.query<{ operation: string }, []>("SELECT * FROM audit").all().map((r) => r.operation)).toEqual(["search", "show", "links"]);
});

test("all invalid inputs return ApiError and ambiguous references are INVALID with candidates", async () => {
  for (const path of ["/v1/search", "/v1/search?q=%20", "/v1/search?q=x&type=bad", "/v1/search?q=x&limit=0",
    "/v1/search?q=x&limit=1.5", "/v1/search?q=x&limit=9007199254740992", "/v1/notes/%ZZ", "/v1/notes/Main?include_private=yes"]) {
    await error(path, human, 400, "INVALID");
  }
  const ambiguous = await error("/v1/notes/Twin", human, 400, "INVALID");
  expect(ambiguous.message).toContain("library/sources/b/Twin.md");
  expect(ambiguous.message).toContain("research/ideas/a/Twin.md");
});

test("one actor can use two tokens, revoking one is persistent and leaves the other working", async () => {
  for (const token of [human, human2]) expect((await request("/v1/notes/Main", token)).status).toBe(200);
  hub!.store.revokeToken("mac"); await error("/v1/notes/Main", human, 401, "UNAUTHENTICATED");
  expect((await request("/v1/notes/Main", human2)).status).toBe(200);
  await hub!.stop(); hub = undefined;
  const reopened = await HubStore.open(state);
  try {
    expect(reopened.authenticate(`Bearer ${human}`)).toBeNull();
    expect(reopened.authenticate(`Bearer ${human2}`)?.actor.name).toBe("owner");
    const stored = JSON.stringify(reopened.db.query("SELECT * FROM tokens").all());
    expect(stored).not.toContain(human); expect(stored).not.toContain(human2);
    expect(reopened.tokens().every((row) => !("role" in row) && !("hash" in row))).toBe(true);
  } finally { reopened.close(); }
});

test("logs omit tokens and query contents, ignore untrusted forwarding; denials are audited without secrets", async () => {
  await request(`/v1/search?q=${agent}&include_private=true`, agent, { "X-Forwarded-For": "203.0.113.4" });
  await request(`/v1/notes/${human}`, human);
  await request(`/unknown/${human}`, human);
  expect(logs).toHaveLength(3);
  const line = JSON.parse(logs[0]!);
  expect(line.client_ip).toBe("127.0.0.1"); expect(line.path).toBe("/v1/search"); expect(line.status).toBe(403);
  expect(line.token_label).toBe("codex-mac"); expect(line.actor_id).toBe(hub!.store.actors().find((a) => a.name === "codex")!.id);
  Timestamp.parse(line.time); expect(line.duration_ms).toBeGreaterThanOrEqual(0);
  const records = hub!.store.db.query("SELECT * FROM audit").all(); expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ actor_id: line.actor_id, token_label: "codex-mac", operation: "search", authorization: "deny", proposal_id: null, execution_result: null });
  for (const token of [human, human2, agent, revoked]) expect(logs.join("\n") + JSON.stringify(records)).not.toContain(token);
  expect(logs.join("\n")).not.toContain("203.0.113.4");
});

test("only configured proxy can supply a valid forwarded IP", async () => {
  await hub!.stop();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state, LUMIO_TRUSTED_PROXY: "127.0.0.1" }), port: 0 }, { log: (line) => logs.push(line) });
  await request("/health", undefined, { "X-Forwarded-For": "203.0.113.4, 127.0.0.1" });
  expect(JSON.parse(logs.at(-1)!).client_ip).toBe("203.0.113.4");
  await request("/health", undefined, { "X-Forwarded-For": "garbage" });
  expect(JSON.parse(logs.at(-1)!).client_ip).toBe("127.0.0.1");
});

test("authorization table is exhaustively checked, including private=false", () => {
  expect(AUTHORIZATION_RULES).toHaveLength(27);
  for (const rule of AUTHORIZATION_RULES) {
    const actor = rule.role === null ? null : Actor.parse({ id: "act_00000000000000000000000001", name: "test", role: rule.role, created: "2026-01-01T00:00:00Z" });
    const decision = authorize(actor, { operation: rule.operation, includePrivate: rule.includePrivate });
    expect(decision).toEqual(rule.decision);
    const expected = rule.role !== "agent" ? "allow" : rule.operation === "link.add" ? "needs_approval"
      : rule.includePrivate || rule.operation.startsWith("proposal.") ? "deny" : "allow";
    expect(decision.result).toBe(expected);
  }
  expect(authorize(null, { operation: "search" }).result).toBe("deny");
});

async function spawnCli(args: string[], remote: boolean, extraEnv: Record<string, string | undefined> = {}) {
  const process = Bun.spawn([Bun.which("bun")!, cliMain, ...args], { env: { ...globalThis.process.env,
    LUMIO_VAULT: remote ? undefined : vault, LUMIO_STATE_DIR: join(temp, "cli-state"),
    LUMIO_HUB_URL: remote ? base() : undefined, LUMIO_TOKEN: remote ? human : undefined, ...extraEnv,
  }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { stdout, stderr, code };
}

test("CLI local and remote JSON are byte-identical for all three commands on the same fixture vault", async () => {
  for (const args of [["search", "index", "--type", "paper", "--limit", "2"], ["search", "无标识"], ["show", "Main"],
    ["show", "来源笔记"], ["links", "Main"], ["show", "Private", "--include-private"], ["links", "Main", "--include-private"]]) {
    const local = await spawnCli([...args, "--json"], false); const remote = await spawnCli([...args, "--json"], true);
    expect(local.code).toBe(0); expect(remote.code).toBe(0); expect(local.stderr + remote.stderr).toBe("");
    expect(remote.stdout).toBe(local.stdout);
  }
  for (const args of [["search", "index"], ["show", "Main"], ["links", "Main"]]) expect((await spawnCli(args, true)).code).toBe(0);
  for (const extraEnv of [{ LUMIO_TOKEN: undefined }, { LUMIO_HUB_URL: undefined }]) {
    const result = await spawnCli(["search", "index", "--json"], true, extraEnv);
    expect(result.code).toBe(1); expect(result.stderr).toContain("LUMIO_HUB_URL"); expect(result.stderr).toContain("LUMIO_TOKEN"); expect(result.stdout).toBe("");
  }
});

test("management commands create/list/revoke with only a temporary state directory and never reprint tokens", async () => {
  const env = { ...process.env, LUMIO_VAULT: undefined, LUMIO_STATE_DIR: join(temp, "management") };
  function management(args: string[]) {
    const result = Bun.spawnSync([process.execPath, hubMain, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }
  expect(Actor.parse(JSON.parse(management(["actor", "create", "owner", "--role", "human"]).stdout)).role).toBe("human");
  expect(management(["actor", "create", "owner", "--role", "human"]).code).toBe(1);
  expect(management(["actor", "create", "invalid name", "--role", "human"]).code).toBe(1);
  const created = management(["token", "create", "mac", "--actor", "owner"]);
  expect(created.code).toBe(0); expect(created.stderr).toBe(""); expect(created.stdout.trim()).toMatch(/^lumio_[A-Za-z0-9_-]{43}$/);
  expect(JSON.parse(management(["actor", "list"]).stdout)).toHaveLength(1);
  const listed = management(["token", "list"]); expect(listed.stdout).not.toContain(created.stdout.trim()); expect(listed.stdout).not.toContain("hash");
  expect(management(["token", "revoke", "mac"]).code).toBe(0);
  expect(JSON.parse(management(["token", "list"]).stdout)[0].revoked).not.toBeNull();
  for (const args of [["actor", "create", "missing-role"], ["token", "create", "missing-actor"], ["token", "revoke", "missing"], ["unknown"]]) expect(management(args).code).toBe(1);
  expect(await readFile(join(temp, "management", "hub.sqlite"), "utf8")).not.toContain(created.stdout.trim());
});

test("config rejects missing vault, malformed listen and non-IP proxy", () => {
  for (const env of [{}, { LUMIO_VAULT: vault, LUMIO_HUB_LISTEN: "https://host:42" }, { LUMIO_VAULT: vault, LUMIO_HUB_LISTEN: "host:99999" }, { LUMIO_VAULT: vault, LUMIO_TRUSTED_PROXY: "proxy.example" }]) expect(() => readConfig(env)).toThrow();
});


test("every route obeys a denial from the shared authorization entry point", async () => {
  await hub!.stop();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state }), port: 0 }, {
    log: (line) => logs.push(line), authorize: () => ({ result: "deny", reason: "Test denial" }),
  });
  for (const path of ["/health", "/v1/search?q=index", "/v1/notes/Main", "/v1/notes/Main/links"]) {
    expect((await error(path, human, 403, "FORBIDDEN")).reason).toBe("Test denial");
  }
});

test("internal query failures return a validated, sanitized INTERNAL response", async () => {
  await rename(vault, `${vault}-saved`);
  await writeFile(vault, "synthetic inaccessible vault");
  const failure = await error("/v1/notes/Main", human, 500, "INTERNAL");
  expect(failure.message).not.toContain(temp);
});

test("status is authenticated, shares private authorization, and CLI prints its JSON", async () => {
  await error("/v1/status", undefined, 401, "UNAUTHENTICATED");
  const response = await request("/v1/status", human);
  expect(response.status).toBe(200);
  const status = await response.json() as HubStatus;
  expect(status).toMatchObject({ watching: true, pending_files: 0 }); Timestamp.parse(status.last_full_sync);
  expect(Array.isArray(status.issues)).toBe(true);
  expect(JSON.stringify(status)).not.toContain("life/assets");
  expect((await request("/v1/status", agent)).status).toBe(200);
  expect((await error("/v1/status?include_private=true", agent, 403, "FORBIDDEN")).reason).toBe("agent-cannot-read-private");
  await error("/v1/status?include_private=invalid", human, 400, "INVALID");
  const cli = await spawnCli(["hub", "status"], true);
  expect(cli.code).toBe(0); expect(cli.stderr).toBe(""); expect(JSON.parse(cli.stdout)).toEqual(status);
  for (const remote of [false, true]) {
    const missing = await spawnCli(["hub", "status"], remote, { LUMIO_TOKEN: undefined });
    expect(missing.code).toBe(1); expect(missing.stderr).toContain("LUMIO_HUB_URL"); expect(missing.stdout).toBe("");
  }
  const denied = await spawnCli(["hub", "status"], true, { LUMIO_TOKEN: "invalid" });
  expect(denied.code).toBe(1); expect(denied.stderr).toContain("401");
  const extra = await spawnCli(["hub", "status", "--dry-run"], true); expect(extra.code).toBe(1);
});

test("autosave idle defaults to 300 seconds and rejects invalid timer values", () => {
  expect(readConfig({ LUMIO_VAULT: vault }).autosaveIdle).toBe(300);
  expect(readConfig({ LUMIO_VAULT: vault, LUMIO_AUTOSAVE_IDLE: "10" }).autosaveIdle).toBe(10);
  for (const value of ["", "0", "-1", "invalid", "Infinity", "2147484"]) {
    expect(() => readConfig({ LUMIO_VAULT: vault, LUMIO_AUTOSAVE_IDLE: value })).toThrow("LUMIO_AUTOSAVE_IDLE");
  }
});

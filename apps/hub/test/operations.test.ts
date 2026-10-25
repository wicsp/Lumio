import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { FSWatcher, watch } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter } from "@lumio/core";
import { Actor, ApiError, LinksResult, OperationResult, Proposal, type Operation } from "@lumio/schema";
import { HubStore } from "../src/store.ts";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import type { WatchClock } from "../src/watch.ts";

const literal = "idea_00000000000000000000000015", main = "idea_00000000000000000000000004", paper = "pap_00000000000000000000000002";
const privateId = "ast_00000000000000000000000007";
const operation: Operation = { op: "link.add", args: { from: literal, to: paper } };
const relative = "research/ideas/Literal.md";
class Clock implements WatchClock {
  time = Date.now(); sequence = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  set = (callback: () => void, delay: number) => { const id = ++this.sequence; this.timers.set(id, { at: this.time + delay, callback }); return id; };
  clear = (id: unknown) => { this.timers.delete(id as number); };
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.time && this.timers.delete(id)) timer.callback();
  }
}
let temp: string, vault: string, state: string, human: string, agent: string, other: string, owner: Actor, author: Actor, clock: Clock;
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let beforeCommit: (() => Promise<void>) | undefined;
let notify: (path: string) => void;
let processed: number;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-operations-")); vault = join(temp, "vault"); state = join(temp, "state");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url), vault, { recursive: true });
  const store = await HubStore.open(state);
  owner = store.createActor("owner", "human"); author = store.createActor("codex", "agent"); store.createActor("other", "agent");
  human = store.createToken("owner-mac", "owner"); agent = store.createToken("codex-mac", "codex"); other = store.createToken("other-mac", "other"); store.close();
  clock = new Clock(); beforeCommit = undefined; processed = 0;
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state }), port: 0, autosaveIdle: 10 }, {
    log() {}, operations: { beforeCommit: () => beforeCommit?.() },
    watch: { clock, onProcess: () => { processed++; }, watch: ((_path, _opts, callback) => {
      notify = (path) => (callback as (event: string, path: string) => void)("change", path);
      return Object.assign(new EventEmitter(), { close() {} }) as FSWatcher;
    }) as typeof watch },
  });
});
afterEach(async () => { await hub?.stop(); hub = undefined; await rm(temp, { recursive: true, force: true }); });
const base = () => `http://127.0.0.1:${hub!.server.port}`;
function request(path: string, token = human, body?: unknown) {
  return fetch(`${base()}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function propose(op = operation, token = agent) {
  const response = await request("/v1/operations", token, { operation: op, reason: "连接两篇相关笔记" });
  expect(response.status).toBe(202);
  const result = OperationResult.parse(await response.json());
  if (result.status !== "pending_approval") throw new Error("Expected proposal");
  return result.proposal;
}
async function decide(p: Proposal, action: "accept" | "reject", token = human, expected = 200) {
  const response = await request(`/v1/proposals/${p.id}/${action}`, token, {});
  expect(response.status).toBe(expected);
  return expected === 200 ? Proposal.parse(await response.json()) : ApiError.parse(await response.json()).error;
}
async function invalid(body: unknown, token = agent, expected = 400) {
  const before = await readFile(join(vault, relative));
  const response = await request("/v1/operations", token, body);
  expect(response.status).toBe(expected);
  const error = ApiError.parse(await response.json()).error;
  expect(error.code).toBe(expected === 409 ? "CONFLICT" : "INVALID");
  expect(await readFile(join(vault, relative))).toEqual(before);
  return error;
}
function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", vault, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
function initGit() {
  git("init", `--separate-git-dir=${join(temp, "gitdir")}`); git("config", "user.name", "Synthetic Test"); git("config", "user.email", "test@example.invalid");
  git("add", "."); git("commit", "-m", "fixture");
}
async function tick(ms: number) { clock.advance(ms); await request("/v1/actors"); }

test("human applies immediately; agent proposes without writing; both agent decisions are forbidden", async () => {
  const before = await readFile(join(vault, relative));
  const p = await propose();
  expect(p.author).toBe(author.id); expect(p.operation).toEqual(operation);
  expect(await readFile(join(vault, relative))).toEqual(before);
  for (const action of ["accept", "reject"] as const) {
    const error = await decide(p, action, agent, 403);
    expect(error).toMatchObject({ code: "FORBIDDEN", operation, reason: "agent-cannot-decide-proposals", proposal: p.id });
    expect(hub!.store.proposal(p.id)!.status).toBe("pending");
  }
  const accepted = await decide(p, "accept");
  expect(accepted).toMatchObject({ status: "accepted", decided_by: owner.id });
  expect(parseFrontmatter(await readFile(join(vault, relative))).data.related).toEqual([paper]);
  const direct: Operation = { op: "link.add", args: { from: literal, to: main } };
  const response = await request("/v1/operations", human, { operation: direct });
  expect(response.status).toBe(200); expect(OperationResult.parse(await response.json())).toEqual({ status: "applied", operation: direct });
  expect(parseFrontmatter(await readFile(join(vault, relative))).data.related).toEqual([paper, main]);
});

test("human rejection writes no file and decided proposals cannot be changed", async () => {
  const before = await readFile(join(vault, relative)); const p = await propose();
  expect(await decide(p, "reject")).toMatchObject({ status: "rejected", decided_by: owner.id });
  expect(await readFile(join(vault, relative))).toEqual(before);
  for (const action of ["accept", "reject"] as const) expect(await decide(p, action, human, 409)).toMatchObject({ code: "CONFLICT", proposal: p.id });
  const second = await propose(); await decide(second, "accept");
  for (const action of ["accept", "reject"] as const) await decide(second, action, human, 409);
});

test("accepted inline and block lists preserve the exact body and other frontmatter; links sees related", async () => {
  for (const style of ["inline", "block"] as const) {
    const from = style === "inline" ? main : literal;
    const path = join(vault, style === "inline" ? "research/ideas/Main.md" : relative);
    if (style === "block") await writeFile(path, (await readFile(path, "utf8")).replace("type: idea", `type: idea\nrelated:\n  - ${main} # preserve`));
    const before = await readFile(path);
    const p = await propose({ op: "link.add", args: { from, to: paper } });
    await decide(p, "accept");
    const after = await readFile(path);
    expect(after).toEqual(Buffer.from(before.toString().replace(style === "inline" ? "idea_00000000000000000000000099]" : `- ${main} # preserve`,
      style === "inline" ? `idea_00000000000000000000000099, ${paper}]` : `- ${main} # preserve\n  - ${paper}`)));
    expect(parseFrontmatter(after).body).toEqual(parseFrontmatter(before).body);
    const links = LinksResult.parse(await (await request(`/v1/notes/${from}/links`)).json());
    expect(links.outgoing.find((link) => link.target === paper)).toMatchObject({ source: "related", dangling: false, note: { id: paper } });
  }
});

test("duplicate proposals, self/existing links, unknown/no-ID/private references and malformed related are rejected", async () => {
  const p = await propose();
  expect(await invalid({ operation, reason: "another reason" }, other, 409)).toMatchObject({ proposal: p.id, operation });
  await invalid({ operation });
  await invalid({ operation: { op: "link.add", args: { from: literal, to: literal } }, reason: "self" });
  await invalid({ operation: { op: "link.add", args: { from: main, to: "pap_00000000000000000000000001" } }, reason: "existing" });
  for (const ref of [privateId, "idea_00000000000000000000000098", "NoID"]) {
    for (const args of [{ from: literal, to: ref }, { from: ref, to: literal }]) await invalid({ operation: { op: "link.add", args }, reason: "invalid" });
  }
  await invalid({ operation: { ...operation, extra: true }, reason: "invalid" });
  await invalid({ operation, reason: "" });
  await writeFile(join(vault, relative), (await readFile(join(vault, relative), "utf8")).replace("type: idea", "type: idea\nrelated: broken"));
  await invalid({ operation, reason: "broken" }, human);
});

test("concurrent edits return 409 and retain both pending status and the human's bytes", async () => {
  const p = await propose(); const path = join(vault, relative);
  const humanBytes = Buffer.concat([await readFile(path), Buffer.from("\nHuman edit\n")]);
  beforeCommit = () => writeFile(path, humanBytes);
  expect(await decide(p, "accept", human, 409)).toMatchObject({ code: "CONFLICT", operation, proposal: p.id });
  expect(hub!.store.proposal(p.id)!.status).toBe("pending");
  expect(await readFile(path)).toEqual(humanBytes);
  beforeCommit = undefined; await decide(p, "accept");
  expect(parseFrontmatter(await readFile(path)).body).toEqual(parseFrontmatter(humanBytes).body);
});

test("actors is authenticated, shared by both roles and sorted; proposals persist and agents see only their own", async () => {
  for (const token of [human, agent]) {
    const response = await request("/v1/actors", token); expect(response.status).toBe(200);
    const actors = Actor.array().parse(await response.json()); expect(actors).toEqual(hub!.store.actors());
    expect(actors.map((a) => a.created)).toEqual(actors.map((a) => a.created).sort());
  }
  expect((await fetch(`${base()}/v1/actors`)).status).toBe(401);
  const first = await propose();
  const second = await propose({ op: "link.add", args: { from: main, to: paper } }, other);
  const list = async (token: string, status = "pending") => Proposal.array().parse(await (await request(`/v1/proposals?status=${status}`, token)).json());
  expect((await list(agent)).map((p) => p.id)).toEqual([first.id]);
  expect((await list(other)).map((p) => p.id)).toEqual([second.id]);
  expect((await list(human)).map((p) => p.created)).toEqual([second.created, first.created]);
  await decide(first, "reject"); expect((await list(agent, "rejected")).map((p) => p.id)).toEqual([first.id]);
  const reopened = await HubStore.open(state);
  try { expect(reopened.proposal(first.id)).toMatchObject({ status: "rejected", decided_by: owner.id }); } finally { reopened.close(); }
  const invalidStatus = await request("/v1/proposals?status=all"); expect(invalidStatus.status).toBe(400); ApiError.parse(await invalidStatus.json());
});

test("audit records operation requests, all decisions, actor IDs and execution outcomes without tokens", async () => {
  const p = await propose(); await decide(p, "accept", agent, 403); await decide(p, "accept");
  const rows = hub!.store.db.query("SELECT * FROM audit ORDER BY rowid").all();
  expect(rows).toEqual([
    expect.objectContaining({ actor_id: author.id, authorization: "needs_approval", proposal_id: p.id, execution_result: "pending_approval", operation: JSON.stringify(operation) }),
    expect.objectContaining({ actor_id: author.id, authorization: "deny", proposal_id: p.id, execution_result: "FORBIDDEN" }),
    expect.objectContaining({ actor_id: owner.id, authorization: "allow", proposal_id: p.id, execution_result: "accepted", operation: JSON.stringify(operation) }),
  ]);
  expect(JSON.stringify(rows)).not.toContain(agent); expect(JSON.stringify(rows)).not.toContain(human);
});

test("git isolates the prior human edit, only commits the target and uses correct trailers; watch settles without another commit", async () => {
  initGit();
  // Restart so autosave can discover the temporary repository as well.
  await hub!.stop();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state }), port: 0, autosaveIdle: 10 }, { log() {}, watch: {
    clock, onProcess: () => { processed++; }, watch: ((_path, _opts, callback) => { notify = (path) => (callback as (event: string, path: string) => void)("change", path); return Object.assign(new EventEmitter(), { close() {} }) as FSWatcher; }) as typeof watch,
  } });
  const p = await propose(); const path = join(vault, relative);
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("\nHuman edit\n")]));
  const humanBytes = await readFile(path);
  await writeFile(join(vault, "README.md"), "synthetic unrelated staged change\n"); git("add", "README.md");
  await decide(p, "accept");
  expect(git("show", "--format=", "--name-only", "HEAD").trim()).toBe(relative);
  const message = git("show", "-s", "--format=%B", "HEAD");
  expect(message).toContain(`Lumio-Actor: ${author.id}`); expect(message).toContain(`Lumio-Proposal: ${p.id}`); expect(message).toContain(`Lumio-Approved-By: ${owner.id}`);
  expect(git("show", "-s", "--format=%B", "HEAD^").trim()).toBe("lumio: auto-save 1 files");
  expect(Buffer.from(git("show", `HEAD^:${relative}`))).toEqual(humanBytes);
  expect(git("diff", "HEAD^", "HEAD", "--", relative)).not.toContain("+Human edit");
  expect(git("status", "--porcelain")).toContain("README.md");
  // Commit that independent user change before checking that self notifications stay idle.
  git("commit", "-m", "synthetic unrelated edit");
  const count = git("rev-list", "--count", "HEAD"); const after = await readFile(path);
  notify(relative); notify(relative); await tick(2000);
  expect(processed).toBe(1); expect(await readFile(path)).toEqual(after);
  await tick(10_000); await tick(30_000);
  expect(git("rev-list", "--count", "HEAD")).toBe(count); expect(processed).toBe(1);
  expect(git("status", "--porcelain").trim()).toBe("");
});

test("direct human git commit has only actor attribution; card changes before staging are never committed", async () => {
  initGit();
  const response = await request("/v1/operations", human, { operation }); expect(response.status).toBe(200);
  const message = git("show", "-s", "--format=%B"); expect(message).toContain(`Lumio-Actor: ${owner.id}`);
  expect(message).not.toContain("Lumio-Proposal"); expect(message).not.toContain("Lumio-Approved-By");
  // A human edit containing a synthetic card blocks a subsequent operation before any autosave.
  const card = await readFile(new URL("../../../fixtures/query-vault/research/ideas/Card.md", import.meta.url));
  const path = join(vault, relative); await writeFile(path, Buffer.concat([await readFile(path), card]));
  const before = git("rev-parse", "HEAD");
  await invalid({ operation: { op: "link.add", args: { from: literal, to: main } } }, human);
  expect(git("rev-parse", "HEAD")).toBe(before);
});

async function cli(args: string[], token = human, remote = true) {
  const child = Bun.spawn([process.execPath, new URL("../../cli/src/main.ts", import.meta.url).pathname, ...args], {
    env: { ...process.env, LUMIO_HUB_URL: remote ? base() : undefined, LUMIO_TOKEN: remote ? token : undefined, LUMIO_VAULT: undefined }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("CLI aliases resolve references, validates JSON successes/errors and renders titles/actor names", async () => {
  const result = await cli(["propose", "link", "Literal", "Zeta_2025_Study", "--reason", "相关内容", "--json"], agent);
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  const pending = OperationResult.parse(JSON.parse(result.stdout)); if (pending.status !== "pending_approval") throw new Error("Expected proposal");
  const list = await cli(["proposals"]); expect(list.code).toBe(0);
  for (const text of [pending.proposal.id, "Literal symbols", "中文索引论文", "相关内容", author.name, pending.proposal.created]) expect(list.stdout).toContain(text);
  const denied = await cli(["proposals", "accept", pending.proposal.id, "--json"], agent);
  expect(denied.code).toBe(1); expect(denied.stderr).toBe(""); expect(ApiError.parse(JSON.parse(denied.stdout)).error).toMatchObject({ code: "FORBIDDEN", operation, reason: "agent-cannot-decide-proposals" });
  const accepted = await cli(["proposals", "accept", pending.proposal.id]); expect(accepted.code).toBe(0); expect(accepted.stdout).toContain("决定者：owner");
  const jsonList = await cli(["proposals", "--status", "accepted", "--json"]); expect(Proposal.array().parse(JSON.parse(jsonList.stdout))).toHaveLength(1);
  const links = await cli(["links", "Literal", "--json"]); expect(LinksResult.parse(JSON.parse(links.stdout)).outgoing).toContainEqual(expect.objectContaining({ source: "related", target: paper }));
  const applied = await cli(["link", "add", "Literal", "Main", "--json"]); expect(applied.code).toBe(0); expect(OperationResult.parse(JSON.parse(applied.stdout)).status).toBe("applied");
});

test("CLI pending message, rejection JSON, missing IDs, malformed args and local mode errors", async () => {
  const pending = await cli(["link", "add", "Literal", "Zeta_2025_Study", "--reason", "相关"], agent);
  expect(pending.code).toBe(0); expect(pending.stdout).toMatch(/已提交提议 prop_\w+，等待批准/);
  const p = hub!.store.proposals("pending")[0]!;
  const rejected = await cli(["proposals", "reject", p.id, "--json"]); expect(rejected.code).toBe(0); expect(Proposal.parse(JSON.parse(rejected.stdout)).status).toBe("rejected");
  const path = join(vault, "research/ideas/NoID.md"); await writeFile(path, (await readFile(path, "utf8")).replace(/^id:.*\n/m, ""));
  const noId = await cli(["link", "add", "NoID", "Literal", "--json"]); expect(noId.code).toBe(1); expect(ApiError.parse(JSON.parse(noId.stdout)).error.code).toBe("INVALID");
  for (const args of [["link", "add", "Literal", "Zeta_2025_Study"], ["proposals"], ["proposals", "accept", p.id]]) {
    const result = await cli([...args, "--json"], human, false); expect(result.code).toBe(1); expect(ApiError.parse(JSON.parse(result.stdout)).error.message).toContain("LUMIO_HUB_URL");
  }
  for (const args of [["link", "add"], ["propose", "bad"], ["proposals", "--status", "bad"], ["proposals", "--reason", "bad"], ["proposals", "--vault", "bad"]]) {
    const result = await cli([...args, "--json"]); expect(result.code).toBe(1); ApiError.parse(JSON.parse(result.stdout));
  }
});

test("git commit failure leaves proposal pending, rolls back only operation bytes and permits a clean retry", async () => {
  initGit(); const p = await propose(); const path = join(vault, relative); const before = await readFile(path);
  beforeCommit = () => writeFile(join(temp, "gitdir/HEAD.lock"), "synthetic lock");
  await decide(p, "accept", human, 409);
  expect(hub!.store.proposal(p.id)!.status).toBe("pending"); expect(await readFile(path)).toEqual(before);
  await rm(join(temp, "gitdir/HEAD.lock")); beforeCommit = undefined;
  await decide(p, "accept");
  expect(git("show", "-s", "--format=%B")).toContain(`Lumio-Proposal: ${p.id}`);
});

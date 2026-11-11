import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_NOTE_CAPABILITY_NAMES, AgentInfo, AgentTokenIssued, CAPABILITIES, Capture, CaptureCreateResult, CliConfig, ORIGINAL_CAPABILITY_NAME, KnowledgeAiNoteResult, NoteDetail, WorkCommandResult } from "@lumio/schema";
import { CAPABILITY_COMMANDS } from "../../../skills/lumio/commands.ts";
import { SKILL_PATHS } from "../../../skills/lumio/install.ts";
import { generateSkill } from "../../../scripts/gen-skill.ts";

const main = new URL("../src/main.ts", import.meta.url).pathname;
const hubMain = new URL("../../hub/src/main.ts", import.meta.url).pathname;
let temp: string, human: string, agent: string, url: string, daemon: ReturnType<typeof Bun.spawn>;
async function cli(args: string[], token = agent, extra: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, main, ...args], { env: { ...process.env, HOME: temp, LUMIO_HUB_URL: url, LUMIO_TOKEN: token, LUMIO_VAULT: undefined, LUMIO_CONFIG_FILE: undefined, ...extra }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-cli-access-"));
  await cp(new URL("../../../fixtures/query-vault", import.meta.url), join(temp, "vault"), { recursive: true });
  const env = { HOME: temp, LUMIO_STATE_DIR: join(temp, "state"), LUMIO_VAULT: join(temp, "vault") };
  const manage = (...args: string[]) => {
    const child = Bun.spawnSync([process.execPath, hubMain, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode) throw new Error(child.stderr.toString()); return child.stdout.toString().trim();
  };
  manage("actor", "create", "owner", "--role", "human"); human = manage("token", "create", "owner", "--actor", "owner");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = probe.port; await probe.stop(true);
  url = `http://127.0.0.1:${port}`;
  daemon = Bun.spawn([process.execPath, hubMain], { env: { ...env, LUMIO_HUB_LISTEN: `127.0.0.1:${port}` }, stdout: "ignore", stderr: "pipe" });
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(url + "/health")).ok) break; } catch {} if (Date.now() > deadline) throw new Error("Synthetic Hub timed out"); await Bun.sleep(30); }
  const added = await cli(["agent", "add", "synthetic-agent", "--label", "synthetic-cli", "--json"], human);
  expect(added.code).toBe(0); agent = AgentTokenIssued.parse(JSON.parse(added.stdout)).token;
});
afterEach(async () => { daemon?.kill("SIGTERM"); await daemon?.exited; await rm(temp, { recursive: true, force: true }); });

test("every catalog capability has an executable CLI command returning its result contract", async () => {
  const covered = new Set<string>();
  async function run(name: string, args: string[]) {
    const capability = CAPABILITIES.find(value => value.name === name)!;
    expect(CAPABILITY_COMMANDS[name]).toBeTruthy();
    const response = await cli([...args, "--json"]); expect(response.code, response.stderr + response.stdout).toBe(0);
    const result = capability.result.parse(JSON.parse(response.stdout)); covered.add(name); return result;
  }
  const project = await run("work.project.create", ["project", "new", "Synthetic project"]) as { kind: string; project: { id: string; revision: number } };
  await run("work.project.list", ["project", "list", "--status", "active"]);
  await run("work.project.show", ["project", "show", project.project.id]);
  await run("work.project.update", ["project", "update", project.project.id, "--patch", '{"goal":"Synthetic goal"}', "--revision", String(project.project.revision)]);
  const task = await run("work.task.create", ["task", "new", "Synthetic task", "--project", project.project.id]) as { task: { id: string; revision: number } };
  await run("work.task.list", ["task", "list", "--query", "Synthetic", "--project", project.project.id]);
  await run("work.task.show", ["task", "show", task.task.id]);
  await run("work.task.update", ["task", "update", task.task.id, "--patch", '{"title":"Synthetic updated task"}', "--revision", String(task.task.revision)]);
  await run("work.task.comment", ["task", "comment", task.task.id, "Synthetic comment"]);
  await run("work.task.hand", ["task", "hand", task.task.id, "--to", "external", "--note", "Synthetic wait"]);
  const search = await run("knowledge.note.search", ["search", "推荐"]) as { hits: { note: { id?: string; path: string } }[] };
  // Select a synthetic note with the public list API if the chosen text has no hits.
  const hits = search.hits.length ? search.hits : (JSON.parse((await cli(["search", "", "--json"])).stdout) as typeof search).hits;
  const note = hits[0]!.note, ref = note.id ?? note.path.split("/").at(-1)!.replace(/\.md$/, "");
  await run("knowledge.note.show", ["show", ref]); await run("knowledge.note.links", ["links", ref]);
  const file = join(temp, "ai-note.md");
  await writeFile(file, "Synthetic AI note body");
  const ai = KnowledgeAiNoteResult.parse(await run(AI_NOTE_CAPABILITY_NAMES[0], ["ai-note", "create", "Synthetic AI note", "--file", file, "--sources", JSON.stringify([task.task.id])]));
  const aiDetail = NoteDetail.parse(await run("knowledge.note.show", ["show", ai.note.id!]));
  expect(aiDetail.revision).toBe(ai.revision);
  await run(AI_NOTE_CAPABILITY_NAMES[1], ["ai-note", "update", ai.note.id!, "--revision", aiDetail.revision!, "--title", "Updated AI note"]);
  await run("execution.job.list", ["job", "list", "--task", task.task.id, "--limit", "5"]);
  // Submit a synthetic command through the human interface to exercise a nonempty Job result.
  const auth = { Authorization: `Bearer ${human}`, "Content-Type": "application/json" };
  const originalUrl = "https://articles.example/cli-fixture";
  const originalBody = await readFile(new URL("../../../fixtures/i1-inbox/original.md", import.meta.url), "utf8");
  const captured = await fetch(url + "/v2/inbox/captures", {
    method: "POST", headers: auth,
    body: JSON.stringify({ request_id: randomUUID(), url: originalUrl, title: "CLI original", channel: "extension", content: { format: "markdown", body: originalBody } }),
  });
  const captureId = CaptureCreateResult.parse(await captured.json()).capture.id;
  let entityId: string | undefined;
  for (let i = 0; i < 100 && !entityId; i++) {
    const current = Capture.parse(await (await fetch(url + "/v2/inbox/captures/" + captureId, { headers: auth })).json());
    entityId = current.entity?.id;
    if (!entityId) await Bun.sleep(15);
  }
  expect(entityId).toBeDefined();
  const duplicate = await cli(["capture", originalUrl + "?utm_medium=fixture", "--json"], human);
  expect(duplicate.code).toBe(0);
  expect(CaptureCreateResult.parse(JSON.parse(duplicate.stdout))).toMatchObject({ duplicate: "existing", capture: { id: captureId } });
  await run(ORIGINAL_CAPABILITY_NAME, ["original", "show", entityId!]);
  // Register a runtime through its own synthetic token.
  const runtimeName = "synthetic-runtime";
  // Local management CLI remains available while the Hub is serving this synthetic database.
  const manage = (...args: string[]) => Bun.spawnSync([process.execPath, hubMain, ...args], { env: { HOME: temp, LUMIO_STATE_DIR: join(temp, "state") }, stdout: "pipe", stderr: "pipe" });
  expect(manage("actor", "create", runtimeName, "--role", "runtime").exitCode).toBe(0);
  const runtime = manage("token", "create", runtimeName, "--actor", runtimeName).stdout.toString().trim();
  expect((await fetch(url + "/v1/runtime/register", { method: "POST", headers: { ...auth, Authorization: `Bearer ${runtime}` }, body: JSON.stringify({ protocol_version: 2, name: "server", engines: [{ name: "codex", version: "synthetic", sandbox: "os" }], tags: [], max_concurrent: 1 }) })).status).toBe(200);
  const submitted = await fetch(url + "/v1/jobs", { method: "POST", headers: auth, body: JSON.stringify({ runtime: "server", run: { kind: "command", argv: ["/bin/true"] } }) });
  expect(submitted.status).toBe(200); const job = await submitted.json() as { spec: { id: string } };
  await run("execution.job.show", ["job", "show", job.spec.id]);
  await run("execution.routine.list", ["routine", "list"]);
  await run("approval.proposal.list", ["proposals"]);
  await run("execution.target.list", ["targets"]);
  const delegation = WorkCommandResult.parse(await run("work.task.dispatch", ["task", "continue", task.task.id, "--to", "codex@server"]));
  if (delegation.kind !== "proposal") throw new Error("delegation proposal expected");
  await run("approval.proposal.withdraw", ["proposals", "withdraw", delegation.proposal]);
  const planFile = join(temp, "plan.json");
  await writeFile(planFile, JSON.stringify({ stages: [{ kind: "agent", id: "implement", agent: "codex@server", instruction: "Synthetic implementation" }] }));
  const plan = WorkCommandResult.parse(await run("work.task.plan.set", ["task", "plan", "set", task.task.id, "--file", planFile]));
  expect(plan.kind).toBe("proposal");
  await run("work.attention.list", ["attention"]);
  expect([...covered].sort()).toEqual(CAPABILITIES.map(value => value.name).sort());
  expect(await generateSkill()).toBe(await readFile(new URL("../../../skills/lumio/SKILL.md", import.meta.url), "utf8"));
});

test("agent CLI lists no plaintext, revokes one or all labels, and prints a token once", async () => {
  const second = await cli(["agent", "add", "synthetic-agent", "--label", "second-label"], human);
  expect(second.code).toBe(0); const token = second.stdout.match(/lumio_[A-Za-z0-9_-]{43}/g)!; expect(token).toHaveLength(1);
  const listed = await cli(["agent", "list", "--json"], human); expect(listed.code).toBe(0);
  AgentInfo.array().parse(JSON.parse(listed.stdout)); expect(listed.stdout).not.toContain(agent); expect(listed.stdout).not.toContain(token[0]!);
  expect((await cli(["agent", "revoke", "synthetic-agent", "--label", "second-label"], human)).code).toBe(0);
  expect((await cli(["task", "list", "--json"], token[0]!)).code).toBe(1);
  expect((await cli(["task", "list", "--json"])).code).toBe(0);
  expect((await cli(["agent", "revoke", "synthetic-agent"], human)).code).toBe(0);
  expect((await cli(["task", "list", "--json"])).code).toBe(1);
});

test("skill install writes and updates all three agent directories with separate private connections", async () => {
  for (const target of Object.keys(SKILL_PATHS) as (keyof typeof SKILL_PATHS)[]) {
    const directory = join(temp, SKILL_PATHS[target]), skill = join(directory, "SKILL.md"), connection = join(directory, "connection.json");
    const installed = await cli(["skill", "install", "--for", target], human); expect(installed.code, installed.stderr).toBe(0);
    const config = CliConfig.parse(JSON.parse(await readFile(connection, "utf8")));
    expect(config.token).not.toBe(human); expect(config.token).not.toBe(agent);
    const content = await readFile(skill, "utf8"); expect(content).toBe(await generateSkill()); expect(content).not.toContain(config.token);
    expect((await stat(connection)).mode & 0o777).toBe(0o600);
    expect((await cli(["task", "list", "--json"], undefined, { LUMIO_HUB_URL: undefined, LUMIO_TOKEN: undefined, LUMIO_CONFIG_FILE: connection })).code).toBe(0);
    await writeFile(skill, "old synthetic version");
    expect((await cli(["skill", "install", "--for", target], human)).code).toBe(0);
    expect(await readFile(skill, "utf8")).toBe(content); expect(CliConfig.parse(JSON.parse(await readFile(connection, "utf8"))).token).toBe(config.token);
  }
  expect((await cli(["skill", "install"], human)).code).toBe(0);
  expect((await cli(["skill", "install", "--for", "toString"], human)).code).toBe(1);
});


test("upgrading a symlink installation never writes credentials into its source checkout", async () => {
  const source = join(temp, "synthetic-checkout"); await mkdir(source); await writeFile(join(source, "SKILL.md"), "original");
  const directory = join(temp, SKILL_PATHS.codex); await mkdir(join(temp, ".agents", "skills"), { recursive: true }); await symlink(source, directory);
  const result = await cli(["skill", "install", "--for", "codex"], human); expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe("original");
  expect(await Bun.file(join(source, "connection.json")).exists()).toBe(false);
  expect(CliConfig.parse(JSON.parse(await readFile(join(directory, "connection.json"), "utf8"))).token).not.toBe(human);
});

test("task CLI hands, filters and groups turns, finishes/cancels/reopens, and redirects obsolete status/assign commands", async () => {
  const created = JSON.parse((await cli(["task", "new", "Synthetic lifecycle", "--json"], human)).stdout);
  const id = created.task.id;
  expect((await cli(["task", "hand", id, "--to", "external", "--note", "Synthetic wait", "--json"], agent)).code).toBe(0);
  const list = await cli(["task", "list", "--turn", "external"], human, { LUMIO_LANG: "en" });
  expect(list.code).toBe(0); expect(list.stdout).toContain("External waiting"); expect(list.stdout).toContain(id);
  expect(JSON.parse((await cli(["task", "list", "--turn", "me", "--json"], human)).stdout)).toEqual([]);
  expect((await cli(["task", "hand", id, "--to", "nobody", "--json"], agent)).code).toBe(1);
  expect((await cli(["task", "finish", id, "--json"], agent)).code).toBe(1);
  expect(JSON.parse((await cli(["task", "finish", id, "--json"], human)).stdout).task.outcome).toBe("done");
  expect(JSON.parse((await cli(["task", "reopen", id, "--json"], human)).stdout).task.turn.reason).toBe("todo");
  expect(JSON.parse((await cli(["task", "cancel", id, "--json"], human)).stdout).task.outcome).toBe("cancelled");
  for (const action of ["status", "assign"]) {
    const response = await cli(["task", action, id, "--json"], human);
    expect(response.code).toBe(1); expect(response.stdout).toContain("hand"); expect(response.stdout).toContain("finish");
  }
});

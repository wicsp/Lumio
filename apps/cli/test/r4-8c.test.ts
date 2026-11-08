import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "@lumio/schema";
import { runCli } from "../src/cli.ts";
import { COMMANDS, commandUsage } from "../src/command-definitions.ts";
import { printHelp } from "../src/help.ts";
import { generateSkill } from "../../../scripts/gen-skill.ts";
const main = new URL("../src/main.ts", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "lumio-r48c-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
async function cli(args: string[], lang: string, url = "http://127.0.0.1:1") {
  const child = Bun.spawn([process.execPath, main, ...args], { env: { HOME: home, PATH: process.env.PATH, LUMIO_HUB_URL: url, LUMIO_TOKEN: "synthetic-token", LUMIO_LANG: lang }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr };
}
test("every command and namespace returns structured help before config, required arguments or network", async () => {
  const paths = new Set(["", ...COMMANDS.flatMap(command => [command.path, ...(command.aliases ?? []), ...command.path.split(" ").map((_, index, words) => words.slice(0, index).join(" "))])]);
  for (const path of paths) {
    const output: string[] = [];
    expect(await runCli([...path.split(" ").filter(Boolean), "--help", "--json"], { log: line => output.push(line) })).toBe(0);
    expect(output).toHaveLength(1);
    const help = JSON.parse(output[0]!); expect(help.usage).toContain("lumio"); expect(Array.isArray(help.subcommands)).toBe(true);
    if (path && COMMANDS.some(command => command.path.startsWith(`${path} `))) {
      expect(help.subcommands.length).toBeGreaterThan(0);
      expect(help.subcommands.every((command: { command: string }) => command.command.startsWith(`${path} `))).toBe(true);
    }
    if (COMMANDS.some(command => command.path === path)) expect(help.usage).toBe(`lumio ${commandUsage(COMMANDS.find(command => command.path === path)!)}`);
  }
  expect(printHelp(["job", "submit", "--", "/bin/echo", "--help"], () => { throw Error("child help was intercepted"); })).toBe(false);
});
for (const lang of ["en", "zh"]) test(`main routes help for CLI, Hub and Runtime without side effects (${lang})`, async () => {
  for (const args of [[], ["task", "continue"], ["hub", "migrate", "apply"], ["runtime", "sudo"]]) {
    const text = await cli([...args, "--help"], lang); expect(text.code).toBe(0); expect(text.stderr).toBe(""); expect(text.stdout).toContain(lang === "en" ? "Usage" : "用法");
    const json = await cli([...args, "--json", "--help"], lang); expect(json.code).toBe(0); expect(JSON.parse(json.stdout).usage).toContain("lumio");
  }
});
for (const lang of ["en", "zh"]) test(`connection failure names the Hub and three possible causes in text and JSON (${lang})`, async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), url = probe.url.origin; await probe.stop(true);
  for (const json of [false, true]) {
    const result = await cli(["targets", ...(json ? ["--json"] : [])], lang, url); expect(result.code).toBe(1);
    const message = json ? ApiError.parse(JSON.parse(result.stdout)).error.message : result.stderr;
    expect(message).toContain(url);
    for (const word of lang === "en" ? ["not be running", "address", "network"] : ["未运行", "地址", "网络"]) expect(message).toContain(word);
  }
});
test("skill command rows include every shared Work flag and delegation retry instructions", async () => {
  const skill = await generateSkill();
  for (const command of COMMANDS.filter(command => /^(task|project|plan-template) /.test(command.path))) {
    for (const flag of command.options ?? []) expect(skill.split("\n").find(line => line.includes(`lumio ${command.path} `))).toContain(`--${flag}`);
  }
  expect(skill).toContain("lumio targets --json"); expect(skill).toContain("automatically supersedes"); expect(skill).toContain("lumio proposals withdraw");
});

test("task new and update send every execution field; continue sends its comment and revision", async () => {
  const id = "task_00000000000000000000000001", at = "2026-11-05T00:00:00Z";
  const task = { schema_version: 3, type: "task", id, title: "Synthetic", description: "", revision: 1, outcome: "open", turn: { holder: "human", reason: "todo", since: at }, tags: [], dependencies: [], references: [], created: at, updated: at };
  const requests: { operation: { op: string; args: Record<string, unknown> } }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return Response.json({ task, dependents: [], children: [], comments: [], executions: [], turns: [] });
    const body = await request.json() as typeof requests[number]; requests.push(body);
    return Response.json(body.operation.op === "work.task.dispatch" ? { kind: "proposal", proposal: "prop_00000000000000000000000001" } : { kind: "task", task });
  } });
  try {
    const flags = ["--workdir", "/synthetic/task", "--model", "synthetic-model", "--gpus", "0,2", "--timeout", "30"];
    for (const args of [["task", "new", "Synthetic", ...flags], ["task", "update", id, "--revision", "1", ...flags], ["task", "continue", id, "--to", "codex@synthetic", "--comment", "Synthetic answer", "--revision", "1", "--request-id", "synthetic-continue-request"]]) {
      const r = await cli([...args, "--json"], "en", server.url.origin); expect(r.code, r.stdout + r.stderr).toBe(0);
    }
    expect(requests[0]!.operation.args).toMatchObject({ workdir: "/synthetic/task", model: "synthetic-model", gpus: [0, 2], timeout_minutes: 30 });
    expect(requests[1]!.operation.args).toMatchObject({ expected_revision: 1, patch: { workdir: "/synthetic/task", model: "synthetic-model", gpus: [0, 2], timeout_minutes: 30 } });
    expect(requests[2]!.operation.args).toMatchObject({ task: id, to: "codex@synthetic", comment: "Synthetic answer", expected_revision: 1 });
  } finally { await server.stop(true); }
});

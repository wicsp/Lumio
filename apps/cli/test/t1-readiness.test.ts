import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, WorkTask, WorkTaskDetail } from "@lumio/schema";
import { formatTaskRelations, taskBlockedLabel } from "../src/work.ts";
import { generateSkill } from "../../../scripts/gen-skill.ts";

const home = mkdtempSync(join(tmpdir(), "lumio-t1-cli-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const seed = WorkTask.parse(JSON.parse(readFileSync(new URL("../../../fixtures/work/readiness.json", import.meta.url), "utf8")));
const id = (n: number) => `task_${String(n).padStart(26, "0")}`;
const prerequisite = seed;
const cancelled = WorkTask.parse({ ...seed, id: id(2), title: "Synthetic cancelled prerequisite", outcome: "cancelled", turn: { ...seed.turn, holder: "nobody", reason: "on_hold" } });
const done = WorkTask.parse({ ...cancelled, id: id(3), title: "Synthetic completed prerequisite", outcome: "done" });
const task = WorkTask.parse({ ...seed, id: id(4), title: "Synthetic blocked task", dependencies: [prerequisite.id, cancelled.id, done.id, id(99)], blocked_by: [prerequisite.id] });
const dependent = WorkTask.parse({ ...seed, id: id(5), title: "Synthetic dependent", dependencies: [task.id] });
const child = WorkTask.parse({ ...seed, id: id(6), title: "Synthetic child", parent: task.id });
const detail = WorkTaskDetail.parse({ task, dependents: [dependent.id], children: [child.id], comments: [], executions: [], turns: [] });
const visible = [prerequisite, cancelled, done, task, dependent, child];
const main = new URL("../src/main.ts", import.meta.url).pathname;
async function cli(args: string[], language: string, url: string) {
  const childProcess = Bun.spawn([process.execPath, main, ...args], { env: { HOME: home, PATH: process.env.PATH, LUMIO_HUB_URL: url, LUMIO_TOKEN: "synthetic-token", LUMIO_LANG: language }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([childProcess.exited, new Response(childProcess.stdout).text(), new Response(childProcess.stderr).text()]);
  return { code, stdout, stderr };
}
for (const language of ["en", "zh"]) test(`readiness CLI forwards combined filters, displays relationships and preserves JSON (${language})`, async () => {
  const requests: URL[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url); requests.push(url);
    return Response.json(url.pathname === "/v2/work/tasks" ? visible : detail);
  } });
  try {
    for (const flag of ["--ready", "--blocked"]) {
      const result = await cli(["task", "list", flag, "--tag", "infra", "--parent", prerequisite.id, "--project", prerequisite.id.replace("task_", "prj_"), "--query", "Synthetic", "--turn", "me", "--json"], language, server.url.origin);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(WorkTask.array().parse(JSON.parse(result.stdout))).toEqual(visible.filter(task => task.turn.holder === "human"));
      expect(Object.fromEntries(requests.at(-1)!.searchParams)).toEqual({ readiness: flag.slice(2), tag: "infra", parent: prerequisite.id, project: prerequisite.id.replace("task_", "prj_"), q: "Synthetic" });
    }
    const list = await cli(["task", "list", "--blocked"], language, server.url.origin);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain(language === "en" ? "Waiting for 1 task" : "等 1 个");
    expect(list.stdout).not.toContain("⛓");
    requests.length = 0;
    const json = await cli(["task", "show", task.id, "--json"], language, server.url.origin);
    expect(json.code, json.stdout + json.stderr).toBe(0);
    expect(WorkTaskDetail.parse(JSON.parse(json.stdout))).toEqual(detail);
    expect(requests.map(url => url.pathname)).toEqual([`/v2/work/tasks/${task.id}`]);
    const show = await cli(["task", "show", task.id], language, server.url.origin);
    expect(show.code, show.stderr).toBe(0);
    for (const heading of language === "en" ? ["Prerequisites", "Dependents", "Children"] : ["前置", "后续", "子任务"]) expect(show.stdout).toContain(heading);
    for (const related of [prerequisite, cancelled, done, dependent, child]) expect(show.stdout).toContain(related.title);
    expect(show.stdout).toContain(language === "en" ? "Cancelled" : "已取消");
    expect(show.stdout).toContain(language === "en" ? "Done" : "已完成");
    expect(show.stdout).toContain(language === "en" ? "Deleted task" : "已删除的任务");
    expect(show.stdout).toContain(id(99));
    requests.length = 0;
    const conflict = await cli(["task", "list", "--ready", "--blocked", "--json"], language, server.url.origin);
    expect(conflict.code).toBe(1);
    const error = ApiError.parse(JSON.parse(conflict.stdout));
    expect(error.error.message).toContain("--ready"); expect(error.error.message).toContain("--blocked");
    expect(requests).toEqual([]);
    const help = await cli(["task", "list", "--help", "--json"], language, server.url.origin);
    const usage = JSON.parse(help.stdout).usage;
    expect(usage).toContain("[--ready]"); expect(usage).toContain("[--blocked]");
    expect(usage).toContain("[--tag <tag>]"); expect(usage).toContain("[--parent <parent>]");
    expect(usage).not.toContain("--ready <");
  } finally { await server.stop(true); }
});

test("blocked labels use a chain only in terminals; absent readiness and closed tasks stay unmarked", () => {
  expect(taskBlockedLabel(task, true)).toContain("⛓ ");
  expect(taskBlockedLabel(task, false)).not.toContain("⛓");
  expect(taskBlockedLabel(seed, true)).toBe("");
  expect(taskBlockedLabel({ ...cancelled, blocked_by: [seed.id] }, true)).toBe("");
  expect(formatTaskRelations({ ...detail, task: seed, dependents: [], children: [] }, [])).not.toContain("undefined");
});

test("generated skill documents readiness and preserves the structure approval boundary", async () => {
  const skill = await generateSkill();
  expect(skill).toContain("lumio task list --ready --json");
  expect(skill).toContain("task update <task-id> --depends");
  expect(skill).toContain("--depends` replaces the entire dependency list");
  expect(skill).toContain("Do not change another task's parent, project, dependencies or tags on your own");
  expect(skill).toContain("does not add a new approval API");
});

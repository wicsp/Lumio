import { isolatedHome } from "./test-home.ts";
import { expect, test } from "bun:test";
import { Job, OperationRequest } from "@lumio/schema";
const home = isolatedHome();
const task = "task_00000000000000000000000001";
const refs = [1, 2, 3].map((n) => ({ id: `task_${String(n).padStart(26, "0")}`, type: "task", title: `合成任务${n}`, path: `plan/tasks/Task${n}.md` }));
const job = Job.parse({ spec: { protocol_version: 2, id: "job_00000000000000000000000001", source: { task, round: 1 }, runtime: "act_00000000000000000000000001", lease: "synthetic-lease-000", run: { kind: "agent", engine: "pi", prompt: "合成要求" }, workdir: "~", timeout_seconds: 60, created: "2026-10-30T00:00:00Z" }, status: "queued" });
async function cli(args: string[]) {
  const operations: OperationRequest[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/search") {
      expect(url.searchParams.get("q")).toBe(""); expect(url.searchParams.get("type")).toBe("task");
      return Response.json({ query: "", total: refs.length, hits: (url.searchParams.has("limit") ? refs : refs.slice(0, 1)).map((note) => ({ note, snippet: "" })) });
    }
    if (url.pathname.startsWith("/v1/notes/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/notes/".length));
      const note = refs.find((ref) => ref.id === id) ?? refs[0]!;
      return Response.json({ note, frontmatter: { assignee: note === refs[2] ? "human" : "pi@server" }, body: "合成任务" });
    }
    if (url.pathname === "/v1/jobs") return Response.json([job]);
    if (url.pathname === "/v1/operations") {
      const operation = OperationRequest.parse(await request.json()); operations.push(operation);
      return Response.json({ status: "applied", operation: operation.operation });
    }
    return new Response("missing", { status: 404 });
  } });
  try {
    const child = Bun.spawn([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, "task", ...args], {
      env: { HOME: home, LUMIO_HUB_URL: `http://127.0.0.1:${server.port}`, LUMIO_TOKEN: "synthetic" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code, operations };
  } finally { await server.stop(true); }
}
test("task continue --to validates an agent and sends it through the operation contract", async () => {
  const result = await cli(["continue", task, "--to", "codex", "--json"]);
  expect(result.code).toBe(0); Job.parse(JSON.parse(result.stdout));
  expect(result.operations).toEqual([{ operation: { op: "task.dispatch", args: { task, trigger: "cli", to: "codex" } } }]);
  const previous = await cli(["continue", task, "--json"]);
  expect(previous.operations[0]!.operation).toEqual({ op: "task.dispatch", args: { task, trigger: "cli" } });
  for (const to of ["human", "pi@", "@server", "Pi@server", "gpt@server"]) {
    const refused = await cli(["continue", task, "--to", to]);
    expect(refused.code).toBe(1); expect(refused.operations).toEqual([]); expect(refused.stderr).toContain("pi@server");
  }
});
test("task list shows assignee and running, pending, none states and fetches beyond the initial search limit", async () => {
  const result = await cli(["list"]);
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  expect(result.stdout).toContain("合成任务1  pi@server  执行中");
  expect(result.stdout).toContain("合成任务2  pi@server  等待派出");
  expect(result.stdout).toContain("合成任务3  human  无");
});

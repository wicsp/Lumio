import { expect, test } from "bun:test";
import { Job, OperationRequest, RoutineInfo } from "@lumio/schema";

// lumio routine list / followup（P2-5）。Hub 用一个假的 HTTP 服务代替。
const R = "rtn_01M5AAAAAAAAAAAAAAAAAAAAR1";
const routine = { id: R, type: "routine", title: "日报", path: "plan/routines/日报.md" } as const;
const info = RoutineInfo.parse({ routine, schedule: "0 9 * * *", timezone: "Asia/Singapore", status: "active", runtime: "server",
  next: "2026-10-27T01:00:00Z", last: { job: "job_01M5AAAAAAAAAAAAAAAAAAAAJ1", fired_at: "2026-10-26T01:00:00Z", status: "done" } });
const run = (id: string, fired: string) => Job.parse({ status: "done", assigned: fired, spec: { protocol_version: 2, id, source: { routine: R, round: 1, fired_at: fired },
  runtime: "act_01M5AAAAAAAAAAAAAAAAAAAAA1", lease: "l".repeat(32), run: { kind: "agent", engine: "pi", prompt: "日报" }, workdir: "/w", timeout_seconds: 60, created: fired } });
const jobs = [run("job_01M5AAAAAAAAAAAAAAAAAAAAJ1", "2026-10-26T01:00:00Z"), run("job_01M5AAAAAAAAAAAAAAAAAAAAJ2", "2026-10-26T05:00:00Z"), run("job_01M5AAAAAAAAAAAAAAAAAAAAJ3", "2026-10-25T01:00:00Z")];

async function cli(args: string[]) {
  const posted: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/routines") return Response.json([info]);
    if (url.pathname === `/v1/notes/${encodeURIComponent("日报")}`) return Response.json({ note: routine, frontmatter: {}, body: "" });
    if (url.pathname === "/v1/jobs") { expect(url.searchParams.get("routine")).toBe(R); return Response.json(jobs); }
    if (url.pathname === "/v1/operations") {
      const body = OperationRequest.parse(await request.json()); posted.push(body);
      return Response.json({ status: "applied", operation: body.operation, note: { id: "task_01M5AAAAAAAAAAAAAAAAAAAAT1", type: "task", title: "日报 · 2026-10-26 09:00 追问", path: "plan/tasks/日报 · 2026-10-26 09-00 追问.md" } });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "Synthetic missing" } }, { status: 404 });
  } });
  try {
    const child = Bun.spawn([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, "routine", ...args], {
      env: { ...process.env, LUMIO_HUB_URL: `http://127.0.0.1:${server.port}`, LUMIO_TOKEN: "synthetic-token" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code, posted };
  } finally { await server.stop(true); }
}

test("routine list shows schedule, next and last run in the routine's time zone", async () => {
  const human = await cli(["list"]);
  expect(human.code).toBe(0);
  expect(human.stdout).toBe("日报  0 9 * * *（Asia/Singapore）  下次 2026-10-27 09:00  执行器 server  上次 2026-10-26 09:00 完成\n");
  expect(RoutineInfo.array().parse(JSON.parse((await cli(["list", "--json"])).stdout))).toEqual([info]);
});

test("routine followup picks the run by local date or minute and refuses ambiguous or missing dates", async () => {
  const ambiguous = await cli(["followup", "日报", "2026-10-26"]);
  expect(ambiguous.code).not.toBe(0);
  expect(ambiguous.stderr).toContain("2026-10-26 09:00、2026-10-26 13:00");
  const ok = await cli(["followup", "日报", "2026-10-26 09:00"]);
  expect(ok.code).toBe(0);
  expect(ok.posted).toEqual([{ operation: { op: "routine.followup", args: { routine: R, job: "job_01M5AAAAAAAAAAAAAAAAAAAAJ1" } } }]);
  expect(ok.stdout).toContain("已新建追问任务：plan/tasks/日报 · 2026-10-26 09-00 追问.md");
  expect((await cli(["followup", "日报", "2026-10-25"])).posted).toHaveLength(1);
  const missing = await cli(["followup", "日报", "2026-01-01"]);
  expect(missing.code).not.toBe(0); expect(missing.stderr).toContain("没有执行记录");
  expect((await cli(["oops"])).stderr).toContain("用法");
});

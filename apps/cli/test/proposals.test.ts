import { expect, test } from "bun:test";
import { Proposal } from "@lumio/schema";

const proposal = Proposal.parse({ id: "prop_00000000000000000000000001", operation: { op: "task.dispatch", args: { task: "task_00000000000000000000000012", trigger: "cli" } }, reason: "合成提议", author: "act_00000000000000000000000001", status: "accepted", created: "2026-01-01T00:00:00Z", decided: "2026-01-01T00:00:01Z", decided_by: "act_00000000000000000000000002" });

test("proposal rendering uses actors for author/decider names and falls back to IDs when absent", async () => {
  for (const known of [false, true]) {
    const calls: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname; calls.push(path);
      if (path === "/v1/actors") return Response.json(known ? [
        { id: proposal.author, name: "codex", role: "agent", created: proposal.created },
        { id: proposal.decided_by, name: "owner", role: "human", created: proposal.created },
      ] : []);
      if (path === "/v1/proposals") return Response.json([proposal]);
      return Response.json({ error: { code: "NOT_FOUND", message: "Synthetic missing note" } }, { status: 404 });
    } });
    try {
      const child = Bun.spawn([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, "proposals", "--status", "accepted"], {
        env: { ...process.env, LUMIO_HUB_URL: `http://127.0.0.1:${server.port}`, LUMIO_TOKEN: "synthetic-token" }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0); expect(stderr).toBe(""); expect(calls).toContain("/v1/actors");
      expect(stdout).toContain(`提交者：${known ? "codex" : proposal.author}`);
      expect(stdout).toContain(`决定者：${known ? "owner" : proposal.decided_by}`);
      const op = proposal.operation;
      if (op.op === "task.dispatch") expect(stdout).toContain(op.args.task);
    } finally { await server.stop(true); }
  }
});

test("privileged proposal renders the command, runtime, task title, round and reason", async () => {
  const p = Proposal.parse({ ...proposal, operation: { op: "exec.privileged", args: { runtime: proposal.author, job: "job_00000000000000000000000001", argv: ["/bin/echo", "hello world", "$(touch x)"] } } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/actors") return Response.json([{ id: p.author, name: "server", role: "runtime", created: p.created }]);
    if (path === "/v1/proposals") return Response.json([p]);
    if (path.startsWith("/v1/jobs/")) return Response.json({ spec: { protocol_version: 2, id: "job_00000000000000000000000001", lease: "1234567890123456", runtime: p.author,
      source: { task: "task_00000000000000000000000001", round: 2 }, run: { kind: "command", argv: ["/bin/true"] }, workdir: "/", timeout_seconds: 30, created: p.created }, status: "running" });
    return Response.json({ note: { id: "task_00000000000000000000000001", type: "task", title: "安装软件", path: "plan/tasks/install.md" }, frontmatter: {}, body: "" });
  } });
  try {
    const child = Bun.spawn([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, "proposals"], { env: { ...process.env, LUMIO_HUB_URL: `http://127.0.0.1:${server.port}`, LUMIO_TOKEN: "fixture" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
    expect(out).toContain('在 server 上以 root 执行：/bin/echo "hello world" "$(touch x)"');
    expect(out).toContain("来源：安装软件 · 第 2 轮"); expect(out).toContain("理由：合成提议");
  } finally { await server.stop(true); }
});

import { isolatedHome } from "./test-home.ts";
import { expect, test } from "bun:test";
import { Job } from "@lumio/schema";
const main = new URL("../src/main.ts", import.meta.url).pathname;
const cliHome = isolatedHome();
const job = Job.parse({ spec: { protocol_version: 2, id: "job_00000000000000000000000001", runtime: "act_00000000000000000000000001", lease: "synthetic_lease_123456", run: { kind: "command", argv: ["/usr/bin/test", "--literal"] }, workdir: "~", timeout_seconds: 7200, created: "2026-01-01T00:00:00Z" }, status: "queued" });
async function cli(args: string[], url: string) {
  const child = Bun.spawn([process.execPath, main, "job", ...args], { env: { ...process.env, HOME: cliHome, LUMIO_HUB_URL: url, LUMIO_TOKEN: "synthetic-token", LUMIO_VAULT: undefined }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
test("all job CLI commands validate JSON and preserve argv; show renders offline runtime", async () => {
  const seen: { path: string; method: string; body?: unknown }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url); expect(req.headers.get("Authorization")).toBe("Bearer synthetic-token");
    seen.push({ path: url.pathname + url.search, method: req.method, ...(req.method === "POST" ? { body: await req.json() } : {}) });
    if (url.pathname === "/v1/runtimes") return Response.json([{ actor: job.spec.runtime, registration: { protocol_version: 2, name: "server", engines: [], tags: [], max_concurrent: 1 }, last_seen: job.spec.created, online: false }]);
    return Response.json(req.method === "GET" && url.pathname === "/v1/jobs" ? [job] : job);
  } });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    let result = await cli(["submit", "--runtime", "server", "--workdir", "~/x", "--timeout", "30m", "--gpus", "0,1", "--json", "--", "/usr/bin/test", "--literal", "$(touch no)"], url);
    expect(result.code).toBe(0); expect(Job.parse(JSON.parse(result.stdout))).toEqual(job);
    expect(seen.pop()).toEqual({ path: "/v1/jobs", method: "POST", body: { runtime: "server", run: { kind: "command", argv: ["/usr/bin/test", "--literal", "$(touch no)"] }, workdir: "~/x", timeout_seconds: 1800, gpus: [0, 1] } });
    result = await cli(["submit", "--runtime", "server", "--json", "--", "/usr/bin/test"], url);
    expect(result.code).toBe(0); expect(seen.pop()!.body).toMatchObject({ workdir: "~", timeout_seconds: 7200 });
    for (const action of ["show", "cancel"] as const) {
      result = await cli([action, job.spec.id, "--json"], url); expect(result.code).toBe(0); expect(Job.parse(JSON.parse(result.stdout))).toEqual(job);
      expect(seen.pop()).toEqual({ path: `/v1/jobs/${job.spec.id}${action === "cancel" ? "/cancel" : ""}`, method: action === "cancel" ? "POST" : "GET", ...(action === "cancel" ? { body: {} } : {}) });
    }
    result = await cli(["list", "--status", "queued", "--json"], url); expect(result.code).toBe(0); expect(Job.array().parse(JSON.parse(result.stdout))).toEqual([job]);
    expect(seen.pop()!.path).toBe("/v1/jobs?status=queued");
    result = await cli(["show", job.spec.id], url); expect(result.code).toBe(0); expect(result.stdout).toContain("执行器失联"); expect(result.stderr).toBe("");
    const before = seen.length;
    for (const args of [["submit", "--runtime", "server"], ["submit", "--runtime", "server", "--timeout", "0m", "--", "x"], ["submit", "--runtime", "server", "--gpus", "-1", "--", "x"], ["list", "--status", "bad"], ["list", "extra"], ["show", "missing"], ["cancel", job.spec.id, "--status", "done"]]) {
      expect((await cli(args, url)).code).toBe(1);
    }
    expect(seen.length).toBe(before);
  } finally { await server.stop(true); }
});

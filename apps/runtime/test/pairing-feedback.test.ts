import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinRuntime } from "../src/pairing.ts";
import { RuntimeJoinRequest as JoinRequest } from "@lumio/schema";
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const code = "a".repeat(26), secret = "synthetic-private-token";
async function attempt(url: string, fetcher = fetch) {
  const home = await mkdtemp(join(tmpdir(), "lumio-pair-feedback-")); homes.push(home);
  const logs: string[] = [];
  let error = "";
  try {
    await joinRuntime(["--hub", url, "--code", code], { home, env: {}, fetch: fetcher, log: (l) => logs.push(l), install: async () => { throw new Error("must not install"); } });
  } catch (cause) { error = (cause as Error).message; }
  expect(error).not.toBe(""); expect(error + logs.join("\n")).not.toContain(code); expect(error + logs.join("\n")).not.toContain(secret);
  await expect(access(join(home, ".config/lumio-runtime/runtime.env"))).rejects.toThrow();
  return error;
}
test("pairing preflight explains old versions and HTTP failures without consuming mismatched invites", async () => {
  for (const scenario of ["version", "missing-health", "missing-join", "unauthorized", "other"]) {
    const paths: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname; paths.push(path);
      expect(req.headers.has("Authorization")).toBe(false);
      if (path === "/health") return scenario === "missing-health" ? new Response(secret, { status: 404 }) : Response.json({ ok: true, version: scenario === "version" ? "0.1.0" : "0.0.0-dev" });
      expect(JoinRequest.parse(await req.json())).toEqual({ code });
      return new Response(secret, { status: scenario === "missing-join" ? 404 : scenario === "unauthorized" ? 401 : 503 });
    } });
    try {
      const error = await attempt(server.url.href.replace(/\/$/, ""));
      expect(paths[0]).toBe("/health");
      if (["version", "missing-health", "missing-join"].includes(scenario)) expect(error).toContain("请先升级 Hub");
      if (["version", "missing-health"].includes(scenario)) expect(paths).toHaveLength(1);
      if (scenario === "unauthorized") { expect(error).toContain("配对码无效、过期或已用"); expect(error).toContain("lumio runtime add <名称>"); }
      if (scenario === "other") expect(error).toContain("HTTP 503");
    } finally { await server.stop(true); }
  }
});
test("pairing distinguishes DNS, timeout, TLS and refused connections in either request", async () => {
  for (const [cause, expected] of [[{ code: "ENOTFOUND" }, "DNS"], [{ name: "TimeoutError" }, "超时"], [{ code: "CERT_HAS_EXPIRED" }, "TLS"], [{ code: "ECONNREFUSED" }, "无法连接"]] as const) {
    for (const phase of ["health", "join"]) {
      const error = await attempt("https://synthetic.example", (async (input) => {
        if (phase === "join" && String(input).endsWith("/health")) return Response.json({ ok: true, version: "0.0.0-dev" });
        throw Object.assign(new Error(secret), cause);
      }) as typeof fetch);
      expect(error).toContain(expected); expect(error).toContain("Tailscale"); expect(error).toContain("no_proxy");
    }
  }
});

test("runtime command prints the specific pairing diagnosis through its entry point", async () => {
  for (const scenario of ["version", "missing-join", "unauthorized", "other"]) {
    const home = await mkdtemp(join(tmpdir(), "lumio-pair-command-")); homes.push(home);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, version: scenario === "version" ? "0.1.0" : "0.0.0-dev" });
      return new Response(secret, { status: scenario === "missing-join" ? 404 : scenario === "unauthorized" ? 401 : 503 });
    } });
    try {
      const child = Bun.spawn([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, "join", "--hub", server.url.href, "--code", code], { env: { HOME: home }, stdout: "pipe", stderr: "pipe" });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).toBe(1); expect(out + err).not.toContain(code); expect(out + err).not.toContain(secret);
      expect(err).toContain(["version", "missing-join"].includes(scenario) ? "请先升级 Hub" : scenario === "unauthorized" ? "配对码无效、过期或已用" : "HTTP 503");
    } finally { await server.stop(true); }
  }
});

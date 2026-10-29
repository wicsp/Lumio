import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPairing } from "../src/pairing.ts";
import { ClientJoinRequest as JoinRequest, ClientJoin, CliConfig } from "@lumio/schema";
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const code = "a".repeat(26), secret = "synthetic-private-token";
test("login succeeds across versions, warns once on mismatch and saves the validated credentials", async () => {
  for (const hubVersion of ["0.1.4", "0.1.5-rc.1", "0.0.0-dev"]) {
    const home = await mkdtemp(join(tmpdir(), "lumio-login-version-")); homes.push(home);
    const joined = ClientJoin.parse({ actor: "act_00000000000000000000000001", token: secret });
    const paths: string[] = [], logs: string[] = [], warnings: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname; paths.push(path);
      if (path === "/health") return Response.json({ ok: true, version: hubVersion });
      expect(path).toBe("/v1/client/join");
      expect(JoinRequest.parse(await req.json())).toEqual({ code });
      return Response.json(joined);
    } });
    try {
      expect(await runPairing(["login", server.url.href, "--code", code], { home, log: (l) => logs.push(l), warn: (l) => warnings.push(l) })).toBe(0);
      expect(paths).toEqual(["/health", "/v1/client/join"]);
      expect(CliConfig.parse(JSON.parse(await readFile(join(home, ".config/lumio/config.json"), "utf8"))).token).toBe(joined.token);
      expect(warnings).toEqual(hubVersion === "0.0.0-dev" ? [] : [`警告：Hub 是 ${hubVersion}，本程序是 0.0.0-dev，建议保持一致`]);
      expect(logs).toEqual(["CLI 已登录"]);
      expect([...logs, ...warnings].join("\n")).not.toContain(secret);
      expect([...logs, ...warnings].join("\n")).not.toContain(code);
    } finally { await server.stop(true); }
  }
});
async function attempt(url: string, fetcher = fetch) {
  const home = await mkdtemp(join(tmpdir(), "lumio-pair-feedback-")); homes.push(home);
  const logs: string[] = [];
  let error = "";
  try {
    await runPairing(["login", url, "--code", code], { home, fetch: fetcher, log: (l) => logs.push(l), warn: (l) => logs.push(l) });
  } catch (cause) { error = (cause as Error).message; }
  expect(error).not.toBe(""); expect(error + logs.join("\n")).not.toContain(code); expect(error + logs.join("\n")).not.toContain(secret);
  await expect(access(join(home, ".config/lumio/config.json"))).rejects.toThrow();
  return error;
}
test("pairing diagnoses HTTP failures regardless of version and requests an upgrade only for a missing join endpoint", async () => {
  for (const hubVersion of ["0.1.0", "0.0.0-dev"]) for (const scenario of ["missing-health", "missing-join", "unauthorized", "other"]) {
    const paths: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname; paths.push(path);
      expect(req.headers.has("Authorization")).toBe(false);
      if (path === "/health") return scenario === "missing-health" ? new Response(secret, { status: 404 }) : Response.json({ ok: true, version: hubVersion });
      expect(JoinRequest.parse(await req.json())).toEqual({ code });
      return new Response(secret, { status: scenario === "missing-join" ? 404 : scenario === "unauthorized" ? 401 : 503 });
    } });
    try {
      const error = await attempt(server.url.href.replace(/\/$/, ""));
      expect(paths[0]).toBe("/health");
      expect(error.includes("请先升级 Hub")).toBe(scenario === "missing-join");
      expect(paths).toEqual(scenario === "missing-health" ? ["/health"] : ["/health", "/v1/client/join"]);
      if (scenario === "missing-health") expect(error).toContain("/health HTTP 404");
      if (scenario === "unauthorized") { expect(error).toContain("配对码无效、过期或已用"); expect(error).toContain("lumio login-code"); }
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

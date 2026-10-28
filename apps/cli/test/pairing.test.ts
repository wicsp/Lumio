import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliConfig, ClientInvite, ClientJoin, RuntimeInvite } from "@lumio/schema";
import { runPairing } from "../src/pairing.ts";
import { readCliConfig } from "../src/config.ts";
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function fixture() { const home = await mkdtemp(join(tmpdir(), "lumio-cli-pairing-")); homes.push(home); return { home, path: join(home, ".config/lumio/config.json") }; }
const code = "a".repeat(26), actor = "act_00000000000000000000000001";
const joined = ClientJoin.parse({ actor, token: "synthetic-client-token" });
test("login validates join, writes private config with local vault, and asks before overwrite without consuming code", async () => {
  const { home, path } = await fixture(), logs: string[] = [];
  let calls = 0;
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls++; expect(url.href).toBe("https://synthetic.example/v1/client/join"); expect(new Headers(init.headers).has("Authorization")).toBe(false); expect(init.redirect).toBe("error"); expect(JSON.parse(String(init.body))).toEqual({ code }); return Response.json(joined);
  }) as unknown as typeof fetch;
  await runPairing(["login", "https://synthetic.example/", "--code", code, "--vault", join(home, "local-vault")], { home, fetch: fetcher, log: (line) => logs.push(line) });
  const content = await readFile(path, "utf8");
  expect(CliConfig.parse(JSON.parse(content))).toEqual({ hub_url: "https://synthetic.example", token: joined.token, vault: join(home, "local-vault") });
  expect((await stat(path)).mode & 0o777).toBe(0o600); expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  await runPairing(["login", "https://synthetic.example", "--code", code], { home, fetch: fetcher, log: () => {}, confirm: async () => false }); expect(calls).toBe(1); expect(await readFile(path, "utf8")).toBe(content);
  await runPairing(["login", "https://synthetic.example", "--code", code], { home, fetch: fetcher, log: (l) => logs.push(l), confirm: async () => true }); expect(calls).toBe(2);
  expect(logs.join("\n")).not.toContain(joined.token); expect(logs.join("\n")).not.toContain(code);
  await runPairing(["logout"], { home, log: () => {} }); expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ hub_url: "https://synthetic.example" }); expect(readCliConfig({ home, env: {} }).token).toBeUndefined(); expect((await stat(path)).mode & 0o777).toBe(0o600);
});
test("runtime add supports human text and strict JSON; login-code uses a label; runtime remove sends DELETE and accepts 204", async () => {
  const { home, path } = await fixture(); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ hub_url: "https://synthetic.example", token: "synthetic-human" }), { mode: 0o600 });
  const runtime = RuntimeInvite.parse({ name: "server", actor, code, expires: "2026-10-28T00:10:00Z", hub_url: "https://synthetic.example", command: `install-command --code ${code}` });
  const client = ClientInvite.parse({ name: "cli@synthetic", code, expires: runtime.expires, hub_url: runtime.hub_url, command: `lumio login https://synthetic.example --code ${code}` });
  const requests: string[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    requests.push(url.pathname); expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-human");
    if (init.method === "DELETE") { expect(url.pathname).toBe("/v1/runtimes/server"); return new Response(null, { status: 204 }); }
    expect(JSON.parse(String(init.body))).toEqual({ name: url.pathname.includes("runtime") ? "server" : "cli@synthetic" }); return Response.json(url.pathname.includes("runtime") ? runtime : client);
  }) as unknown as typeof fetch;
  const logs: string[] = [], options = { home, fetch: fetcher, log: (l: string) => logs.push(l) };
  await runPairing(["runtime", "add", "server"], options); expect(logs.shift()).toContain("10 分钟"); expect(logs.shift()).toBe(runtime.command);
  await runPairing(["runtime", "add", "server", "--json"], options); expect(RuntimeInvite.parse(JSON.parse(logs.shift()!))).toEqual(runtime);
  await runPairing(["login-code", "--name", "cli@synthetic"], options); expect(logs.shift()).toBe(client.command);
  await runPairing(["runtime", "remove", "server"], options); expect(logs.shift()).toContain("吊销");
  expect(requests).toEqual(["/v1/runtime-invites", "/v1/runtime-invites", "/v1/client-invites", "/v1/runtimes/server"]);
});
test("login failures keep existing config and hide untrusted response data", async () => {
  const { home, path } = await fixture(); await mkdir(dirname(path), { recursive: true }); const old = '{"hub_url":"https://synthetic.example","token":"old-token"}'; await writeFile(path, old);
  for (const body of [{ private: "sensitive-response" }, { actor, token: "secret", extra: true }]) {
    await expect(runPairing(["login", "https://synthetic.example", "--code", code], { home, confirm: async () => true, fetch: (async () => Response.json(body)) as unknown as typeof fetch })).rejects.toThrow("Hub 返回了不合法的响应");
    expect(await readFile(path, "utf8")).toBe(old);
  }
});

const script = Bun.which("script");
// 只在 Linux 上用 script 自动验证；macOS 由人工在真实终端验证（PR #46）。
test.skipIf(!script || process.platform !== "linux")("lumio login asks the overwrite question on the real terminal even when stdin is a pipe (P2-11)", async () => {
  const { home, path } = await fixture();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ hub_url: "http://127.0.0.1:1", token: "old-token" }), { mode: 0o600 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(joined) });
  try {
    const main = new URL("../src/main.ts", import.meta.url).pathname;
    const command = `echo piped | HOME=${JSON.stringify(home)} ${JSON.stringify(process.execPath)} ${JSON.stringify(main)} login http://127.0.0.1:${server.port} --code ${code}`;
    const args = process.platform === "darwin" ? [script!, "-q", "/dev/null", "sh", "-c", command] : [script!, "-q", "-e", "-c", command, "/dev/null"];
    const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    await Bun.sleep(1500); child.stdin.write("yes\n"); child.stdin.flush(); child.stdin.end();
    const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exit).toBe(0);
    expect(output).toContain("覆盖？输入 yes");
    expect(CliConfig.parse(JSON.parse(await readFile(path, "utf8"))).token).toBe("synthetic-client-token");
  } finally { await server.stop(true); }
}, 30_000);

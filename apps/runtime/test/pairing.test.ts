import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeJoin } from "@lumio/schema";
import { environmentText, joinRuntime } from "../src/pairing.ts";
import { parseEnvironment } from "../src/service.ts";
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function fixture() { const home = await mkdtemp(join(tmpdir(), "lumio-join-")); homes.push(home); return { home, path: join(home, ".config/lumio-runtime/runtime.env") }; }
const joined = RuntimeJoin.parse({ name: "synthetic", actor: "act_00000000000000000000000001", token: "synthetic-new-token" });
const code = "a".repeat(26);
test("join validates both contracts, persists private env and current shell PATH, preserves settings and installs service", async () => {
  const { home, path } = await fixture();
  await mkdir(join(home, ".config/lumio-runtime"), { recursive: true });
  const previous = { LUMIO_RUNTIME_TAGS: "lab,gpu:4", LUMIO_RUNTIME_ALLOWED_COMMANDS: "/bin/echo", LUMIO_RUNTIME_SUDO_COMMAND: "/usr/bin/sudo -n /helper", LUMIO_RUNTIME_STATE_DIR: join(home, "custom-state"), PATH: "/old", LUMIO_TOKEN: "old-token" };
  await writeFile(path, environmentText(previous), { mode: 0o666 }); await chmod(path, 0o666);
  const logs: string[] = []; let installed = false;
  const fetcher = (async (url: string, init: RequestInit) => {
    expect(url).toBe("http://synthetic.example/v1/runtime/join"); expect(init.redirect).toBe("error"); expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ code }); return Response.json(joined);
  }) as unknown as typeof fetch;
  await joinRuntime(["--hub", "http://synthetic.example/", "--code", code], { home, env: { PATH: '/agents/with spaces:$HOME:`literal`:"quoted":\\bin' }, fetch: fetcher, log: (l) => logs.push(l), install: async (opts) => { expect(opts.home).toBe(home); installed = true; } });
  const values = parseEnvironment(await readFile(path, "utf8"));
  expect(values).toEqual({ ...previous, LUMIO_HUB_URL: "http://synthetic.example", LUMIO_RUNTIME_NAME: joined.name, LUMIO_TOKEN: joined.token, PATH: '/agents/with spaces:$HOME:`literal`:"quoted":\\bin' });
  expect((await stat(path)).mode & 0o777).toBe(0o600); expect((await stat(join(home, ".config/lumio-runtime"))).mode & 0o777).toBe(0o700); expect(installed).toBe(true);
  expect(logs.join("\n")).toContain("明文"); expect(logs.join("\n")).not.toContain(joined.token); expect(logs.join("\n")).not.toContain(code);
});
test("fresh join uses absolute default state, loopback HTTP is quiet, bad responses and redirects never print secrets", async () => {
  const { home, path } = await fixture(); const logs: string[] = [];
  await joinRuntime(["--hub", "http://127.0.0.1:7420", "--code", code], { home, env: { PATH: "/test/path" }, fetch: (async () => Response.json(joined)) as unknown as typeof fetch, log: (l) => logs.push(l), install: async () => {} });
  expect(parseEnvironment(await readFile(path, "utf8")).LUMIO_RUNTIME_STATE_DIR).toBe(join(home, ".local/share/lumio-runtime")); expect(logs).toEqual([]);
  const existing = await readFile(path, "utf8");
  for (const fetcher of [(async () => Response.json({ token: "sensitive-response" })) as unknown as typeof fetch, (async () => { throw new Error("sensitive-response"); }) as unknown as typeof fetch, (async () => Response.json({ private: "sensitive-response" }, { status: 401 })) as unknown as typeof fetch]) {
    await expect(joinRuntime(["--hub", "https://synthetic.example", "--code", code], { home, fetch: fetcher, install: async () => { throw new Error("must not install"); } })).rejects.toThrow("执行器配对失败");
    expect(await readFile(path, "utf8")).toBe(existing);
  }
  for (const args of [["--hub", "file:///tmp", "--code", code], ["--hub", "https://example.org", "--code", "invalid"], ["--unknown", code]]) await expect(joinRuntime(args, { home })).rejects.toThrow();
});

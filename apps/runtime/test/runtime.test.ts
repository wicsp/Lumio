import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeHeartbeat, RuntimeInfo, RuntimeRegistration } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { detectEngines, parseVersion } from "../src/engines.ts";
import { runRuntime } from "../src/runtime.ts";

const env = { LUMIO_HUB_URL: "http://127.0.0.1:7420/", LUMIO_TOKEN: "synthetic-secret-token", LUMIO_RUNTIME_NAME: "server" };
test("runtime config uses required environment, defaults and schema constraints without exposing secrets", () => {
  const config = readConfig(env);
  expect(config).toMatchObject({ url: "http://127.0.0.1:7420", pollSeconds: 5, stateDir: join(homedir(), ".local/share/lumio-runtime"),
    registration: { protocol_version: 2, name: "server", engines: [], tags: [], max_concurrent: 1 } });
  expect(readConfig({ ...env, LUMIO_RUNTIME_TAGS: "gpu:4, lab", LUMIO_RUNTIME_MAX_CONCURRENT: "4", LUMIO_RUNTIME_POLL_SECONDS: "0.1" }))
    .toMatchObject({ pollSeconds: 0.1, registration: { tags: ["gpu:4", "lab"], max_concurrent: 4 } });
  for (const override of [
    { LUMIO_HUB_URL: undefined }, { LUMIO_TOKEN: "" }, { LUMIO_RUNTIME_NAME: undefined }, { LUMIO_RUNTIME_NAME: "Bad Name" },
    { LUMIO_RUNTIME_MAX_CONCURRENT: "1.5" }, { LUMIO_RUNTIME_MAX_CONCURRENT: "0" }, { LUMIO_RUNTIME_TAGS: "bad tag" },
    { LUMIO_HUB_URL: `http://user:${env.LUMIO_TOKEN}@localhost` }, { LUMIO_HUB_URL: "file:///tmp" }, { LUMIO_HUB_URL: "bad" },
    { LUMIO_HUB_URL: "http://localhost/?query=bad" }, { LUMIO_RUNTIME_POLL_SECONDS: "0" }, { LUMIO_RUNTIME_POLL_SECONDS: "NaN" },
    { LUMIO_RUNTIME_POLL_SECONDS: "2147484" }, { LUMIO_RUNTIME_STATE_DIR: "" },
  ]) {
    try { readConfig({ ...env, ...override }); throw new Error("expected failure"); }
    catch (cause) { expect(cause).toMatchObject({ code: "INVALID" }); expect(String(cause)).not.toContain(env.LUMIO_TOKEN); }
  }
});

test("agent version parsing accepts actual CLI forms and rejects unknown output", () => {
  for (const [output, version] of [["codex-cli 0.42.0\n", "0.42.0"], ["2.0.1 (Claude Code)", "2.0.1"], ["0.50.1", "0.50.1"], ["pi v1.2.3-beta.1+build", "1.2.3-beta.1+build"]]) {
    expect(parseVersion(output!)).toBe(version);
  }
  for (const output of ["", "unknown", "error 1.2.3", "1.2", "1.2.3garbage"]) expect(parseVersion(output)).toBeUndefined();
});

test("agent detection runs only --version; excludes missing, unparseable, failed and timed-out commands", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lumio-engines-"));
  async function executable(name: string, source: string) {
    const path = join(temp, name);
    await writeFile(path, `#!${process.execPath}\nif (process.argv[2] !== '--version' || process.argv.length !== 3) process.exit(2);\n${source}\n`);
    await chmod(path, 0o700);
  }
  try {
    expect(await detectEngines({ PATH: temp })).toEqual([]);
    await executable("codex", 'console.log("codex-cli 0.42.0")');
    await executable("claude", 'console.log("2.0.1 (Claude Code)")');
    await executable("pi", 'console.log("0.50.1")');
    const engines = await detectEngines({ PATH: temp });
    expect(engines).toEqual([{ name: "codex", version: "0.42.0", sandbox: "os" },
      { name: "claude-code", version: "2.0.1", sandbox: "none" }, { name: "pi", version: "0.50.1", sandbox: "none" }]);
    RuntimeRegistration.parse({ ...readConfig(env).registration, engines });
    await executable("codex", 'console.log("unparseable")');
    await executable("claude", 'console.log("2.0.1"); process.exit(1)');
    await executable("pi", 'setInterval(() => {}, 1000)');
    const start = performance.now();
    expect(await detectEngines({ PATH: temp })).toEqual([]);
    expect(performance.now() - start).toBeLessThan(13_000);
  } finally { await rm(temp, { recursive: true, force: true }); }
}, 15_000);

test("runtime retries exponentially up to 60 seconds, registers again, sends empty heartbeats and sanitizes logs", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lumio-retry-"));
  const controller = new AbortController(), delays: number[] = [], paths: string[] = [], logs: string[] = [];
  const config = readConfig({ ...env, LUMIO_RUNTIME_STATE_DIR: temp });
  let calls = 0;
  try {
    await runRuntime(config, { signal: controller.signal, env: { PATH: temp }, log: (line) => logs.push(line),
      fetch: (async (url: string, init: RequestInit) => {
        paths.push(new URL(url).pathname);
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${env.LUMIO_TOKEN}`);
        if (++calls <= 6 || calls === 9) throw new Error(env.LUMIO_TOKEN);
        if (url.endsWith("/register")) {
          const registration = RuntimeRegistration.parse(JSON.parse(String(init.body)));
          return Response.json(RuntimeInfo.parse({ actor: "act_00000000000000000000000001", registration, last_seen: "2026-01-01T00:00:00Z", online: true }));
        }
        expect(RuntimeHeartbeat.parse(JSON.parse(String(init.body)))).toEqual({ running: [], queued: [], outbox: 0 });
        return Response.json({ jobs: [], cancel: [], routines: [] });
      }) as typeof fetch,
      sleep: async (milliseconds) => { delays.push(milliseconds); if (delays.length === 11) controller.abort(); },
    });
    expect(delays).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 5000, 5000, 5000, 5000, 5000]);
    expect(paths.slice(6)).toEqual(["/v1/runtime/register", "/v1/runtime/sync", "/v1/runtime/sync", "/v1/runtime/register", "/v1/runtime/sync"]);
    expect(logs).toEqual(["Hub 连接失联，正在重试", "执行器登记成功", "Hub 连接已恢复", "Hub 连接失联，正在重试", "执行器登记成功", "Hub 连接已恢复"]);
    expect(logs.join("\n")).not.toContain(env.LUMIO_TOKEN);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

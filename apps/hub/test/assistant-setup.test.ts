import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantConfiguration, type AssistantSetupOptions } from "../src/assistant-setup.ts";
import { environmentText, hubPlist, parseEnvironment } from "../src/setup.ts";
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function fixture(platform = "darwin") {
  const home = await mkdtemp(join(tmpdir(), "lumio-assistant-")); homes.push(home);
  const commands: string[][] = [], logs: string[] = [], secret = "synthetic-private-api-key";
  const env = { LUMIO_TOKEN: "synthetic-token", PATH: "/synthetic/bin", LUMIO_VAULT: join(home, "synthetic-vault") };
  await mkdir(join(home, ".config/lumio"), { recursive: true });
  const path = join(home, ".config/lumio/hub.env"); await writeFile(path, environmentText(env));
  const options: AssistantSetupOptions = { home, platform, uid: 123, log: line => logs.push(line), key: async () => secret,
    run: async argv => { commands.push(argv); return { code: 0, stdout: secret, stderr: secret }; } };
  return { home, path, options, secret, env, commands, logs };
}
const args = ["setup", "--base-url", "http://127.0.0.1:8080/v1", "--model", "synthetic-model", "--api-key-stdin"];
test("minimal HTTP validation, private atomic environment, launchd reload, status and clear preserve unrelated values", async () => {
  const f = await fixture();
  const service = join(f.home, "Library/LaunchAgents/io.lumio.hub.plist"); await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true });
  await writeFile(service, hubPlist("/synthetic/lumio-hub", f.env, "/synthetic/state"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe(`Bearer ${f.secret}`);
    expect(await request.json()).toEqual({ model: "synthetic-model", stream: false, messages: [{ role: "user", content: "ping" }] });
    return Response.json({ choices: [{ message: { role: "assistant", content: "pong" } }] });
  } });
  try {
    await assistantConfiguration(["setup", "--base-url", `${server.url}v1`, "--model", "synthetic-model", "--api-key-stdin"], { ...f.options, stdin: async () => f.secret + "\n" });
    expect(parseEnvironment(await readFile(f.path, "utf8"))).toMatchObject({ ...f.env, LUMIO_ASSISTANT_API_KEY: f.secret, LUMIO_ASSISTANT_MODEL: "synthetic-model" });
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.home, ".config/lumio"))).mode & 0o777).toBe(0o700);
    expect(await readFile(service, "utf8")).toContain(f.secret);
    expect(f.commands).toContainEqual(["launchctl", "bootstrap", "gui/123", service]);
    await assistantConfiguration(["status"], f.options); expect(f.logs.join("\n")).toContain("密钥：已设置");
    await assistantConfiguration(["clear"], f.options);
    expect(parseEnvironment(await readFile(f.path, "utf8"))).toEqual(f.env);
    expect(await readFile(service, "utf8")).not.toContain(f.secret);
    await assistantConfiguration(["status"], f.options); expect(f.logs.join("\n")).toContain("密钥：未设置");
    expect(f.logs.join("\n")).not.toContain(f.secret);
  } finally { await server.stop(true); }
});
test("validation succeeds on a compatible endpoint that rejects max_tokens", async () => {
  const f = await fixture(); let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++;
    const body = await request.json() as Record<string, unknown>;
    if (Object.hasOwn(body, "max_tokens")) return Response.json({ error: "unsupported max_tokens" }, { status: 400 });
    return Response.json({ choices: [{ message: { role: "assistant", content: "pong" } }] });
  } });
  try {
    await assistantConfiguration(["setup", "--base-url", server.url.href, "--model", "synthetic-reasoning", "--api-key-stdin"], { ...f.options, stdin: async () => f.secret });
    expect(requests).toBe(1);
    expect(parseEnvironment(await readFile(f.path, "utf8"))).toMatchObject({ LUMIO_ASSISTANT_MODEL: "synthetic-reasoning", LUMIO_ASSISTANT_API_KEY: f.secret });
  } finally { await server.stop(true); }
});
test("401/403, 404, other 4xx, 5xx, invalid success and timeout never write or restart, nor echo errors", async () => {
  for (const [status, message] of [[401, "鉴权"], [403, "鉴权"], [404, "地址或模型"], [400, "4xx"], [503, "5xx"], [200, "响应"]] as const) {
    const f = await fixture(), before = await readFile(f.path, "utf8");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(f.secret, { status }) });
    try {
      await expect(assistantConfiguration(["setup", "--base-url", server.url.href, "--model", "synthetic-model", "--api-key-stdin"], { ...f.options, stdin: async () => f.secret })).rejects.toThrow(message);
      expect(await readFile(f.path, "utf8")).toBe(before); expect(f.commands).toHaveLength(0); expect(f.logs.join("\n")).not.toContain(f.secret);
    } finally { await server.stop(true); }
  }
  const f = await fixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => { await Bun.sleep(100); return Response.json({}); } });
  try {
    await expect(assistantConfiguration(["setup", "--base-url", server.url.href, "--model", "synthetic", "--api-key-stdin"], { ...f.options, stdin: async () => f.secret, timeoutMs: 10 })).rejects.toThrow("超时");
    expect(parseEnvironment(await readFile(f.path, "utf8"))).toEqual(f.env);
  } finally { await server.stop(true); }
});
test("skip-check, Linux restart, unmanaged instructions, invalid inputs and failed restart", async () => {
  const f = await fixture("linux");
  await mkdir(join(f.home, ".config/systemd/user"), { recursive: true }); await writeFile(join(f.home, ".config/systemd/user/lumio-hub.service"), "synthetic");
  const options = { ...f.options, stdin: async () => f.secret, fetch: (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch };
  await assistantConfiguration([...args, "--skip-check"], options);
  expect(f.commands).toEqual([["systemctl", "--user", "restart", "lumio-hub.service"]]);
  await expect(assistantConfiguration(["clear"], { ...f.options, run: async () => ({ code: 1, stdout: f.secret, stderr: f.secret }) })).rejects.toThrow("重启失败");
  const unmanaged = await fixture(); await assistantConfiguration([...args, "--skip-check"], { ...unmanaged.options, stdin: async () => "" });
  expect(unmanaged.logs.join("\n")).toContain("手动重启");
  for (const invalid of [["setup", "--api-key", f.secret], ["status", "--model", "x"], ["setup", "--base-url", "http://user:secret@invalid", "--model", "m", "--skip-check"]]) {
    await expect(assistantConfiguration(invalid, f.options)).rejects.toThrow();
  }
  await expect(assistantConfiguration(args, { ...f.options, stdin: async () => "synthetic\nextra" })).rejects.toThrow("换行");
});

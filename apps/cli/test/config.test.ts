import { afterEach, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliConfig } from "@lumio/schema";
import { hubCredentials, localVault, readCliConfig, setupHint } from "../src/config.ts";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "lumio-cli-config-")); homes.push(home);
  const path = join(home, ".config/lumio/config.json"); await mkdir(join(home, ".config/lumio"), { recursive: true });
  const config = CliConfig.parse({ hub_url: "http://127.0.0.1:7420", token: "synthetic-token", vault: join(home, "vault") });
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return { home, path, config };
}
test("configuration uses strict CliConfig, environment overrides individual fields, and permissions warn without secrets", async () => {
  const { home, path, config } = await fixture();
  expect(readCliConfig({ home, env: {} })).toEqual({ url: config.hub_url, token: config.token, vault: config.vault });
  expect(readCliConfig({ home, env: { LUMIO_HUB_URL: "http://example.org", LUMIO_VAULT: "/synthetic" } })).toEqual({ url: "http://example.org", token: config.token, vault: "/synthetic" });
  const warnings: string[] = []; await chmod(path, 0o644);
  expect(readCliConfig({ home, env: {}, warn: (line) => warnings.push(line) }).token).toBe(config.token);
  expect(warnings.join("\n")).toContain("chmod 600"); expect(warnings.join("\n")).not.toContain(config.token);
  for (const content of [JSON.stringify({ ...config, extra: true }), '{"token":"secret-broken"}']) {
    await writeFile(path, content);
    expect(() => readCliConfig({ home, env: {} })).toThrow("配置格式不合法");
    try { readCliConfig({ home, env: {} }); } catch (cause) { expect(String(cause)).not.toContain("secret-broken"); }
  }
  await writeFile(path, "{broken"); expect(() => readCliConfig({ home, env: {} })).toThrow("配置无法解析");
  await rm(path); expect(readCliConfig({ home, env: {} })).toEqual({ url: undefined, token: undefined, vault: undefined });
  expect(() => hubCredentials({})).toThrow(setupHint); expect(() => localVault(undefined, {})).toThrow(setupHint);
  expect(localVault("/explicit", { vault: "/file" })).toBe("/explicit");
});
test("new, sync, export bib and authenticated queries work with only the configuration file", async () => {
  const { home, path, config } = await fixture();
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, config.vault!, { recursive: true });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(request.headers.get("authorization")).toBe(`Bearer ${config.token}`);
    return Response.json([]);
  } });
  await writeFile(path, JSON.stringify({ ...config, hub_url: server.url.href }));
  try {
    for (const args of [["--version"], ["new", "idea", "配置里的笔记"], ["sync", "--dry-run"], ["export", "bib"], ["runtime", "list", "--json"]]) {
      const child = Bun.spawn([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, ...args], {
        env: { ...process.env, HOME: home, LUMIO_VAULT: undefined, LUMIO_HUB_URL: undefined, LUMIO_TOKEN: undefined }, stdout: "pipe", stderr: "pipe",
      });
      const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0);
      if (args[0] === "--version") expect(out.trim()).toBe("0.0.0-dev");
      if (args[0] === "runtime") { expect(out.trim()).toBe("[]"); expect(error).toBe(""); }
    }
    expect(await readFile(join(config.vault!, "research/ideas/配置里的笔记.md"), "utf8")).toContain("配置里的笔记");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally { await server.stop(true); }
});

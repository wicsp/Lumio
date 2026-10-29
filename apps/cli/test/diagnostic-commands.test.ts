import { expect, test } from "bun:test";
import { isolatedHome } from "./test-home.ts";
const home = isolatedHome();
async function command(app: "cli" | "runtime", args: string[]) {
  const main = new URL(`../../${app}/src/main.ts`, import.meta.url).pathname;
  const p = Bun.spawn([process.execPath, main, ...args], { env: { HOME: home, PATH: "" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}
test("doctor commands return structured failures and exit 1 when installation is missing", async () => {
  for (const app of ["cli", "runtime"] as const) {
    const result = await command(app, ["doctor", "--json"]);
    expect(result.code).toBe(1); expect(result.stderr).toBe("");
    const checks = JSON.parse(result.stdout) as { name: string; ok: boolean; fix?: string }[];
    expect(checks.length).toBeGreaterThan(3); expect(checks.filter((c) => !c.ok).every((c) => c.fix)).toBe(true);
    expect((await command(app, ["doctor", "extra"])).code).toBe(1);
    expect((await command(app, ["upgrade", "--version", "bad"])).code).toBe(1);
  }
  const result = await command("cli", ["selftest", "--json"]);
  expect(result.code).toBe(1); expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout)[0]).toMatchObject({ name: "自检配置", ok: false, elapsed_ms: 0 });
});

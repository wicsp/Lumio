import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeInfo } from "@lumio/schema";
import { installService, parseEnvironment, runtimeEnvironment, runtimeUnit } from "../src/service.ts";
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "lumio-runtime-service-")); homes.push(home);
  const state = join(home, ".local/share/lumio-runtime");
  await mkdir(join(home, ".config/lumio-runtime"), { recursive: true });
  await writeFile(join(home, ".config/lumio-runtime/runtime.env"), `LUMIO_HUB_URL="http://127.0.0.1:7420"\nLUMIO_TOKEN="synthetic-token"\nLUMIO_RUNTIME_NAME="synthetic"\nLUMIO_RUNTIME_STATE_DIR="${state}"\nPATH="/synthetic/agents:/usr/bin:/bin"\n`, { mode: 0o600 });
  const info = RuntimeInfo.parse({ actor: "act_00000000000000000000000001", registration: { protocol_version: 2, name: "synthetic", engines: [{ name: "codex", version: "0.163.0", sandbox: "os" }], tags: [], max_concurrent: 1 }, last_seen: new Date().toISOString(), online: true });
  return { home, state, info };
}
test("install-service writes launchd and systemd configurations, waits for registration and reports detected agents", async () => {
  for (const platform of ["darwin", "linux"]) {
    const { home, state, info } = await fixture(); const commands: string[][] = [], logs: string[] = [];
    await installService({ home, platform, binary: join(home, "bin/lumio-runtime"), uid: 123, user: "synthetic", log: (line) => logs.push(line), run: async (argv) => {
      commands.push(argv);
      if (argv.includes("bootstrap") || argv.includes("enable")) await writeFile(join(state, "registered.json"), JSON.stringify(info));
      return { code: 0, stdout: "Linger=no", stderr: "" };
    } });
    const content = await readFile(join(home, platform === "darwin" ? "Library/LaunchAgents/io.lumio.runtime.plist" : ".config/systemd/user/lumio-runtime.service"), "utf8");
    expect(content).toContain(home + "/bin/lumio-runtime"); expect(content).not.toContain("~");
    if (platform === "darwin") { expect(content).toContain("/synthetic/agents"); expect(content).toContain("runtime.err.log"); expect(content).toContain("io.lumio.runtime"); }
    else { expect(content).toContain("Restart=always"); expect(content).toContain("EnvironmentFile="); expect(commands).toContainEqual(["systemctl", "--user", "restart", "lumio-runtime.service"]); expect(logs.join("\n")).toContain("loginctl enable-linger synthetic"); }
    expect((await stat(state)).mode & 0o777).toBe(0o700); expect(logs.join("\n")).toContain("codex 0.163.0"); expect(logs.join("\n")).not.toContain("synthetic-token");
  }
});
test("no systemd prints a manual fallback; stale registration is ignored and timeout identifies logs", async () => {
  const { home, state, info } = await fixture(); const logs: string[] = [];
  await installService({ home, platform: "linux", log: (line) => logs.push(line), run: async () => ({ code: 1, stdout: "", stderr: "" }) });
  expect(logs.join("\n")).toContain("nohup"); expect(logs.join("\n")).toContain("@reboot");
  await writeFile(join(state, "registered.json"), JSON.stringify(info)); let time = 0;
  await expect(installService({ home, platform: "linux", now: () => time, sleep: async (ms) => { time += ms; }, log: () => {}, run: async () => ({ code: 0, stdout: "Linger=yes", stderr: "" }) })).rejects.toThrow("journalctl");
});
test("daemon loads runtime.env with explicit environment taking precedence, and systemd escapes percent specifiers", async () => {
  const { home } = await fixture(); const env = await runtimeEnvironment(home, { LUMIO_RUNTIME_NAME: "override" });
  expect(env.LUMIO_TOKEN).toBe("synthetic-token"); expect(env.LUMIO_RUNTIME_NAME).toBe("override"); expect(env.PATH).toBe("/synthetic/agents:/usr/bin:/bin");
  expect(parseEnvironment('A="a\\$b\\`c\\\\d\\\"e"\n')).toEqual({ A: 'a$b`c\\d"e' });
  expect(runtimeUnit("/a%/runtime", "/b%/runtime.env")).toContain("/a%%/runtime");
});

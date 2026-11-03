import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { switchLegacy, type SwitchOptions } from "../src/switch.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(platform = "linux") {
  const home = await mkdtemp(join(tmpdir(), "lumio-switch-")); roots.push(home);
  const files: Record<string, string> = {
    ".config/lumio/config.json": JSON.stringify({ hub_url: "http://127.0.0.1:7420", token: "synthetic" }),
    ".config/lumio/hub.env": `LUMIO_STATE_DIR="${home}/hub-state"\nLUMIO_VAULT="${home}/synthetic-vault"`,
    ".config/lumio-runtime/runtime.env": `LUMIO_RUNTIME_STATE_DIR="${home}/custom-runtime-state"`,
  };
  for (const service of ["hub", "runtime"]) files[platform === "darwin" ? `Library/LaunchAgents/io.lumio.${service}.plist` : `.config/systemd/user/lumio-${service}.service`] = "synthetic managed service";
  for (const [name, content] of Object.entries(files)) { await mkdir(join(home, name, ".."), { recursive: true }); await writeFile(join(home, name), content); }
  const commands: string[][] = [], steps: string[] = [];
  const options: SwitchOptions = { home, platform, binary: join(home, "bin/lumio-hub"), uid: 123, env: {}, log: line => steps.push(line),
    ready: async () => {},
    run: async argv => { commands.push(argv); return { code: 0, stdout: "synthetic-never-print", stderr: "synthetic-never-print" }; },
    retire: async (vault, state) => { commands.push(["retire", vault, state]); },
  };
  return { home, options, commands, steps };
}
test("switch uses saved state paths and managed services in the specified order", async () => {
  for (const platform of ["darwin", "linux"]) {
    const f = await fixture(platform); await switchLegacy(["--retire-legacy"], f.options);
    expect(f.commands).toHaveLength(7);
    expect(f.commands[2]).toEqual([join(f.home, "bin/lumio-runtime"), "prepare-migration", "--state-dir", join(f.home, "custom-runtime-state")]);
    expect(f.commands[3]).toEqual(["retire", join(f.home, "synthetic-vault"), join(f.home, "hub-state")]);
    expect(f.commands[6]).toEqual([join(f.home, "bin/lumio"), "doctor"]);
    expect(f.steps.join("\n")).not.toContain("synthetic-never-print");
  }
});
test("each failing switch step stops immediately and explains completed steps and recovery; unmanaged installs do nothing", async () => {
  for (let failure = 0; failure < 7; failure++) {
    const f = await fixture(); let count = 0;
    const fail = () => count++ === failure;
    await expect(switchLegacy(["--retire-legacy"], { ...f.options,
      ready: async () => {},
    run: async argv => { f.commands.push(argv); return { code: fail() ? 1 : 0, stdout: "", stderr: "synthetic-secret" }; },
      retire: async () => { if (fail()) throw new Error("synthetic-secret"); },
    })).rejects.toThrow("已完成：");
    expect(count).toBe(failure + 1);
  }
  const f = await fixture(); await rm(join(f.home, ".config/systemd/user/lumio-runtime.service"));
  await expect(switchLegacy(["--retire-legacy"], f.options)).rejects.toThrow("手动停止"); expect(f.commands).toEqual([]);
});
test("macOS switch continues when Hub, Runtime or both are already unloaded", async () => {
  for (const unloaded of [["hub"], ["runtime"], ["hub", "runtime"]]) {
    const f = await fixture("darwin");
    await switchLegacy(["--retire-legacy"], { ...f.options, run: async argv => {
      f.commands.push(argv);
      const missing = unloaded.some(name => argv.at(-1)?.includes(`io.lumio.${name}`));
      if (argv.includes("bootout") && missing) return { code: 5, stdout: "", stderr: "Boot-out failed: 5: Input/output error" };
      if (argv.includes("print") && missing) return { code: 113, stdout: "", stderr: "Could not find service in domain for user gui: 123" };
      return { code: 0, stdout: "", stderr: "" };
    } });
    for (const name of unloaded) expect(f.commands).toContainEqual(["launchctl", "print", `gui/123/io.lumio.${name}`]);
    expect(f.commands.filter(argv => argv[0] === "retire")).toHaveLength(1);
    expect(f.commands.at(-1)).toEqual([join(f.home, "bin/lumio"), "doctor"]);
    expect(f.steps.at(-1)).toContain("切换完成");
  }
});
test("macOS switch does not ignore a failed stop while the service is still loaded or cannot be inspected", async () => {
  for (const inspectable of [true, false]) {
    const f = await fixture("darwin");
    await expect(switchLegacy(["--retire-legacy"], { ...f.options, run: async argv => {
      f.commands.push(argv);
      return { code: argv.includes("print") && inspectable ? 0 : 1, stdout: "", stderr: "synthetic permission failure" };
    } })).rejects.toThrow("停止服务未成功");
    expect(f.commands).toHaveLength(2);
    expect(f.commands[1]).toEqual(["launchctl", "print", "gui/123/io.lumio.hub"]);
    expect(f.steps).toEqual(["切换：停止 Hub"]);
  }
});

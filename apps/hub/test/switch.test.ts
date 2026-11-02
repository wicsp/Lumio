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

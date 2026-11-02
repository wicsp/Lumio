import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgrade } from "../src/upgrade.ts";
const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
const names = ["lumio", "lumio-hub", "lumio-runtime"];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "lumio-upgrade-test-")); roots.push(home);
  const archiveDir = join(home, "archive"), bin = join(home, ".local/bin");
  await mkdir(archiveDir); await mkdir(bin, { recursive: true });
  for (const name of names) {
    await writeFile(join(archiveDir, name), '#!/bin/sh\nprintf "2.3.4\\n"\n', { mode: 0o755 });
    await writeFile(join(bin, name), '#!/bin/sh\nprintf "1.0.0\\n"\n', { mode: 0o755 });
  }
  const file = join(home, "release.tar.gz");
  async function pack() { const child = Bun.spawn(["tar", "-czf", file, "-C", archiveDir, ...names]); expect(await child.exited).toBe(0); }
  await pack();
  let corrupt = false, duplicate = false, health = "1.0.0", restarts = 0;
  const requests: string[] = [], commands: string[][] = [], logs: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname; requests.push(path);
    if (path === "/health") return Response.json({ ok: true, version: health });
    const bytes = await readFile(file), hash = createHash("sha256").update(bytes).digest("hex");
    if (path.endsWith("SHA256SUMS")) return new Response(`${corrupt ? "0".repeat(64) : hash}  lumio-linux-x64.tar.gz\n`.repeat(duplicate ? 2 : 1));
    return new Response(bytes);
  } });
  const url = server.url.href.replace(/\/$/, "");
  await mkdir(join(home, ".config/lumio"), { recursive: true }); await mkdir(join(home, ".config/systemd/user"), { recursive: true });
  await writeFile(join(home, ".config/lumio/config.json"), JSON.stringify({ hub_url: url, token: "synthetic" }));
  for (const service of ["hub", "runtime"]) await writeFile(join(home, `.config/systemd/user/lumio-${service}.service`), "synthetic");
  const options = { home, env: {}, platform: "linux", arch: "x64", releaseBase: url, log: (l: string) => logs.push(l),
    run: async (argv: string[]) => {
      commands.push(argv);
      if (argv[0] === "systemctl" || argv[0] === "launchctl") { restarts++; health = "2.3.4"; return { code: 0, stdout: "", stderr: "" }; }
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr };
    } };
  return { home, bin, archiveDir, pack, server, options, commands, logs, requests, setCorrupt: () => { corrupt = true; }, setDuplicate: () => { duplicate = true; }, restarts: () => restarts };
}
test("upgrade verifies a local HTTP Release, replaces all binaries, restarts local services and waits for the new health version", async () => {
  const f = await fixture();
  try {
    await upgrade({ ...f.options, version: "v2.3.4" });
    expect(f.requests).toContain("/download/v2.3.4/lumio-linux-x64.tar.gz"); expect(f.requests).toContain("/health");
    expect(f.commands).toContainEqual(["systemctl", "--user", "restart", "lumio-hub.service"]); expect(f.restarts()).toBe(2);
    for (const name of names) { expect(await readFile(join(f.bin, name), "utf8")).toContain("2.3.4"); expect((await lstat(join(f.bin, name))).mode & 0o777).toBe(0o755); }
    const before = f.restarts(); await upgrade(f.options); expect(f.restarts()).toBe(before); expect(f.logs.at(-1)).toContain("已是最新版本 2.3.4");
  } finally { await f.server.stop(true); }
});
test("upgrade leaves installed programs unchanged on checksum, duplicate sum, archive or version failures", async () => {
  for (const mode of ["checksum", "duplicate", "symlink", "version"] as const) {
    const f = await fixture();
    try {
      if (mode === "checksum") f.setCorrupt();
      if (mode === "duplicate") f.setDuplicate();
      if (mode === "symlink") { await rm(join(f.archiveDir, "lumio")); await symlink("/etc/passwd", join(f.archiveDir, "lumio")); await f.pack(); }
      await expect(upgrade({ ...f.options, ...(mode === "version" ? { version: "v9.9.9" } : {}) })).rejects.toThrow();
      expect(f.restarts()).toBe(0);
      for (const name of names) expect(await readFile(join(f.bin, name), "utf8")).toContain("1.0.0");
    } finally { await f.server.stop(true); }
  }
});
test("runtime-only upgrade restarts only runtime, supports launchd and reminds about the installed sudo helper", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, ".config/lumio-runtime")); await writeFile(join(f.home, ".config/lumio-runtime/runtime.env"), 'LUMIO_RUNTIME_SUDO_COMMAND="/usr/bin/sudo -n /helper"');
    await upgrade({ ...f.options, runtimeOnly: true });
    expect(f.restarts()).toBe(1); expect(f.commands).not.toContainEqual(["systemctl", "--user", "restart", "lumio-hub.service"]);
    expect(f.logs.at(-1)).toContain("sudo lumio-runtime install-sudo-helper");
    // Same downloaded bytes stand in for the macOS build; only service orchestration changes.
    await writeFile(join(f.bin, "lumio-runtime"), '#!/bin/sh\nprintf "1.0.0\\n"'); await chmod(join(f.bin, "lumio-runtime"), 0o755);
    await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true }); await writeFile(join(f.home, "Library/LaunchAgents/io.lumio.runtime.plist"), "synthetic");
    const fetcher = (async (input, init) => {
      const r = await fetch(String(input).replaceAll("darwin-arm64", "linux-x64"), init);
      return String(input).endsWith("SHA256SUMS") ? new Response((await r.text()).replaceAll("linux-x64", "darwin-arm64")) : r;
    }) as typeof fetch;
    await upgrade({ ...f.options, platform: "darwin", arch: "arm64", uid: 501, runtimeOnly: true, fetch: fetcher });
    expect(f.commands).toContainEqual(["launchctl", "kickstart", "-k", "gui/501/io.lumio.runtime"]);
  } finally { await f.server.stop(true); }
});
test("upgrade rejects unsupported platforms and options, and detects a Hub that keeps reporting the old version", async () => {
  const f = await fixture();
  try {
    await expect(upgrade({ ...f.options, platform: "darwin", arch: "x64" })).rejects.toThrow("不支持的平台");
    await expect(upgrade({ ...f.options, version: "../../bad" })).rejects.toThrow("版本");
    let clock = 0;
    await expect(upgrade({ ...f.options, now: () => clock, sleep: async (ms) => { clock += ms; },
      fetch: (async (input, init) => String(input).endsWith("/health") ? Response.json({ ok: true, version: "1.0.0" }) : fetch(input, init)) as typeof fetch,
    })).rejects.toThrow("Hub 未在 30 秒");
  } finally { await f.server.stop(true); }
});

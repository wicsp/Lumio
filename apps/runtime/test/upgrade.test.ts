import { beforeEach as beforeLocale, afterEach as afterLocale } from "bun:test";
let previousLocale: string | undefined;
beforeLocale(() => { previousLocale = process.env.LUMIO_LANG; process.env.LUMIO_LANG = "zh"; });
afterLocale(() => { if (previousLocale === undefined) delete process.env.LUMIO_LANG; else process.env.LUMIO_LANG = previousLocale; });
import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, lstat, readlink, stat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgrade } from "../src/upgrade.ts";
import { signManifest } from "@lumio/platform";
const signing = generateKeyPairSync("ed25519");
const privateKey = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = signing.publicKey.export({ type: "spki", format: "pem" }).toString();
const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
const names = ["lumio"];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "lumio-upgrade-test-")); roots.push(home);
  const archiveDir = join(home, "archive"), bin = join(home, ".local/bin");
  await mkdir(archiveDir); await mkdir(bin, { recursive: true });
  for (const name of names) {
    await writeFile(join(archiveDir, name), '#!/bin/sh\nprintf "2.3.4\\n"\n', { mode: 0o755 });
    await writeFile(join(bin, name), '#!/bin/sh\nprintf "0.1.6\\n"\n', { mode: 0o755 });
  }
  for (const role of ["hub", "runtime"]) await symlink("lumio", join(bin, `lumio-${role}`));
  const file = join(home, "release.tar.gz");
  async function pack(entries = names) { const child = Bun.spawn(["tar", "-czf", file, "-C", archiveDir, ...entries]); expect(await child.exited).toBe(0); }
  await pack();
  let corrupt = false, duplicate = false, health = "0.1.6", restarts = 0;
  const requests: string[] = [], commands: string[][] = [], logs: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname; requests.push(path);
    if (path === "/health") return Response.json({ ok: true, version: health });
    const bytes = await readFile(file), hash = createHash("sha256").update(bytes).digest("hex");
    const manifest = Buffer.from(JSON.stringify({ format: 1, version: "2.3.4", channel: "release", commit: "a".repeat(40), created: "2026-11-12T00:00:00Z", artifacts: ["linux-x64", "darwin-arm64"].map(platform => ({ platform, file: `lumio-${platform}.tar.gz`, size: bytes.length, sha256: corrupt ? "0".repeat(64) : hash })) }));
    if (path.endsWith("manifest.json")) return new Response(manifest);
    if (path.endsWith("manifest.sig")) return new Response(duplicate ? "invalid" : signManifest(manifest, privateKey));
    return new Response(bytes);
  } });
  const url = server.url.href.replace(/\/$/, "");
  await mkdir(join(home, ".config/lumio"), { recursive: true }); await mkdir(join(home, ".config/systemd/user"), { recursive: true });
  await writeFile(join(home, ".config/lumio/config.json"), JSON.stringify({ hub_url: url, token: "synthetic" }));
  for (const service of ["hub", "runtime"]) await writeFile(join(home, `.config/systemd/user/lumio-${service}.service`), `[Service]\nExecStart="${bin}/lumio-${service}"\nEnvironmentFile=${home}/synthetic.env\n`);
  const options = { releaseKeys: [publicKey], home, env: {}, platform: "linux", arch: "x64", releaseBase: url, log: (l: string) => logs.push(l),
    run: async (argv: string[]) => {
      commands.push(argv);
      if (argv[0] === "plutil") return { code: 0, stdout: "", stderr: "" };
      if (argv[0] === "systemctl" || argv[0] === "launchctl") { restarts++; health = "2.3.4"; return { code: 0, stdout: "", stderr: "" }; }
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr };
    } };
  return { home, bin, archiveDir, pack, server, options, commands, logs, requests, setCorrupt: () => { corrupt = true; }, setDuplicate: () => { duplicate = true; }, restarts: () => restarts };
}
test("upgrade verifies a local HTTP Release, replaces old binaries with one program, restarts local services and waits for the new health version", async () => {
  const f = await fixture();
  try {
    await upgrade({ ...f.options, version: "v2.3.4" });
    expect(f.requests).toContain("/download/v2.3.4/lumio-linux-x64.tar.gz"); expect(f.requests).toContain("/health");
    expect(f.commands).toContainEqual(["systemctl", "--user", "restart", "lumio-hub.service"]); expect(f.restarts()).toBe(3);
    for (const name of names) { expect(await readFile(join(f.bin, name), "utf8")).toContain("2.3.4"); expect((await stat(join(f.bin, name))).mode & 0o777).toBe(0o755); }
    for (const name of ["lumio-hub", "lumio-runtime"]) await expect(lstat(join(f.bin, name))).rejects.toThrow();
    for (const role of ["hub", "runtime"]) expect(await readFile(join(f.home, `.config/systemd/user/lumio-${role}.service`), "utf8")).toContain(`ExecStart="${f.bin}/lumio" ${role} serve`);
    const before = f.restarts(); await upgrade(f.options); expect(f.restarts()).toBe(before); expect(f.logs.at(-1)).toContain("已是最新版本 2.3.4");
  } finally { await f.server.stop(true); }
});
test("upgrade leaves installed programs unchanged on checksum, signature, archive or version failures", async () => {
  for (const mode of ["checksum", "duplicate", "symlink", "extra", "version"] as const) {
    const f = await fixture();
    try {
      if (mode === "checksum") f.setCorrupt();
      if (mode === "duplicate") f.setDuplicate();
      if (mode === "symlink") { await rm(join(f.archiveDir, "lumio")); await symlink("/etc/passwd", join(f.archiveDir, "lumio")); await f.pack(); }
      if (mode === "extra") { await writeFile(join(f.archiveDir, "extra"), "unexpected"); await f.pack(["lumio", "extra"]); }
      await expect(upgrade({ ...f.options, ...(mode === "version" ? { version: "v9.9.9" } : {}) })).rejects.toThrow();
      expect(f.restarts()).toBe(0);
      for (const name of names) expect(await readFile(join(f.bin, name), "utf8")).toContain("0.1.6");
    } finally { await f.server.stop(true); }
  }
});
test("runtime-only upgrade restarts only runtime, supports launchd and reminds about the installed sudo helper", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, ".config/lumio-runtime")); await writeFile(join(f.home, ".config/lumio-runtime/runtime.env"), 'LUMIO_RUNTIME_SUDO_COMMAND="/usr/bin/sudo -n /helper"');
    await upgrade({ ...f.options, runtimeOnly: true });
    expect(f.restarts()).toBe(2); expect(f.commands).not.toContainEqual(["systemctl", "--user", "restart", "lumio-hub.service"]);
    expect(f.logs.at(-1)).toContain("sudo lumio runtime install-sudo-helper");
    // Same downloaded bytes stand in for the macOS build; only service orchestration changes.
    await writeFile(join(f.bin, "lumio-runtime"), '#!/bin/sh\nprintf "0.1.6\\n"'); await chmod(join(f.bin, "lumio-runtime"), 0o755);
    await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true }); await writeFile(join(f.home, "Library/LaunchAgents/io.lumio.runtime.plist"), `<plist><dict><key>ProgramArguments</key><array><string>${f.bin}/lumio-runtime</string></array></dict></plist>`);
    await upgrade({ ...f.options, platform: "darwin", arch: "arm64", uid: 501, runtimeOnly: true });
    expect(f.commands).toContainEqual(["launchctl", "bootstrap", "gui/501", join(f.home, "Library/LaunchAgents/io.lumio.runtime.plist")]);
  } finally { await f.server.stop(true); }
});
test("upgrade rejects unsupported platforms and options, and detects a Hub that keeps reporting the old version", async () => {
  const f = await fixture();
  try {
    await expect(upgrade({ ...f.options, platform: "darwin", arch: "x64" })).rejects.toThrow("UPGRADE_FAILED");
    await expect(upgrade({ ...f.options, version: "../../bad" })).rejects.toThrow("UPGRADE_FAILED");
    let clock = 0;
    await expect(upgrade({ ...f.options, now: () => clock, sleep: async (ms) => { clock += ms; },
      fetch: (async (input, init) => String(input).endsWith("/health") ? Response.json({ ok: true, version: "0.1.6" }) : fetch(input, init)) as typeof fetch,
    })).rejects.toThrow("UPGRADE_FAILED");
  } finally { await f.server.stop(true); }
});

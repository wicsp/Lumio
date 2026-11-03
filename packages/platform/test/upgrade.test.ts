import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, readlink, stat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgrade } from "../src/upgrade.ts";
import { releaseShim } from "../src/release-shims.ts";
const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
const names = ["lumio", "lumio-hub", "lumio-runtime"];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "lumio-upgrade-test-")); roots.push(home);
  const archiveDir = join(home, "archive"), bin = join(home, ".local/bin");
  await mkdir(archiveDir); await mkdir(bin, { recursive: true });
  for (const name of names) {
    await writeFile(join(archiveDir, name), name === "lumio" ? '#!/bin/sh\nprintf "2.3.4\\n"\n' : releaseShim(name === "lumio-hub" ? "hub" : "runtime"), { mode: 0o755 });
    await writeFile(join(bin, name), '#!/bin/sh\nprintf "0.1.6\\n"\n', { mode: 0o755 });
  }
  const file = join(home, "release.tar.gz");
  async function pack() { const child = Bun.spawn(["tar", "-czf", file, "-C", archiveDir, ...names]); expect(await child.exited).toBe(0); }
  await pack();
  let latest: string | undefined = "v2.3.4";
  let corrupt = false, duplicate = false, health = "0.1.6", restarts = 0;
  const requests: string[] = [], commands: string[][] = [], logs: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname; requests.push(path);
    if (path === "/latest") return latest ? new Response(null, { status: 302, headers: { Location: `/tag/${latest}` } }) : new Response("synthetic mirror without redirect");
    if (path.startsWith("/tag/")) throw new Error("latest must not be followed");
    if (path === "/health") return Response.json({ ok: true, version: health });
    const bytes = await readFile(file), hash = createHash("sha256").update(bytes).digest("hex");
    if (path.endsWith("SHA256SUMS")) return new Response(`${corrupt ? "0".repeat(64) : hash}  lumio-linux-x64.tar.gz\n`.repeat(duplicate ? 2 : 1));
    return new Response(bytes);
  } });
  const url = server.url.href.replace(/\/$/, "");
  await mkdir(join(home, ".config/lumio"), { recursive: true }); await mkdir(join(home, ".config/systemd/user"), { recursive: true });
  await writeFile(join(home, ".config/lumio/config.json"), JSON.stringify({ hub_url: url, token: "synthetic" }));
  for (const service of ["hub", "runtime"]) await writeFile(join(home, `.config/systemd/user/lumio-${service}.service`), `[Service]\nExecStart="${bin}/lumio-${service}"\nEnvironmentFile=${home}/synthetic.env\n`);
  const options = { home, env: {}, platform: "linux", arch: "x64", releaseBase: url, log: (l: string) => logs.push(l),
    run: async (argv: string[]) => {
      commands.push(argv);
      if (argv[0] === "plutil") return { code: 0, stdout: "", stderr: "" };
      if (argv[0] === "systemctl" || argv[0] === "launchctl") { restarts++; health = "2.3.4"; return { code: 0, stdout: "", stderr: "" }; }
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr };
    } };
  return { home, bin, archiveDir, pack, server, options, commands, logs, requests, setLatest: (value: string | undefined) => { latest = value; }, setCorrupt: () => { corrupt = true; }, setDuplicate: () => { duplicate = true; }, restarts: () => restarts };
}
test("upgrade verifies a local HTTP Release, replaces old binaries with one program and links, restarts local services and waits for the new health version", async () => {
  const f = await fixture();
  try {
    await upgrade({ ...f.options, version: "v2.3.4" });
    expect(f.requests).toContain("/download/v2.3.4/lumio-linux-x64.tar.gz"); expect(f.requests).toContain("/health");
    expect(f.commands).toContainEqual(["systemctl", "--user", "restart", "lumio-hub.service"]); expect(f.restarts()).toBe(3);
    for (const name of names) { expect(await readFile(join(f.bin, name), "utf8")).toContain("2.3.4"); expect((await stat(join(f.bin, name))).mode & 0o777).toBe(0o755); }
    for (const name of ["lumio-hub", "lumio-runtime"]) expect(await readlink(join(f.bin, name))).toBe("lumio");
    for (const role of ["hub", "runtime"]) expect(await readFile(join(f.home, `.config/systemd/user/lumio-${role}.service`), "utf8")).toContain(`ExecStart="${f.bin}/lumio" ${role} serve`);
    const before = f.restarts(); await upgrade(f.options); expect(f.restarts()).toBe(before); expect(f.logs.at(-1)).toContain("Already at latest version 2.3.4");
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
    expect(f.logs.at(-1)).toContain("sudo lumio-runtime install-sudo-helper");
    // Same downloaded bytes stand in for the macOS build; only service orchestration changes.
    await writeFile(join(f.bin, "lumio-runtime"), '#!/bin/sh\nprintf "0.1.6\\n"'); await chmod(join(f.bin, "lumio-runtime"), 0o755);
    await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true }); await writeFile(join(f.home, "Library/LaunchAgents/io.lumio.runtime.plist"), `<plist><dict><key>ProgramArguments</key><array><string>${f.bin}/lumio-runtime</string></array></dict></plist>`);
    const fetcher = (async (input, init) => {
      const r = await fetch(String(input).replaceAll("darwin-arm64", "linux-x64"), init);
      return String(input).endsWith("SHA256SUMS") ? new Response((await r.text()).replaceAll("linux-x64", "darwin-arm64")) : r;
    }) as typeof fetch;
    await upgrade({ ...f.options, platform: "darwin", arch: "arm64", uid: 501, runtimeOnly: true, fetch: fetcher });
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

test("upgrade checks every shim byte before replacement and refuses mismatched release wrappers", async () => {
  for (const role of ["hub", "runtime"] as const) for (const suffix of ["\n", "\0"]) {
    const f = await fixture();
    try {
      await writeFile(join(f.archiveDir, `lumio-${role}`), releaseShim(role) + suffix); await f.pack();
      await expect(upgrade(f.options)).rejects.toThrow("UPGRADE_FAILED"); expect(f.restarts()).toBe(0);
      for (const name of names) expect(await readFile(join(f.bin, name), "utf8")).toContain("0.1.6");
    } finally { await f.server.stop(true); }
  }
});

test("a second upgrade converts the v0.1.x-installed current-version shims into links and updates service commands", async () => {
  const f = await fixture();
  try {
    // This is the installed layout left by the old upgrader after it copied the new release's three files.
    for (const name of names) await writeFile(join(f.bin, name), await readFile(join(f.archiveDir, name)), { mode: 0o755 });
    await upgrade(f.options);
    for (const role of ["hub", "runtime"]) {
      expect(await readlink(join(f.bin, `lumio-${role}`))).toBe("lumio");
      expect(await readFile(join(f.home, `.config/systemd/user/lumio-${role}.service`), "utf8")).toContain(`ExecStart="${f.bin}/lumio" ${role} serve`);
    }
    expect(f.logs.some(line => line.includes("已是最新版本"))).toBe(false);
    expect(f.logs).toContain("Run lumio login-code --name web to get a pairing code");
  } finally { await f.server.stop(true); }
});


test("latest is resolved without following redirects; current installs make no asset requests", async () => {
  const f = await fixture();
  try {
    const progress: string[] = [];
    await upgrade({ ...f.options, progress: chunk => progress.push(chunk), tty: false });
    expect(f.requests).toContain("/latest"); expect(f.requests).not.toContain("/tag/v2.3.4");
    expect(f.requests).toContain("/download/v2.3.4/lumio-linux-x64.tar.gz");
    expect(f.requests.some(path => path.includes("latest/download"))).toBe(false);
    expect(progress).toHaveLength(2); expect(progress[0]).toContain("2.3.4 (linux-x64)");
    f.requests.length = 0; const before = f.restarts();
    await upgrade(f.options);
    expect(f.requests).toEqual(["/latest"]); expect(f.restarts()).toBe(before);
    expect(f.logs.at(-1)).toBe("Already at latest version 2.3.4");
    f.requests.length = 0;
    await upgrade({ ...f.options, version: "v2.3.4" }); expect(f.requests).toEqual([]);
    // Services need repair even when the executable and links already match.
    await writeFile(join(f.home, ".config/systemd/user/lumio-runtime.service"), `[Service]\nExecStart="${f.bin}/lumio-runtime"\n`);
    await upgrade(f.options); expect(f.requests).toContain("/download/v2.3.4/lumio-linux-x64.tar.gz");
  } finally { await f.server.stop(true); }
});
test("an unreadable latest version falls back to verified downloads and compares afterwards", async () => {
  for (const mode of ["no redirect", "bad tag", "network"] as const) {
    const f = await fixture();
    try {
      await upgrade(f.options); f.requests.length = 0;
      f.setLatest(mode === "bad tag" ? "unparseable" : undefined);
      await upgrade({ ...f.options, ...(mode === "network" ? { fetch: (async (input, init) => {
        if (String(input).endsWith("/latest")) throw new Error("synthetic network failure");
        return fetch(input, init);
      }) as typeof fetch } : {}) });
      expect(f.requests).toContain("/latest/download/lumio-linux-x64.tar.gz");
      expect(f.requests).toContain("/latest/download/SHA256SUMS");
      expect(f.logs.at(-1)).toBe("Already at latest version 2.3.4");
    } finally { await f.server.stop(true); }
  }
});

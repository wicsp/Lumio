import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseManifest, RuntimeUpdateReport, type RuntimeInstall } from "@lumio/schema";
import { releaseShim, signManifest } from "@lumio/platform";
import { SelfUpdate } from "../src/self-update.ts";
import { detectInstall, helperCompatible, UpdateInstall } from "../src/update-install.ts";
import { trustBuildKey } from "../src/trust-build-key.ts";
import { updateCheck } from "../src/update-check.ts";
import { Queue } from "../src/queue.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(install: RuntimeInstall = "managed") {
  const home = await mkdtemp(join(tmpdir(), "lumio-update-test-")); roots.push(home);
  const binary = join(home, ".local/bin/lumio"), stateDir = join(home, "state"), archiveDir = join(home, "archive");
  await mkdir(join(home, ".local/bin"), { recursive: true }); await mkdir(stateDir); await mkdir(archiveDir);
  await writeFile(binary, "previous program", { mode: 0o755 });
  const version = "0.2.3", keys = generateKeyPairSync("ed25519");
  const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString(), priv = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await writeFile(join(archiveDir, "lumio"), "new program");
  for (const role of ["hub", "runtime"] as const) await writeFile(join(archiveDir, `lumio-${role}`), releaseShim(role));
  const tar = join(home, "archive.tar.gz");
  const packed = Bun.spawn(["tar", "-czf", tar, "-C", archiveDir, "lumio", "lumio-hub", "lumio-runtime"]); expect(await packed.exited).toBe(0);
  const archive = await readFile(tar);
  const manifest = ReleaseManifest.parse({ format: 1, version, channel: "release", commit: "a".repeat(40), created: "2026-11-12T00:00:00Z", artifacts: [{ platform: "linux-x64", file: "lumio-linux-x64.tar.gz", size: archive.length, sha256: createHash("sha256").update(archive).digest("hex") }] });
  let bytes = Buffer.from(JSON.stringify(manifest)), signature = signManifest(bytes, priv), downloads = 0, restarts = 0, preflight = true, diskVersion = version;
  let clock = Date.parse("2026-11-12T00:00:00Z");
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push(url);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic");
    if (url.endsWith("manifest.json")) return new Response(bytes);
    if (url.endsWith("manifest.sig")) return new Response(signature);
    downloads++; return new Response(archive);
  }) as typeof fetch;
  const run = async (args: string[]) => {
    if (args[0] === "tar") {
      const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); return { code, stdout, stderr };
    }
    if (args[1] === "--version") return { code: 0, stdout: diskVersion, stderr: "" };
    expect(args.slice(1)).toEqual(["runtime", "update-check", "--state-dir", stateDir]);
    return { code: preflight ? 0 : 1, stdout: "", stderr: "" };
  };
  const options = { home, stateDir, binary, version: "0.2.2", platform: "linux-x64" as const, install, url: "http://synthetic.invalid", token: "synthetic", keys: [pub], fetch: fetcher, run, now: () => clock, restart: () => { restarts++; } };
  const updater = new SelfUpdate(options); await updater.open();
  return { home, binary, stateDir, updater, options, pub, priv, requests, directive: { version, hold: false },
    downloads: () => downloads, restarts: () => restarts, advance: (ms: number) => { clock += ms; },
    corrupt: () => { bytes = Buffer.concat([bytes, Buffer.from(" ")]); }, failPreflight: () => { preflight = false; }, wrongVersion: () => { diskVersion = "9.9.9"; },
    signManifest: (patch: Record<string, unknown>) => { bytes = Buffer.from(JSON.stringify({ ...manifest, ...patch })); signature = signManifest(bytes, priv); } };
}
test("managed update verifies, stages once, drains after 30 minutes, replaces only when idle, then confirms", async () => {
  const f = await fixture(); expect(f.updater.heartbeat()).toBeUndefined();
  await f.updater.reconcile(f.directive, () => true); await f.updater.prepared();
  expect(f.updater.heartbeat()?.state).toBe("staged"); RuntimeUpdateReport.parse(f.updater.heartbeat());
  await f.updater.reconcile(f.directive, () => true); expect(f.updater.heartbeat()?.state).toBe("waiting_idle");
  f.advance(30 * 60_000); await f.updater.reconcile(f.directive, () => true);
  expect(f.updater.draining).toBe(true); expect(f.restarts()).toBe(0); expect(await readFile(f.binary, "utf8")).toBe("previous program");
  await f.updater.reconcile(f.directive, () => false); expect(f.restarts()).toBe(1); expect(f.downloads()).toBe(1);
  expect(await readFile(f.binary, "utf8")).toBe("new program");
  expect(await readFile(join(f.stateDir, "update/previous/lumio"), "utf8")).toBe("previous program");
  await f.updater.install.confirm("0.2.3"); expect(await Bun.file(join(f.stateDir, "update/pending.json")).exists()).toBe(false);
});
test("hold resumes local admission; restart-now and retry IDs are durable and execute once", async () => {
  const f = await fixture();
  await f.updater.reconcile(f.directive, () => true); await f.updater.prepared(); f.advance(31 * 60_000);
  await f.updater.reconcile(f.directive, () => true); expect(f.updater.draining).toBe(true);
  await f.updater.reconcile({ ...f.directive, hold: true }, () => true); expect(f.updater.draining).toBe(false); expect(f.restarts()).toBe(0);
  await f.updater.reconcile({ ...f.directive, restart_now: "restart-once-00001" }, () => true); expect(f.restarts()).toBe(1);
  const restored = new SelfUpdate(f.options); await restored.open();
  await restored.reconcile({ ...f.directive, restart_now: "restart-once-00001" }, () => true); await restored.prepared();
  await restored.reconcile({ ...f.directive, restart_now: "restart-once-00001" }, () => true); expect(f.restarts()).toBe(1);
});
test("tampering, version mismatch and failed preflight never replace or automatically retry", async () => {
  for (const mode of ["signature", "version", "preflight", "digest"] as const) {
    const f = await fixture();
    if (mode === "signature") f.corrupt();
    if (mode === "version") f.wrongVersion();
    if (mode === "preflight") f.failPreflight();
    if (mode === "digest") f.signManifest({ artifacts: [{ platform: "linux-x64", file: "lumio-linux-x64.tar.gz", size: 1, sha256: "0".repeat(64) }] });
    await f.updater.reconcile(f.directive, () => false); await f.updater.prepared();
    expect(f.updater.heartbeat()?.state).toBe("failed");
    const before = f.requests.length; await f.updater.reconcile(f.directive, () => false); expect(f.requests.length).toBe(before);
    expect(f.restarts()).toBe(0); expect(await readFile(f.binary, "utf8")).toBe("previous program");
    await f.updater.reconcile({ ...f.directive, retry: "retry-once-000001" }, () => false); await f.updater.prepared(); expect(f.requests.length).toBeGreaterThan(before);
  }
});
test("external never downloads; shared never writes; dev without a trusted key blocks before transport", async () => {
  const external = await fixture("external"); await external.updater.reconcile(external.directive, () => false);
  expect(external.updater.heartbeat()?.reason).toBe("external_install"); expect(external.requests).toHaveLength(0);
  const shared = await fixture("hub-shared"); await shared.updater.reconcile(shared.directive, () => false); await shared.updater.prepared(); await shared.updater.reconcile(shared.directive, () => false);
  expect(shared.restarts()).toBe(1); expect(shared.requests).toHaveLength(0); expect(await readFile(shared.binary, "utf8")).toBe("previous program");
  const dev = await fixture(); await dev.updater.reconcile({ version: "0.2.3-dev.local.abc", hold: false }, () => false); await dev.updater.prepared();
  expect(dev.updater.heartbeat()?.reason).toBe("untrusted_build"); expect(dev.requests).toHaveLength(0);
});
test("third reachable startup rolls back; offline starts do not count, failure persists", async () => {
  const f = await fixture(); await f.updater.reconcile(f.directive, () => false); await f.updater.prepared(); await f.updater.reconcile(f.directive, () => false);
  const install = new UpdateInstall(f.stateDir, f.binary);
  for (let i = 0; i < 5; i++) expect(await install.startup("0.2.3", async () => false)).toBe(false);
  expect(await install.startup("0.2.3", async () => true)).toBe(false); expect(await install.startup("0.2.3", async () => true)).toBe(false);
  expect(await install.startup("0.2.3", async () => true)).toBe(true); expect(await readFile(f.binary, "utf8")).toBe("previous program");
  const restored = new SelfUpdate(f.options); await restored.open(); const count = f.requests.length;
  await restored.reconcile(f.directive, () => false); expect(restored.heartbeat()?.reason).toBe("confirm_failed"); expect(f.requests.length).toBe(count);
});
test("installation classification fails closed; trusted build keys require fingerprint confirmation and 0600", async () => {
  const f = await fixture();
  expect(await detectInstall({ home: f.home, binary: f.binary, compiled: false, env: {} })).toBe("external");
  expect(await detectInstall({ home: f.home, binary: f.binary, compiled: true, env: { LUMIO_RUNTIME_AUTO_UPDATE: "off" } })).toBe("external");
  expect(await detectInstall({ home: f.home, binary: f.binary, compiled: true, env: {} })).toBe("managed");
  await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true });
  await writeFile(join(f.home, "Library/LaunchAgents/io.lumio.hub.plist"), `<key>ProgramArguments</key><array><string>${f.binary}</string><string>hub</string></array>`);
  expect(await detectInstall({ home: f.home, binary: f.binary, compiled: true, platform: "darwin", env: {} })).toBe("hub-shared");
  const path = join(f.home, ".config/lumio-runtime/trusted-build-keys.json");
  await expect(trustBuildKey(f.pub, { home: f.home, log: () => {}, confirm: async () => false })).rejects.toThrow(); expect(await Bun.file(path).exists()).toBe(false);
  await trustBuildKey(f.pub, { home: f.home, log: () => {}, confirm: async () => true }); expect((await stat(path)).mode & 0o777).toBe(0o600);
});
test("update-check validates queue data without writing the database", async () => {
  const f = await fixture(), queue = new Queue(f.stateDir); queue.close();
  const path = join(f.stateDir, "runtime.sqlite"), before = await readFile(path);
  await updateCheck(f.stateDir); expect(await readFile(path)).toEqual(before);
});

test("independent helper version mismatch disables the capability without invoking sudo", async () => {
  const calls: string[][] = [];
  const run = async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: "0.2.2", stderr: "" }; };
  expect(await helperCompatible(["/usr/bin/sudo", "-n", "/synthetic/helper", "--sudo-helper"], "0.2.3", run)).toBe(false);
  expect(calls).toEqual([["/synthetic/helper", "--version"]]);
  expect(await helperCompatible(["/synthetic/helper"], "0.2.2", run)).toBe(true);
});

test("a hold or desired-version change observed at the final sync cancels replacement", async () => {
  const f = await fixture();
  const updater = new SelfUpdate({ ...f.options, beforeSwitch: async () => false }); await updater.open();
  await updater.reconcile(f.directive, () => false); await updater.prepared(); await updater.reconcile(f.directive, () => false);
  expect(f.restarts()).toBe(0); expect(updater.restarting).toBe(false); expect(await readFile(f.binary, "utf8")).toBe("previous program");
});

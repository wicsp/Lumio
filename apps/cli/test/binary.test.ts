import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinary, writeReleaseShims } from "../src/build-binary.ts";
import { invocation } from "../src/main.ts";
let root: string, binary: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lumio-unified-bin-")); binary = join(root, "lumio");
  await buildBinary({ outfile: binary, version: "9.8.7" });
  await symlink("lumio", join(root, "lumio-hub")); await symlink("lumio", join(root, "lumio-runtime"));
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
test("all names and role forms report one compiled version; internal helpers and existing runtime commands dispatch correctly", async () => {
  for (const [name, args] of [["lumio", ["--version"]], ["lumio", ["hub", "--version"]], ["lumio", ["runtime", "--version"]], ["lumio-hub", ["--version"]], ["lumio-runtime", ["--version"]]] as const) {
    const child = Bun.spawn([join(root, name), ...args], { cwd: root, env: { HOME: root, PATH: "" }, stdout: "pipe", stderr: "pipe" });
    expect((await new Response(child.stdout).text()).trim()).toBe("9.8.7"); expect(await child.exited).toBe(0);
  }
  expect(invocation(["actor", "list"], "lumio-hub").role).toBe("hub");
  expect(invocation(["hub", "status"], "lumio").role).toBe("cli");
  expect(invocation(["doctor"], "lumio-runtime").role).toBe("runtime");
  for (const action of ["add", "remove", "list"]) expect(invocation(["runtime", action], "lumio").role).toBe("cli");
  for (const helper of ["--job-worker", "--sudo-helper", "--configure-sudo-helper"]) expect(invocation([helper], "lumio").role).toBe("runtime");
});
async function start(name: string, args: string[]) {
  const child = Bun.spawn([join(root, name), ...args], { cwd: root, env: { HOME: root, PATH: process.env.PATH, LUMIO_STATE_DIR: join(root, "state"), LUMIO_HUB_LISTEN: "127.0.0.1:0" }, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const reader = child.stdout.getReader(), decoder = new TextDecoder(); let text = "";
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value); const url = /http:\/\/127\.0\.0\.1:\d+/.exec(text)?.[0]; if (url) return { child, url }; }
    throw new Error(`Hub startup failed: ${await new Response(child.stderr).text()}`);
  } catch (cause) { child.kill(); await child.exited; throw cause; }
  finally { reader.releaseLock(); }
}
test("compiled program serves embedded Web/PWA from an empty directory through both Hub invocations", async () => {
  for (const [name, args] of [["lumio", ["hub", "serve"]], ["lumio-hub", []]] as const) {
    const { child, url } = await start(name, [...args]);
    try {
      const page = await fetch(url); expect(page.status).toBe(200); expect(await page.text()).toContain('name="lumio-api-base" content=""');
      expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
      expect((await (await fetch(url + "/assets/app.js")).text()).length).toBeGreaterThan(1000);
      expect((await (await fetch(url + "/assets/app.css")).text()).length).toBeGreaterThan(1000);
      const manifest = await (await fetch(url + "/manifest.webmanifest")).json() as { icons: { src: string }[] };
      for (const icon of manifest.icons) expect((await fetch(url + icon.src)).status).toBe(200);
      expect((await (await fetch(url + "/health")).json() as { version: string }).version).toBe("9.8.7");
    } finally { child.kill("SIGTERM"); await child.exited; }
  }
  expect(await readdir(root)).not.toContain("src");
}, 50_000);

test("compiled runtime uses the same program for its worker and delivers a synthetic command result", async () => {
  const { createClient } = await import("@lumio/api-client");
  const env = { HOME: root, PATH: "", LUMIO_STATE_DIR: join(root, "state") };
  async function manage(args: string[]) {
    const child = Bun.spawn([binary, "hub", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw new Error(error); return output.trim();
  }
  await manage(["actor", "create", "binary-owner", "--role", "human"]);
  await manage(["actor", "create", "binary-runtime", "--role", "runtime"]);
  const token = await manage(["token", "create", "binary-owner", "--actor", "binary-owner"]);
  const runtimeToken = await manage(["token", "create", "binary-runtime", "--actor", "binary-runtime"]);
  const { child: hub, url } = await start("lumio", ["hub", "serve"]);
  const runtime = Bun.spawn([binary, "runtime", "serve"], { cwd: root, env: { HOME: root, PATH: "", LUMIO_HUB_URL: url,
    LUMIO_TOKEN: runtimeToken, LUMIO_RUNTIME_NAME: "binary-runtime", LUMIO_RUNTIME_STATE_DIR: join(root, "runtime"), LUMIO_RUNTIME_POLL_SECONDS: "0.05", LUMIO_RUNTIME_ALLOWED_COMMANDS: "/usr/bin/true" }, stdout: "ignore", stderr: "pipe" });
  try {
    const client = createClient({ url, token });
    const deadline = Date.now() + 10_000;
    while (!(await client.runtimes()).some(runtime => runtime.online)) { if (Date.now() > deadline) throw new Error("compiled runtime did not register"); await Bun.sleep(30); }
    const submitted = await client.submitJob({ runtime: "binary-runtime", workdir: root, timeout_seconds: 5, run: { kind: "command", argv: ["/usr/bin/true"] } });
    for (;;) {
      const job = await client.job(submitted.spec.id);
      if (job.result) { expect(job.result.status).toBe("done"); expect(job.result.exit_code).toBe(0); break; }
      if (Date.now() > deadline) throw new Error("compiled worker did not deliver a result"); await Bun.sleep(30);
    }
  } finally { runtime.kill("SIGTERM"); await runtime.exited; hub.kill("SIGTERM"); await hub.exited; }
}, 25_000);

test("source invocation builds Web assets on demand in a synthetic state directory", async () => {
  const child = Bun.spawn([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, "hub", "serve"], { cwd: root,
    env: { HOME: root, PATH: "", LUMIO_STATE_DIR: join(root, "source-state"), LUMIO_HUB_LISTEN: "127.0.0.1:0" }, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const reader = child.stdout.getReader(); let text = "", url: string | undefined;
  try {
    while (!url) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); url = /http:\/\/127\.0\.0\.1:\d+/.exec(text)?.[0]; }
    if (!url) throw new Error("source Hub did not start");
    expect((await fetch(url)).status).toBe(200); expect((await (await fetch(url + "/assets/app.js")).text()).length).toBeGreaterThan(1000);
  } finally { reader.releaseLock(); child.kill("SIGTERM"); await child.exited; }
});

test("release archive passes v0.1.6 archive, regular-file and executable-version checks", async () => {
  const directory = join(root, "release with spaces"), extracted = join(root, "old upgrader extraction"), archive = join(root, "release.tar.gz");
  await mkdir(directory); await mkdir(extracted); await copyFile(binary, join(directory, "lumio")); await writeReleaseShims(directory);
  async function command(argv: string[]) {
    const child = Bun.spawn(argv, { cwd: root, env: { HOME: root, PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw new Error(error); return output;
  }
  await command(["tar", "-czf", archive, "-C", directory, "lumio", "lumio-hub", "lumio-runtime"]);
  // These are the archive and executable checks from v0.1.6 apps/{cli,runtime}/src/upgrade.ts.
  const binaries = ["lumio", "lumio-hub", "lumio-runtime"] as const;
  const entries = (await command(["tar", "-tzf", archive])).trim().split("\n");
  const types = (await command(["tar", "-tvzf", archive])).trim().split("\n");
  if (entries.length !== 3 || binaries.some(name => entries.filter(entry => entry === name).length !== 1)
    || types.length !== 3 || types.some(line => !line.startsWith("-"))) throw new Error("v0.1.6 rejected release paths or file types");
  await command(["tar", "-xzf", archive, "-C", extracted]);
  let target: string | undefined;
  for (const name of binaries) {
    const path = join(extracted, name), stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("v0.1.6 requires ordinary files");
    await chmod(path, 0o755);
    const version = /^(?:v)?(\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?)$/.exec((await command([path, "--version"])).trim())?.[1];
    if (!version || (target && version !== target)) throw new Error("v0.1.6 requires matching versions");
    target = version;
  }
  expect(target).toBe("9.8.7");
  expect(await readFile(join(extracted, "lumio-hub"), "utf8")).toContain('exec "$(dirname "$0")/lumio" hub "$@"');
});

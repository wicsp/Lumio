import { beforeEach as beforeLocale, afterEach as afterLocale } from "bun:test";
let previousLocale: string | undefined;
beforeLocale(() => { previousLocale = process.env.LUMIO_LANG; process.env.LUMIO_LANG = "zh"; });
afterLocale(() => { if (previousLocale === undefined) delete process.env.LUMIO_LANG; else process.env.LUMIO_LANG = previousLocale; });
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinary } from "../src/build-binary.ts";
import { invocation } from "../src/main.ts";
let root: string, binary: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lumio-unified-bin-")); binary = join(root, "lumio");
  await buildBinary({ outfile: binary, version: "9.8.7" });
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
test("all names and role forms report one compiled version; internal helpers and existing runtime commands dispatch correctly", async () => {
  for (const [name, args] of [["lumio", ["--version"]], ["lumio", ["hub", "--version"]], ["lumio", ["runtime", "--version"]]] as const) {
    const child = Bun.spawn([join(root, name), ...args], { cwd: root, env: { LUMIO_LANG: "zh", HOME: root, PATH: "" }, stdout: "pipe", stderr: "pipe" });
    expect((await new Response(child.stdout).text()).trim()).toBe("9.8.7"); expect(await child.exited).toBe(0);
  }
  expect(invocation(["hub", "status"]).role).toBe("cli");
  for (const action of ["add", "remove", "list"]) expect(invocation(["runtime", action]).role).toBe("cli");
  for (const helper of ["--job-worker", "--sudo-helper", "--configure-sudo-helper"]) expect(invocation([helper]).role).toBe("runtime");
});
async function start(name: string, args: string[]) {
  const child = Bun.spawn([join(root, name), ...args], { cwd: root, env: { LUMIO_LANG: "zh", HOME: root, PATH: process.env.PATH, LUMIO_STATE_DIR: join(root, "state"), LUMIO_HUB_LISTEN: "127.0.0.1:0" }, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const reader = child.stdout.getReader(), decoder = new TextDecoder(); let text = "";
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value); const url = /http:\/\/127\.0\.0\.1:\d+/.exec(text)?.[0]; if (url) return { child, url }; }
    throw new Error(`Hub startup failed: ${await new Response(child.stderr).text()}`);
  } catch (cause) { child.kill(); await child.exited; throw cause; }
  finally { reader.releaseLock(); }
}
test("compiled program serves embedded Web/PWA from an empty directory through both Hub invocations", async () => {
  for (const [name, args] of [["lumio", ["hub", "serve"]]] as const) {
    const { child, url } = await start(name, [...args]);
    try {
      const page = await fetch(url); expect(page.status).toBe(200);
      const html = await page.text(); expect(html).toContain('name="lumio-api-base" content=""');
      expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
      const entry = /<script\b[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
      expect(entry).toBeDefined();
      const scripts = new Set([entry!]);
      for (const path of scripts) {
        const script = await fetch(url + path);
        expect(script.status).toBe(200);
        expect(script.headers.get("content-type")).toContain("javascript");
        for (const [, chunk] of (await script.text()).matchAll(/"(\/assets\/chunk-[a-z0-9]+\.js)"/g)) scripts.add(chunk!);
      }
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
  const env = { LUMIO_LANG: "zh", HOME: root, PATH: "", LUMIO_STATE_DIR: join(root, "state") };
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
  const runtime = Bun.spawn([binary, "runtime", "serve"], { cwd: root, env: { LUMIO_LANG: "zh", HOME: root, PATH: "", LUMIO_HUB_URL: url,
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
    env: { LUMIO_LANG: "zh", HOME: root, PATH: "", LUMIO_STATE_DIR: join(root, "source-state"), LUMIO_HUB_LISTEN: "127.0.0.1:0" }, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const reader = child.stdout.getReader(); let text = "", url: string | undefined;
  try {
    while (!url) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); url = /http:\/\/127\.0\.0\.1:\d+/.exec(text)?.[0]; }
    if (!url) throw new Error("source Hub did not start");
    expect((await fetch(url)).status).toBe(200); expect((await (await fetch(url + "/assets/app.js")).text()).length).toBeGreaterThan(1000);
  } finally { reader.releaseLock(); child.kill("SIGTERM"); await child.exited; }
});

test("compiled runtime upgrade uses the terminal flow and skips current releases", async () => {
  const bin = join(root, ".local/bin"); await mkdir(bin, { recursive: true });
  await symlink(binary, join(bin, "lumio"));
  for (const role of ["hub", "runtime"]) await symlink("lumio", join(bin, `lumio-${role}`));
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return new Response(null, { status: 302, headers: { Location: "/tag/v9.8.7" } });
  } });
  try {
    for (const [name, args] of [["lumio", ["runtime", "upgrade"]]] as const) {
      const child = Bun.spawn([join(root, name), ...args], { env: { LUMIO_LANG: "zh", HOME: root, PATH: "", LUMIO_RELEASE_BASE_URL: server.url.href.replace(/\/$/, "") }, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(0); expect(out.trim()).toBe("已是最新版本 9.8.7"); expect(err).toBe("");
    }
    expect(requests).toEqual(["/latest"]);
    const child = Bun.spawn([binary, "doctor"], { env: { LUMIO_LANG: "zh", HOME: root, PATH: "", FORCE_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1); expect(out).toContain("\x1b[31m✗\x1b[0m"); expect(out).toMatch(/\d+ 项通过，\d+ 项提醒，\d+ 项失败/);
  } finally { await server.stop(true); }
});

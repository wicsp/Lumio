import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinary } from "../src/build-binary.ts";

let dir = "";
let binary = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lumio-web-bin-test-"));
  binary = join(dir, "lumio-web");
  await buildBinary({ outfile: binary, version: "9.8.7" });
}, 120_000);
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

/** 从输出里读出实际监听地址（LUMIO_WEB_LISTEN 用端口 0）。 */
async function start(env: Record<string, string>) {
  const child = Bun.spawn([binary], { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir, ...env }, stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 15_000;
  while (!/http:\/\/[^\s]+/.test(text) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const url = /(http:\/\/127\.0\.0\.1:\d+)/.exec(text)?.[1];
  if (!url) { child.kill(); throw new Error(`lumio-web 没有启动：${text}${await new Response(child.stderr).text()}`); }
  return { child, url };
}

test("compiled lumio-web prints its version", async () => {
  const child = Bun.spawn([binary, "--version"], { cwd: dir, stdout: "pipe" });
  expect((await new Response(child.stdout).text()).trim()).toBe("9.8.7");
  expect(await child.exited).toBe(0);
});

test("compiled lumio-web serves embedded assets from an empty directory and reports Hub health", async () => {
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => new URL(request.url).pathname === "/health" ? Response.json({ ok: true, version: "9.8.7" }) : new Response("no", { status: 404 }) });
  const { child, url } = await start({ LUMIO_WEB_LISTEN: "127.0.0.1:0", LUMIO_WEB_HUB_URL: `http://127.0.0.1:${hub.port}` });
  try {
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/assets/app.js");
    const js = await fetch(`${url}/assets/app.js`);
    expect(js.status).toBe(200);
    expect((await js.text()).length).toBeGreaterThan(1000);
    expect(await (await fetch(`${url}/assets/app.css`)).text()).toContain("--lumen");
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: "9.8.7", hub: { url: `http://127.0.0.1:${hub.port}`, ok: true, version: "9.8.7" } });
  } finally { child.kill(); await child.exited; hub.stop(true); }
}, 30_000);

test("health reports an unreachable Hub without failing the Web process", async () => {
  const { child, url } = await start({ LUMIO_WEB_LISTEN: "127.0.0.1:0", LUMIO_WEB_HUB_URL: "http://127.0.0.1:9" });
  try {
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: false, version: "9.8.7", hub: { ok: false, error: "连接不上 Hub" } });
    expect((await fetch(`${url}/`)).status).toBe(200);
  } finally { child.kill(); await child.exited; }
}, 30_000);

test("compiled lumio-web explains an occupied port", async () => {
  const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
  try {
    const child = Bun.spawn([binary], { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir, LUMIO_WEB_LISTEN: `127.0.0.1:${taken.port}` }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("端口已被占用");
  } finally { taken.stop(true); }
}, 30_000);

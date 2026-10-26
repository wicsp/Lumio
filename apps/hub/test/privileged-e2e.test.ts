import { createConnection } from "node:net";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Job, Proposal, PrivilegedApproval } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { HubStore } from "../src/store.ts";

let temp: string, hub: Awaited<ReturnType<typeof startHub>>, token: string, runtimeToken: string, daemon: ReturnType<typeof Bun.spawn> | undefined;
let errors: Promise<string> | undefined;
const main = new URL("../../runtime/src/main.ts", import.meta.url).pathname;
async function api(path: string, body?: unknown) {
  return fetch(`http://127.0.0.1:${hub.server.port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await check()) return; if (daemon && daemon.exitCode !== null) throw Error(`runtime exited: ${await errors}`); await Bun.sleep(25); }
  throw Error("timed out");
}
async function get(id: string) { return Job.parse(await (await api(`/v1/jobs/${id}`)).json()); }
async function proposal() {
  let p: Proposal | undefined;
  await eventually(async () => { p = Proposal.array().parse(await (await api("/v1/proposals")).json())[0]; return !!p; }); return p!;
}
async function calls() { try { return (await readFile(join(temp, "calls"), "utf8")).trim().split("\n").filter(Boolean); } catch { return []; } }
async function start(timeout = "5", supported = true) {
  daemon = Bun.spawn([process.execPath, main], { env: {
    PATH: join(temp, "bin"), HOME: temp, LUMIO_HUB_URL: `http://127.0.0.1:${hub.server.port}`, LUMIO_TOKEN: runtimeToken,
    LUMIO_RUNTIME_NAME: "server", LUMIO_RUNTIME_STATE_DIR: join(temp, "rt"), LUMIO_RUNTIME_POLL_SECONDS: "0.03", LUMIO_RUNTIME_SUDO_TIMEOUT: timeout,
    ...(supported ? { LUMIO_RUNTIME_SUDO_COMMAND: `${process.execPath} ${join(temp, "helper.ts")} ${join(temp, "calls")}` } : {}),
    FAKE_RUNTIME_MAIN: main, FAKE_BUN: process.execPath,
  }, stdout: "ignore", stderr: "pipe" });
  errors = new Response(daemon.stderr as ReadableStream<Uint8Array>).text();
  await eventually(async () => (await (await api("/v1/runtimes")).json() as unknown[]).length === 1);
}
async function submit(prompt = "normal") {
  const response = await api("/v1/jobs", { runtime: "server", workdir: temp, run: { kind: "agent", engine: "pi", prompt } });
  expect(response.status).toBe(200); return Job.parse(await response.json());
}
async function done(id: string) { await eventually(async () => !!(await get(id)).result); return (await get(id)).result!; }
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-sudo-e2e-"));
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, join(temp, "vault"), { recursive: true });
  await Bun.write(join(temp, "bin/pi.ts"), `if (process.argv[2] === "--version") { console.log("1.4.0"); process.exit(0); }
const child = Bun.spawn([process.env.FAKE_BUN!, process.env.FAKE_RUNTIME_MAIN!, "sudo", "--", "/bin/echo", "hello world"], {env:process.env,stdout:"pipe",stderr:"pipe"});
const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
console.log(JSON.stringify({out,err,code,tokenLeaked:!!process.env.LUMIO_TOKEN})); process.exit(code);
`);
  await Bun.write(join(temp, "bin/pi"), `#!/bin/sh\nexec "${process.execPath}" "${join(temp, "bin/pi.ts")}" "$@"\n`); await chmod(join(temp, "bin/pi"), 0o755);
  await Bun.write(join(temp, "helper.ts"), `import {appendFileSync} from "node:fs";
const a=JSON.parse(await new Response(Bun.stdin.stream()).text());appendFileSync(process.argv[2]!,JSON.stringify(a)+"\\n");
const child=Bun.spawn(a.argv,{stdout:"pipe",stderr:"pipe"});
process.stdout.write(Buffer.from(await new Response(child.stdout).arrayBuffer()));process.stderr.write("helper stderr\\n");await child.exited;await Bun.sleep(300);process.exit(7);
`);
  const store = await HubStore.open(join(temp, "hub")); store.createActor("owner", "human"); store.createActor("server", "runtime");
  token = store.createToken("owner", "owner"); runtimeToken = store.createToken("server", "server"); store.close();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: join(temp, "vault"), LUMIO_STATE_DIR: join(temp, "hub") }), port: 0 }, { log() {} });
});
afterEach(async () => { if (daemon) { daemon.kill("SIGTERM"); await daemon.exited; daemon = undefined; } await hub?.stop(); await rm(temp, { recursive: true, force: true }); });

test("approval reaches fake root helper once and caller receives exact output and exit code; execution report is audited", async () => {
  await start(); const j = await submit(); const p = await proposal();
  expect(await calls()).toHaveLength(0);
  expect((await api(`/v1/proposals/${p.id}/accept`, {})).status).toBe(200);
  const result = await done(j.spec.id); expect(result.exit_code).toBe(7);
  const report = JSON.parse(result.report!);
  expect(report).toMatchObject({ out: "hello world\n", code: 7, tokenLeaked: false }); expect(report.err).toContain("helper stderr"); expect(report.err).toContain("等待用户批准");
  const received = await calls(); expect(received).toHaveLength(1); expect(PrivilegedApproval.parse(JSON.parse(received[0]!)).proposal).toBe(p.id);
  await eventually(() => !!hub.store.db.query("SELECT report FROM privileged_approvals WHERE report IS NOT NULL").get());
  const audits = JSON.stringify(hub.store.db.query("SELECT * FROM audit").all()); expect(audits).not.toContain("helper stderr"); expect(audits).toContain('exit_code');
  expect((await api(`/v1/proposals/${p.id}/accept`, {})).status).toBe(409); expect(await calls()).toHaveLength(1);
});

test("reject and timeout return failure without executing; late approval after timeout cannot execute", async () => {
  await start("0.5"); const j = await submit(); const p = await proposal(); await api(`/v1/proposals/${p.id}/reject`, {});
  const rejected = await done(j.spec.id); expect(JSON.parse(rejected.report!).code).toBe(1); expect(rejected.report).toContain("用户拒绝");
  const j2 = await submit(); const p2 = await proposal(); const timed = await done(j2.spec.id); expect(JSON.parse(timed.report!).code).toBe(1); expect(timed.report).toContain("超时");
  expect((await api(`/v1/proposals/${p2.id}/accept`, {})).status).toBe(409); expect(await calls()).toHaveLength(0);
});

test("unsupported runtime and outside-job invocation exit 2 without creating proposals", async () => {
  const outside = Bun.spawn([process.execPath, main, "sudo", "--", "/bin/echo"], { env: {}, stdout: "pipe", stderr: "pipe" });
  expect(await outside.exited).toBe(2); expect(await new Response(outside.stderr).text()).toContain("一轮之内");
  await start("5", false);
  const invalid = await new Promise<string>((resolve) => {
    const socket = createConnection(join(temp, "rt/sudo.sock")); let data = "";
    socket.once("connect", () => socket.write(JSON.stringify({ token: "invalid", argv: ["/bin/echo"] }) + "\n"));
    socket.on("data", (chunk) => { data += chunk.toString(); }); socket.once("end", () => resolve(data));
  });
  expect(JSON.parse(invalid).code).toBe(2);
  const j = await submit(); const result = await done(j.spec.id);
  expect(JSON.parse(result.report!).code).toBe(2); expect(result.report).toContain("不支持提权"); expect(hub.store.proposals("pending")).toHaveLength(0); expect(await calls()).toHaveLength(0);
});

test("job cancellation ends waiting requests and invalidates subsequent human approval", async () => {
  await start(); const j = await submit(); const p = await proposal();
  await api(`/v1/jobs/${j.spec.id}/cancel`, {}); expect(["cancelled", "failed"]).toContain((await done(j.spec.id)).status);
  expect((await api(`/v1/proposals/${p.id}/accept`, {})).status).toBe(409); expect(await calls()).toHaveLength(0);
});


test("execution report survives a Hub outage and runtime restart through its durable outbox", async () => {
  await start(); const j = await submit(); const p = await proposal();
  await api(`/v1/proposals/${p.id}/accept`, {});
  await eventually(async () => (await calls()).length === 1);
  const port = hub.server.port!; await hub.stop();
  await Bun.sleep(600);
  daemon!.kill("SIGTERM"); await daemon!.exited; daemon = undefined;
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: join(temp, "vault"), LUMIO_STATE_DIR: join(temp, "hub") }), port }, { log() {} });
  await start();
  await eventually(() => !!hub.store.db.query("SELECT report FROM privileged_approvals WHERE report IS NOT NULL").get());
  expect((await done(j.spec.id)).exit_code).toBe(7); expect(await calls()).toHaveLength(1);
});

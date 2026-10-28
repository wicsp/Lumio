import { afterEach, beforeEach, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Job, OperationResult, PrivilegedReport, PrivilegedStatus, privilegedSigningPayload } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";
import { signingKey } from "../src/pairing.ts";
import { Privileged } from "../src/privileged.ts";

let temp: string, hub: Awaited<ReturnType<typeof startHub>>, tokens: Record<string, string>, actor: string, now: number, logs: string[];
async function api(path: string, who = "server", body?: unknown) {
  return fetch(`http://127.0.0.1:${hub.server.port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function job() {
  const r = await api("/v1/jobs", "owner", { runtime: "server", run: { kind: "command", argv: ["/bin/echo", "safe"] } });
  const job = Job.parse(await r.json());
  await api("/v1/runtime/ack", "server", { accepted: [job.spec.id] }); return job;
}
const operation = (id: string, argv = ["/bin/echo", "hello world"]) => ({ op: "exec.privileged", args: { runtime: actor, job: id, argv } });
async function propose(id: string) {
  const r = await api("/v1/operations", "server", { operation: operation(id), reason: "第 1 轮的 agent 申请" });
  expect(r.status).toBe(202); const result = OperationResult.parse(await r.json());
  if (result.status !== "pending_approval") throw Error("not pending"); return result.proposal;
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-privileged-")); now = Date.now(); logs = []; tokens = {};
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, join(temp, "vault"), { recursive: true });
  const store = await HubStore.open(join(temp, "hub"));
  for (const [name, role] of [["owner", "human"], ["agent", "agent"], ["server", "runtime"], ["other", "runtime"]] as const) {
    const a = store.createActor(name, role); if (name === "server") actor = a.id;
    tokens[name] = store.createToken(name, name);
  }
  store.close();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: join(temp, "vault"), LUMIO_STATE_DIR: join(temp, "hub") }), port: 0 }, { now: () => new Date(now), log: (line) => logs.push(line) });
  await api("/v1/runtime/register", "server", { protocol_version: 2, name: "server", engines: [], tags: [], max_concurrent: 1 });
});
afterEach(async () => { await hub.stop(); await rm(temp, { recursive: true, force: true }); });

test("only an owning runtime can propose for a live job; every other operation/role is denied and pending requests are capped", async () => {
  const j = await job();
  for (const who of ["owner", "agent"]) expect((await api("/v1/operations", who, { operation: operation(j.spec.id), reason: "x" })).status).toBe(403);
  expect((await api("/v1/operations", "other", { operation: operation(j.spec.id), reason: "x" })).status).toBe(400);
  const otherId = hub.store.actors().find((a) => a.name === "other")!.id;
  expect((await api("/v1/operations", "other", { operation: { ...operation(j.spec.id), args: { ...operation(j.spec.id).args, runtime: otherId } }, reason: "x" })).status).toBe(409);
  expect((await api("/v1/operations", "server", { operation: { op: "task.dispatch", args: { task: "task_00000000000000000000000001", trigger: "cli" } } })).status).toBe(403);
  expect(hub.store.proposals("pending")).toHaveLength(0);
  for (let i = 0; i < 6; i++) expect((await api("/v1/operations", "server", { operation: operation(j.spec.id, ["/bin/echo", String(i)]), reason: "x" })).status).toBe(i < 5 ? 202 : 409);
  await api(`/v1/jobs/${j.spec.id}/cancel`, "owner", {});
  expect((await api("/v1/operations", "server", { operation: operation(j.spec.id), reason: "x" })).status).toBe(409);
});

test("human approval binds signer, argv, runtime and job; status is private; report is idempotent and output-free", async () => {
  const j = await job(), p = await propose(j.spec.id);
  expect(PrivilegedStatus.parse(await (await api(`/v1/runtime/privileged/${p.id}`)).json()).status).toBe("pending");
  expect((await api(`/v1/proposals/${p.id}/accept`, "agent", {})).status).toBe(403);
  expect((await api(`/v1/proposals/${p.id}/accept`, "server", {})).status).toBe(403);
  expect((await api(`/v1/runtime/privileged/${p.id}`, "other")).status).toBe(404);
  expect((await api(`/v1/runtime/privileged/${p.id}`, "owner")).status).toBe(403);
  expect((await api(`/v1/proposals/${p.id}/accept`, "owner", {})).status).toBe(200);
  expect((await api(`/v1/proposals/${p.id}/accept`, "owner", {})).status).toBe(409);
  const status = PrivilegedStatus.parse(await (await api(`/v1/runtime/privileged/${p.id}`)).json());
  if (status.status !== "accepted") throw Error("not accepted");
  const key = new Privileged(hub.store).publicKey();
  expect(verify(null, Buffer.from(privilegedSigningPayload(status.approval)), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key }, format: "jwk" }), Buffer.from(status.approval.signature, "base64url"))).toBe(true);
  expect(status.approval).toMatchObject({ ...operation(j.spec.id).args, approved_by: hub.store.actors().find((a) => a.name === "owner")!.id });
  const report = PrivilegedReport.parse({ proposal: p.id, job: j.spec.id, status: "done", exit_code: 0, finished: new Date(now).toISOString() });
  for (let i = 0; i < 2; i++) expect((await api("/v1/runtime/privileged", "server", report)).status).toBe(200);
  expect((await api("/v1/runtime/privileged", "server", { ...report, status: "failed" })).status).toBe(409);
  expect((await api("/v1/runtime/privileged", "server", { ...report, output: "not allowed" })).status).toBe(400);
  const rows = hub.store.db.query<{ execution_result: string }, [string]>("SELECT execution_result FROM audit WHERE proposal_id=?").all(p.id);
  expect(rows.filter((r) => r.execution_result?.startsWith('{"status"'))).toHaveLength(1);
  expect(rows.some((r) => r.execution_result === "pending_approval")).toBe(true); expect(rows.some((r) => r.execution_result === "accepted")).toBe(true);
  now += 600_001;
  expect(PrivilegedStatus.parse(await (await api(`/v1/runtime/privileged/${p.id}`)).json()).status).toBe("expired");
  const privateKey = hub.store.db.query<{ private_key: string }, []>("SELECT private_key FROM signing_key").get()!.private_key;
  expect(JSON.stringify(rows) + logs.join("") + JSON.stringify(status)).not.toContain(privateKey);
});

test("rejection never signs; cancellation/result before acceptance expires the proposal", async () => {
  const j = await job(), p = await propose(j.spec.id);
  await api(`/v1/proposals/${p.id}/reject`, "owner", {});
  expect(PrivilegedStatus.parse(await (await api(`/v1/runtime/privileged/${p.id}`)).json()).status).toBe("rejected");
  const p2 = await propose(j.spec.id);
  await api(`/v1/jobs/${j.spec.id}/cancel`, "owner", {});
  expect((await api(`/v1/proposals/${p2.id}/accept`, "owner", {})).status).toBe(409);
  expect(hub.store.proposal(p2.id)!.status).toBe("rejected");
  const j2 = await job(), p3 = await propose(j2.spec.id);
  await api("/v1/runtime/results", "server", { job: j2.spec.id, lease: j2.spec.lease, status: "done", finished: new Date(now).toISOString() });
  expect((await api(`/v1/proposals/${p3.id}/accept`, "owner", {})).status).toBe(409);
  expect(hub.store.db.query("SELECT * FROM privileged_approvals").all()).toHaveLength(0);
});

test("management prints the persistent public key and matching fingerprint, with the key preserved in a live backup", async () => {
  const key = new Privileged(hub.store).publicKey(); expect(Buffer.from(key, "base64url").length).toBe(32);
  for (const args of [["signing-key"], ["backup", join(temp, "backup.sqlite")], ["signing-key"]]) {
    const child = Bun.spawn([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, ...args], { env: { LUMIO_STATE_DIR: join(temp, "hub") }, stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(child.stdout).text()).trim(); expect(await child.exited).toBe(0);
    if (args[0] === "signing-key") {
      const remote = await api("/v1/runtime/signing-key");
      expect(await remote.json()).toEqual(signingKey(key));
      expect(out).toBe(`${key}\n指纹：${signingKey(key).fingerprint}`);
    }
  }
  const { Database } = await import("bun:sqlite");
  const backup = new Database(join(temp, "backup.sqlite"), { readonly: true });
  try { expect(backup.query<{ public_key: string }, []>("SELECT public_key FROM signing_key").get()!.public_key).toBe(key); } finally { backup.close(); }
});

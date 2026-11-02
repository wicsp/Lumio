import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routineJobId } from "@lumio/execution";
import { Job, JobResult } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";

let temp: string, hub: Awaited<ReturnType<typeof startHub>>, human: string, runtime: string, actor: string;
const task = "task_00000000000000000000000001", routine = "rtn_00000000000000000000000001";
const sensitive = "sk-" + "synthetic".repeat(5);
async function api(path: string, token: string, body?: unknown) {
  return fetch(`http://127.0.0.1:${hub.server.port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(20); }
  throw Error("timed out");
}
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "lumio-result-safety-"));
  const vault = join(temp, "vault");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  const common = `created: 2026-10-26T00:00:00Z\nupdated: 2026-10-26T00:00:00Z\nassignee: {agent: pi, device: server}\nworkdir: /tmp/synthetic-project\n`;
  await Bun.write(join(vault, "plan/tasks/safety.md"), `---\nid: ${task}\ntype: task\ntitle: 合成任务\nturn: human\n${common}---\n人写的要求。\n`);
  await Bun.write(join(vault, "plan/routines/safety.md"), `---\nid: ${routine}\ntype: routine\ntitle: 合成例行任务\nschedule: "*/10 * * * *"\ntimezone: UTC\n${common}---\n人写的要求。\n`);
  const store = await HubStore.open(join(temp, "hub"));
  store.createActor("owner", "human"); actor = store.createActor("server", "runtime").id;
  human = store.createToken("owner", "owner"); runtime = store.createToken("server", "server"); store.close();
  hub = await startHub({ ...readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: join(temp, "hub") }), port: 0 }, {
    log() {}, tasks: { tickMs: 3_600_000 }, routines: { tickMs: 20 },
  });
  await api("/v1/runtime/register", runtime, { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "1.4.0", sandbox: "none" }], tags: [], max_concurrent: 1 });
});
afterEach(async () => { await hub?.stop(); await rm(temp, { recursive: true, force: true }); });

for (const kind of ["task", "routine"] as const) for (const field of ["error", "engine.version"] as const) {
  test(`${kind}: sensitive ${field} is withheld from the note while the original result stays queryable`, async () => {
    let j: Job;
    if (kind === "task") {
      expect((await api("/v1/operations", human, { operation: { op: "task.dispatch", args: { task, trigger: "cli" } } })).status).toBe(200);
      j = Job.array().parse(await (await api(`/v1/jobs?task=${task}`, human)).json())[0]!;
      await api("/v1/runtime/ack", runtime, { accepted: [j.spec.id] });
    } else {
      await eventually(() => hub.routines.plans(actor).length === 1);
      j = hub.routines.adopt(actor, routineJobId(routine, new Date("2026-10-26T10:10:00Z")), new Date())!;
    }
    const result = JobResult.parse({ job: j.spec.id, lease: j.spec.lease, status: "failed", exit_code: 1, finished: new Date().toISOString(), report: "安全汇报",
      ...(field === "error" ? { error: sensitive } : { engine: { name: "pi", version: sensitive, sandbox: "none" } }) });
    expect((await api("/v1/runtime/results", runtime, result)).status).toBe(200);
    const note = () => readFile(join(temp, "vault", kind === "task" ? "plan/tasks/safety.md" : "plan/routines/safety.md"), "utf8");
    await eventually(async () => (await note()).includes(`lumio job show ${j.spec.id}`));
    const text = await note(); expect(text).not.toContain(sensitive); expect(text).toContain("疑似包含敏感信息"); expect(text).toContain("人写的要求。"); expect(text).toContain(`lumio job show ${j.spec.id}`);
    const stored = Job.parse(await (await api(`/v1/jobs/${j.spec.id}`, human)).json()); expect(stored.result).toEqual(result);
  });
}

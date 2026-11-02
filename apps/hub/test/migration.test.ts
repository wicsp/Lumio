import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MigrationPlan, MigrationEntry, WorkCommandResult, WorkTaskDetail, BackupManifest } from "@lumio/schema";
import { HubStore } from "../src/store.ts";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";

const task = "task_00000000000000000000000012", changedTask = "task_00000000000000000000000013", routine = "rtn_00000000000000000000000014";
test("management migration preserves sources, is repeatable, excludes the running Hub and makes old paths and IDs unable to dispatch after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-migrate-hub-")), state = join(root, "state"), vault = join(root, "vault");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  await mkdir(join(vault, "plan/routines"));
  await writeFile(join(vault, "plan/routines/Paused.md"), `---\nid: ${routine}\ntype: routine\ntitle: Paused\ncreated: 2026-10-31T00:00:00Z\nupdated: 2026-10-31T00:00:00Z\nschedule: '* * * * *'\ntimezone: UTC\nstatus: paused\nassignee: pi@server\n---\n原始定时输入\n`);
  const store = await HubStore.open(state); store.createActor("owner", "human"); const actor = store.createActor("server", "runtime");
  const human = store.createToken("owner", "owner"); store.registerRuntime(actor.id, { protocol_version: 2, name: "server", engines: [{ name: "pi", version: "1.4.0", sandbox: "none" }], tags: [], max_concurrent: 1 }, new Date()); store.close();
  const config = { ...readConfig({ LUMIO_STATE_DIR: state, LUMIO_VAULT: vault }), localRuntime: "server", port: 0 };
  let hub: Awaited<ReturnType<typeof startHub>> | undefined = await startHub(config, { log() {}, tasks: { quietMs: 0 } });
  const main = new URL("../src/main.ts", import.meta.url).pathname;
  async function manage(args: string[]) {
    const child = Bun.spawn([process.execPath, main, ...args], { env: { HOME: root, PATH: root, LUMIO_STATE_DIR: state }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr };
  }
  function request(path: string, body?: unknown) { return fetch(`http://127.0.0.1:${hub!.server.port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${human}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  try {
    const planFile = join(root, "plan.json"), backup = join(root, "backup");
    const planned = await manage(["migrate", "plan", "--vault", vault, "--output", planFile]); expect(planned.code).toBe(0);
    const plan = MigrationPlan.parse(JSON.parse(planned.stdout)); expect(plan.entries).toHaveLength(3); expect(plan.problems).toEqual([]);
    const original = await readFile(join(vault, "plan/tasks/Task.md"));
    const rejected = await manage(["migrate", "apply", "--vault", vault, "--plan", planFile, "--backup", backup, "--runtimes-prepared"]);
    expect(rejected.code).toBe(1); expect(rejected.stderr).toContain("另一个 Hub");
    await hub.stop(); hub = undefined;
    const saved = await manage(["backup", "business", backup]); expect(saved.code).toBe(0); BackupManifest.parse(JSON.parse(saved.stdout));
    for (let repeat = 0; repeat < 2; repeat++) {
      const applied = await manage(["migrate", "apply", "--vault", vault, "--plan", planFile, "--backup", backup, "--runtimes-prepared"]);
      expect(applied.stderr).toBe(""); expect(applied.code).toBe(0); expect(MigrationPlan.parse(JSON.parse(applied.stdout))).toEqual(plan);
    }
    const mapped = await manage(["migrate", "sources"]); expect(MigrationEntry.array().parse(JSON.parse(mapped.stdout))).toHaveLength(3);
    const exported = join(root, "original-task.md"), source = await manage(["migrate", "source", task, "--output", exported]); expect(source.code).toBe(0); expect(await readFile(exported)).toEqual(original);
    // Change both ID and control fields before startup: the original path is no longer a control surface.
    await writeFile(join(vault, "plan/tasks/Task.md"), original.toString().replace(task, changedTask).replace("assignee: human", "assignee: pi@server") + "\n旧文件的新指令\n");
    const routinePath = join(vault, "plan/routines/Paused.md"); await writeFile(routinePath, (await readFile(routinePath, "utf8")).replace("status: paused", "status: active"));
    hub = await startHub(config, { log() {}, tasks: { quietMs: 0 } });
    await hub.tasks.noteChanged("plan/tasks/Task.md"); await hub.tasks.tick(); await hub.routines.noteChanged("plan/routines/Paused.md"); await hub.routines.tick();
    expect(hub.store.db.query("SELECT * FROM jobs").all()).toEqual([]);
    expect(hub.modules.work.task(task).description).toBe("task content\n"); expect(hub.modules.routines.get(routine).status).toBe("paused");
    const oldDispatch = { operation: { op: "task.dispatch", args: { task: changedTask, trigger: "cli", to: "pi@server" } } };
    expect((await request("/v1/operations", oldDispatch)).status).toBe(409);
    await writeFile(join(vault, "plan/tasks/Copied.md"), original.toString().replace("assignee: human", "assignee: pi@server"));
    await hub.tasks.noteChanged("plan/tasks/Copied.md"); await hub.tasks.tick(); expect(hub.store.db.query("SELECT * FROM jobs").all()).toEqual([]);
    await writeFile(join(vault, "plan/tasks/BrandNew.md"), original.toString().replace(task, "task_00000000000000000000000099").replace("assignee: human", "assignee: pi@server"));
    await hub.tasks.noteChanged("plan/tasks/BrandNew.md"); await hub.tasks.tick(); expect(hub.store.db.query("SELECT * FROM jobs").all()).toEqual([]);
    const updated = await request("/v2/work/commands", { request_id: "synthetic-migrated-edit", operation: { op: "work.task.update", args: { task, expected_revision: 1, patch: { description: "数据库里的新描述" } } } });
    expect(updated.status).toBe(200); WorkCommandResult.parse(await updated.json());
    expect((await readFile(join(vault, "plan/tasks/Task.md"), "utf8"))).toContain("旧文件的新指令");
    const detail = WorkTaskDetail.parse(await (await request(`/v2/work/tasks/${task}`)).json()); expect(detail.task.description).toBe("数据库里的新描述");
    const dispatched = await request("/v2/work/commands", { request_id: "synthetic-migrated-dispatch", operation: { op: "work.task.dispatch", args: { task, to: "pi@server" } } });
    expect(dispatched.status).toBe(200); const result = WorkCommandResult.parse(await dispatched.json()); if (result.kind !== "job") throw new Error("job expected");
    expect(result.job.spec.run.kind === "agent" && result.job.spec.run.prompt).toContain("数据库里的新描述");
    expect(result.job.spec.run.kind === "agent" && result.job.spec.run.prompt).not.toContain("旧文件的新指令");
  } finally { await hub?.stop(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

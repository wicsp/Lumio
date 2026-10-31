import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobSpec, RuntimeInfo, RoutineSpec } from "@lumio/schema";
import { prepareMigration } from "../src/prepare-migration.ts";
import { Queue } from "../src/queue.ts";
import { RoutinePlans } from "../src/routines.ts";
import { RuntimeArchives } from "../src/archive.ts";
import { runRuntime } from "../src/runtime.ts";
import { readConfig } from "../src/config.ts";
const actor = "act_00000000000000000000000001", run = "job_00000000000000000000000001";
const job = (id = run) => JobSpec.parse({ protocol_version: 2, id, runtime: actor, lease: "synthetic-lease-0123456789", created: "2026-10-31T00:00:00Z", run: { kind: "command", argv: ["/synthetic"] }, workdir: "~", timeout_seconds: 60 });
const config = (root: string) => readConfig({ HOME: root, LUMIO_HUB_URL: "http://synthetic", LUMIO_TOKEN: "synthetic-token-not-a-secret", LUMIO_RUNTIME_NAME: "server", LUMIO_RUNTIME_STATE_DIR: root, LUMIO_RUNTIME_POLL_SECONDS: "0.01" });
const response = (body: unknown) => Response.json(body);
const fakeFetch = (handler: () => Promise<Response>): typeof fetch => Object.assign(handler, { preconnect: fetch.preconnect });

test("runtime lease excludes a second daemon and offline preparation; prepare refuses pending effects and only clears derived plans", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-prepare-runtime-")), controller = new AbortController();
  let ready!: () => void; const registered = new Promise<void>((resolve) => { ready = resolve; });
  const first = runRuntime(config(root), { signal: controller.signal, env: { HOME: root, PATH: root }, log() {}, fetch: fakeFetch(async () => {
    ready(); return response(RuntimeInfo.parse({ actor, registration: config(root).registration, last_seen: "2026-10-31T00:00:00Z", online: true }));
  }) });
  try {
    await registered;
    await expect(runRuntime(config(root), { signal: controller.signal })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(prepareMigration(root)).rejects.toMatchObject({ code: "CONFLICT" });
    controller.abort(); await first;
    const queue = new Queue(root), plans = new RoutinePlans(queue);
    try {
      plans.replace([RoutineSpec.parse({ routine: "rtn_00000000000000000000000001", revision: "old", schedule: "* * * * *", timezone: "UTC", lease: "synthetic-lease-0123456789", template: { run: { kind: "agent", engine: "pi", prompt: "old" }, workdir: "~", timeout_seconds: 60 } })], actor, new Date());
      queue.receive([job()]); await expect(prepareMigration(root)).rejects.toThrow("未完成执行");
      queue.finish({ job: run, lease: job().lease, status: "done", finished: "2026-10-31T00:00:00Z" });
      await expect(prepareMigration(root)).rejects.toThrow("待交付"); queue.delivered(run);
      queue.db.exec("CREATE TABLE IF NOT EXISTS privileged_outbox(proposal TEXT PRIMARY KEY,report TEXT)");
      queue.db.query("INSERT INTO privileged_outbox VALUES('synthetic','{}')").run(); await expect(prepareMigration(root)).rejects.toThrow("待交付"); queue.db.exec("DELETE FROM privileged_outbox");
      queue.db.query("INSERT INTO archive_outbox(id,job,path,record,state) VALUES('synthetic',?,'synthetic','{}','pending')").run(run);
      await expect(prepareMigration(root)).rejects.toThrow("待交付"); queue.db.exec("UPDATE archive_outbox SET state='confirmed'");
      await mkdir(join(root, "logs")); await writeFile(join(root, "logs/original.log"), "原始文件");
      const before = queue.jobs(); await prepareMigration(root);
      expect(plans.list()).toEqual([]); expect(queue.jobs()).toEqual(before); expect(await readFile(join(root, "logs/original.log"), "utf8")).toBe("原始文件");
      const child = Bun.spawn([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, "prepare-migration", "--state-dir", root], { env: { HOME: root, PATH: root }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(0); expect(stderr).toBe(""); expect(stdout).toContain("历史和日志保留");
    } finally { queue.close(); }
  } finally { controller.abort(); await first; await rm(root, { recursive: true, force: true }); }
});

test("an unexpected archive worker failure retries in the same runtime and never exposes the exception content", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-archive-worker-")), controller = new AbortController(), logs: string[] = []; let attempts = 0;
  try {
    await runRuntime(config(root), { signal: controller.signal, env: { HOME: root, PATH: root }, log: (line) => logs.push(line),
      archive: { retryNow() {}, async flush() { if (++attempts === 1) throw new Error("synthetic-token-not-a-secret"); controller.abort(); return 1; } },
      fetch: fakeFetch(async () => response(RuntimeInfo.parse({ actor, registration: config(root).registration, last_seen: "2026-10-31T00:00:00Z", online: true }))),
    });
    expect(attempts).toBe(2); expect(logs.some((line) => line.includes("稍后重试"))).toBe(true); expect(logs.join("\n")).not.toContain("synthetic-token-not-a-secret");
  } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
});

test("a later archive failure warns again after the previous filesystem problem recovered", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-archive-warning-")), queue = new Queue(root), logs: string[] = [];
  const archive = new RuntimeArchives(config(root), queue, fakeFetch(async () => { throw new Error("unexpected network"); }), (line) => logs.push(line));
  const signal = new AbortController().signal;
  async function broken(id: string) {
    queue.receive([job(id)]); queue.finish({ job: id, lease: job().lease, status: "failed", finished: "2026-10-31T00:00:00Z" });
    await mkdir(join(root, "events", id), { recursive: true }); await writeFile(join(root, "events", id, "000001.active.jsonl"), "partial");
  }
  try {
    await broken(run); await archive.flush(signal); await archive.flush(signal); expect(logs).toHaveLength(1);
    await rm(join(root, "events", run), { recursive: true }); await archive.flush(signal);
    await broken("job_00000000000000000000000002"); await archive.flush(signal); expect(logs).toHaveLength(2);
  } finally { queue.close(); await rm(root, { recursive: true, force: true }); }
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigration } from "../src/migrate.ts";
import { HubStore } from "../src/store.ts";
import { BusinessModules } from "../src/modules.ts";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";
import { verifyBusinessBackup } from "@lumio/storage";

for (const automatic of [false, true]) test(`task-v3 migration ${automatic ? "at startup" : "via CLI"} backs up once and records the system identity`, async () => {
  const state = await mkdtemp(join(tmpdir(), "lumio-task-model-"));
  const config = { ...readConfig({ HOME: state, LUMIO_STATE_DIR: state }), port: 0 };
  try {
    const store = await HubStore.open(state), owner = store.createActor("synthetic-owner", "human");
    const modules = new BusinessModules(config, store);
    const created = modules.work.command({ request_id: "synthetic-migrate-task-001", operation: { op: "work.task.create", args: { title: "Synthetic old task" } } }, owner.id);
    if (created.kind !== "task") throw new Error("task expected");
    modules.stop(); store.close();
    const db = new Database(join(state, "hub.sqlite"));
    try {
      db.exec(`DROP TABLE work_turns; ALTER TABLE work_tasks DROP COLUMN outcome; ALTER TABLE work_tasks DROP COLUMN turn; ALTER TABLE work_tasks DROP COLUMN plan;
        ALTER TABLE work_tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'waiting'; ALTER TABLE work_tasks ADD COLUMN assignee TEXT NOT NULL DEFAULT 'pi@old';
        ALTER TABLE work_executions ADD COLUMN acknowledged TEXT; DELETE FROM platform_migrations WHERE name='work-3'; DELETE FROM work_requests;`);
    } finally { db.close(); }
    if (automatic) { const hub = await startHub(config, { log() {} }); await hub.stop(); }
    else { const lines: string[] = []; await runMigration(["task-v3", "--json"], line => lines.push(line), { stateDir: state }); expect(JSON.parse(lines[0]!).migrated).toBe(1); }
    const hub = await startHub(config, { log() {} });
    try {
      const detail = hub.modules.work.detail(created.task.id);
      expect(detail.task).toMatchObject({ schema_version: 3, outcome: "open", turn: { holder: "external", reason: "waiting" } });
      expect(detail.turns).toHaveLength(1); expect(detail.turns[0]!.by).toBe(hub.store.workActor().id);
    } finally { await hub.stop(); }
    const lines: string[] = [];
    await runMigration(["task-v3", "--json"], line => lines.push(line), { stateDir: state }); expect(JSON.parse(lines[0]!)).toEqual({ migrated: 0 });
    const backups = await readdir(join(state, "backups")); expect(backups).toHaveLength(1);
    await verifyBusinessBackup(join(state, "backups", backups[0]!));
  } finally { await rm(state, { recursive: true, force: true }); }
});

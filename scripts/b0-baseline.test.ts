import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanRun, WorkCommandResult } from "../packages/schema/src/index.ts";
import { acquireStateLease, verifyBusinessBackup } from "../packages/storage/src/index.ts";
import { backfillBaseline } from "./b0-baseline.ts";

const human = "act_00000000000000000000000001", agent = "act_00000000000000000000000002";
const task = "task_00000000000000000000000001", project = "prj_00000000000000000000000001";
const now = "2026-11-16T00:00:00Z";
const plan = {
  plan: { stages: [
    { kind: "agent", id: "build", agent: "codex", instruction: "Build" },
    { kind: "checkpoint", id: "review", prompt: "Review" },
  ] },
  stage: "review", rounds: 1, approved: { at: now, by: human },
};

async function fixture(action: (root: string, db: Database) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lumio-b0-"));
  const db = new Database(join(root, "hub.sqlite"));
  try {
    db.exec(`
      CREATE TABLE migration_receipts (kind TEXT NOT NULL);
      INSERT INTO migration_receipts VALUES ('retire');
      CREATE TABLE actors (id TEXT PRIMARY KEY, role TEXT NOT NULL);
      CREATE TABLE work_projects (id TEXT PRIMARY KEY, created_by TEXT, updated_by TEXT);
      CREATE TABLE work_tasks (id TEXT PRIMARY KEY, created_by TEXT, updated_by TEXT, plan TEXT);
      CREATE TABLE work_purged_tasks (id TEXT PRIMARY KEY);
      CREATE TABLE work_requests (actor TEXT, request TEXT, result TEXT, PRIMARY KEY(actor,request));
      CREATE TABLE runtime_update_requests (owner TEXT, request TEXT, result TEXT, PRIMARY KEY(owner,request));
    `);
    db.query("INSERT INTO actors VALUES (?, 'human'), (?, 'agent')").run(human, agent);
    db.query("INSERT INTO work_projects VALUES (?, NULL, ?)").run(project, agent);
    db.query("INSERT INTO work_tasks VALUES (?, ?, NULL, ?)").run(task, agent, JSON.stringify(plan));
    db.query("INSERT INTO work_tasks VALUES ('purged', NULL, NULL, NULL)").run();
    db.query("INSERT INTO work_purged_tasks VALUES ('purged')").run();
    db.query("INSERT INTO work_requests VALUES (?, 'synthetic-request', ?)").run(agent, JSON.stringify({
      kind: "task", task: {
        schema_version: 3, type: "task", id: task, title: "Synthetic", description: "", revision: 1,
        outcome: "open", turn: { holder: "human", reason: "todo", since: now },
        created: now, updated: now, updated_by: agent, tags: [], dependencies: [], references: [],
        plan: { ...plan, stage: "end" },
      },
    }));
    db.query("INSERT INTO runtime_update_requests VALUES (?, ?, ?)").run(human, "synthetic-runtime-request", JSON.stringify({ policy: "manual", hold: false }));
    await action(root, db);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test("baseline backs up and verifies old state before filling work identities, plan progress and replay receipts", async () => fixture(async (root, db) => {
  const result = await backfillBaseline(root);
  expect(result.changed).toBe(5);
  await verifyBusinessBackup(result.backup);
  const before = new Database(join(result.backup, "hub.sqlite"), { readonly: true });
  try { expect(before.query("SELECT created_by FROM work_projects").get()).toEqual({ created_by: null }); }
  finally { before.close(); }
  expect(db.query("SELECT created_by,updated_by FROM work_projects").get()).toEqual({ created_by: human, updated_by: agent });
  expect(db.query("SELECT created_by,updated_by FROM work_tasks WHERE id=?").get(task)).toEqual({ created_by: agent, updated_by: human });
  expect(db.query("SELECT created_by FROM work_tasks WHERE id='purged'").get()).toEqual({ created_by: null });
  const stored = db.query<{ plan: string }, []>("SELECT plan FROM work_tasks WHERE plan IS NOT NULL").get()!;
  expect(PlanRun.parse(JSON.parse(stored.plan)).done).toEqual(["build"]);
  const saved = db.query<{ result: string }, []>("SELECT result FROM work_requests").get()!;
  expect(WorkCommandResult.parse(JSON.parse(saved.result))).toMatchObject({ kind: "task", task: {
    created_by: human, updated_by: agent, plan: { done: ["build", "review"] },
  } });
  const update = db.query<{ result: string }, []>("SELECT result FROM runtime_update_requests").get()!;
  expect(JSON.parse(update.result)).toEqual({ policy: "manual", desired: null, hold: false, report: null });
  expect((await backfillBaseline(root)).changed).toBe(0);
}));

test("baseline refuses an active Hub and rolls back data on a malformed plan", async () => fixture(async (root, db) => {
  const lease = await acquireStateLease(root);
  try { await expect(backfillBaseline(root)).rejects.toMatchObject({ code: "CONFLICT" }); }
  finally { lease.close(); }
  db.query("UPDATE work_tasks SET plan=? WHERE id=?").run(JSON.stringify({ ...plan, stage: "missing" }), task);
  await expect(backfillBaseline(root)).rejects.toThrow("missing stage");
  expect(db.query("SELECT created_by FROM work_projects").get()).toEqual({ created_by: null });
}));

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { idOf, HandoffPlan, PlanRun, WorkCommandResult, RuntimeUpdateView } from "../packages/schema/src/index.ts";
import { acquireStateLease, backupBusiness, verifyBusinessBackup } from "../packages/storage/src/index.ts";

function completePlan(value: Record<string, unknown>): PlanRun {
  if (value.done !== undefined) return PlanRun.parse(value);
  const plan = HandoffPlan.parse(value.plan);
  const index = value.stage === "end" ? plan.stages.length : plan.stages.findIndex(stage => stage.id === value.stage);
  if (index < 0) throw new Error("A saved handoff plan refers to a missing stage");
  return PlanRun.parse({ ...value, done: plan.stages.slice(0, index).map(stage => stage.id) });
}

/** Run against a stopped Hub, using the same exclusive lease as the server. */
export async function backfillBaseline(stateDir: string): Promise<{ backup: string; changed: number }> {
  const lease = await acquireStateLease(stateDir);
  try {
    const db = new Database(join(stateDir, "hub.sqlite"), { create: false, strict: true });
    try {
      if (!db.query("SELECT 1 FROM migration_receipts WHERE kind IN ('apply','retire') LIMIT 1").get()) {
        throw new Error("The Hub must have completed v2 apply or retire");
      }
      const humans = db.query<{ id: string }, []>("SELECT id FROM actors WHERE role='human' LIMIT 2").all();
      if (humans.length !== 1) throw new Error("The Hub must have exactly one human identity");
      const human = idOf("act").parse(humans[0]!.id);

      const backups = join(stateDir, "backups");
      await mkdir(backups, { mode: 0o700, recursive: true });
      const backup = join(backups, `b0-baseline-${randomUUID()}`);
      await backupBusiness(stateDir, backup);
      await verifyBusinessBackup(backup);

      const changed = db.transaction(() => {
        let count = db.query(`UPDATE work_projects SET created_by=coalesce(created_by,?),updated_by=coalesce(updated_by,?)
          WHERE created_by IS NULL OR updated_by IS NULL`).run(human, human).changes;
        count += db.query(`UPDATE work_tasks SET created_by=coalesce(created_by,?),updated_by=coalesce(updated_by,?)
          WHERE id NOT IN (SELECT id FROM work_purged_tasks) AND (created_by IS NULL OR updated_by IS NULL)`).run(human, human).changes;

        const tasks = db.query<{ id: string; plan: string }, []>(
          "SELECT id,plan FROM work_tasks WHERE plan IS NOT NULL AND json_type(plan,'$.done') IS NULL",
        ).all();
        for (const task of tasks) {
          db.query("UPDATE work_tasks SET plan=? WHERE id=?").run(JSON.stringify(completePlan(JSON.parse(task.plan))), task.id);
          count++;
        }

        const receipts = db.query<{ actor: string; request: string; result: string }, []>(`
          SELECT actor,request,result FROM work_requests WHERE json_extract(result,'$.kind') IN ('task','project')
        `).all();
        for (const receipt of receipts) {
          const result = JSON.parse(receipt.result);
          const object = result[result.kind];
          const planNeedsDone = object.plan != null && object.plan.done === undefined;
          if (object.created_by != null && object.updated_by != null && !planNeedsDone) continue;
          object.created_by ??= human;
          object.updated_by ??= human;
          if (planNeedsDone) object.plan = completePlan(object.plan);
          const parsed = WorkCommandResult.parse(result);
          db.query("UPDATE work_requests SET result=? WHERE actor=? AND request=?")
            .run(JSON.stringify(parsed), receipt.actor, receipt.request);
          count++;
        }
        // Replayed version-control requests must still return the original outcome.
        const updates = db.query<{ owner: string; request: string; result: string }, []>(`
          SELECT owner,request,result FROM runtime_update_requests
          WHERE json_type(result,'$.report') IS NULL OR json_type(result,'$.desired') IS NULL
        `).all();
        for (const { owner, request, result } of updates) {
          const view = JSON.parse(result);
          const parsed = RuntimeUpdateView.parse({ ...view, report: view.report ?? null, desired: view.desired ?? null });
          db.query("UPDATE runtime_update_requests SET result=? WHERE owner=? AND request=?")
            .run(JSON.stringify(parsed), owner, request);
          count++;
        }
        return count;
      }).immediate();
      return { backup, changed };
    } finally { db.close(); }
  } finally { lease.close(); }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { "state-dir": { type: "string" } }, args: Bun.argv.slice(2) });
  if (!values["state-dir"]) throw new Error("Usage: bun run scripts/b0-baseline.ts --state-dir <stopped Hub state directory>");
  console.log(JSON.stringify(await backfillBaseline(resolve(values["state-dir"]))));
}

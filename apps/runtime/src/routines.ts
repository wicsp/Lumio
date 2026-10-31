import { dueFires, parseCron, routineJobId } from "@lumio/execution";
import { JOB_PROTOCOL_VERSION, JobSpec, RoutineSpec } from "@lumio/schema";
import type { Queue } from "./queue.ts";

/**
 * 例行任务的计划（ADR 0019 第 6 节，P2-5）：Hub 同步过来，存在执行器本地；到点由执行器自己生成 Job，Hub 离线也照常。
 *
 * - 新收到的计划从收到的时刻开始算，不补以前的。
 * - 执行器离线（进程没运行）错过的触发：恢复后只补跑最近的一次，更早的跳过（Hub 写回结果时注明跳过了几次）。
 * - Job 编号由"例行任务 + 计划触发时间"确定；生成 Job 与推进"上次触发时间"在同一个事务里，重复生成只有一个 Job。
 * - 生成的 Job 不需要 Hub 确认（直接视为已确认），结果照常经待交回队列交给 Hub。
 */
export class RoutinePlans {
  constructor(private queue: Queue) {
    queue.db.exec(`CREATE TABLE IF NOT EXISTS routines (routine TEXT PRIMARY KEY, spec TEXT NOT NULL, actor TEXT NOT NULL, last_fired TEXT NOT NULL);`);
  }

  list(): { spec: RoutineSpec; actor: string; last_fired: string }[] {
    return this.queue.db.query<{ spec: string; actor: string; last_fired: string }, []>("SELECT spec, actor, last_fired FROM routines ORDER BY routine").all()
      .map((r) => ({ ...r, spec: RoutineSpec.parse(JSON.parse(r.spec)) }));
  }

  /** 用 Hub 给的全部计划替换本地计划。已有的例行任务保留上次触发时间。 */
  replace(specs: RoutineSpec[], actor: string, now: Date) {
    const db = this.queue.db;
    db.transaction(() => {
      const keep = new Set(specs.map((s) => s.routine));
      for (const { spec } of this.list()) if (!keep.has(spec.routine)) db.query("DELETE FROM routines WHERE routine=?").run(spec.routine);
      for (const spec of specs) {
        db.query(`INSERT INTO routines VALUES (?, ?, ?, ?) ON CONFLICT(routine) DO UPDATE SET spec=excluded.spec, actor=excluded.actor`)
          .run(spec.routine, JSON.stringify(spec), actor, now.toISOString());
      }
    })();
  }

  /** 到点的例行任务各生成一个 Job（只取最近的一次触发），返回生成的编号。 */
  fire(now: Date): string[] {
    const db = this.queue.db, fired: string[] = [];
    db.transaction(() => {
      for (const { spec, actor, last_fired } of this.list()) {
        let latest: Date | undefined;
        try { latest = dueFires(parseCron(spec.schedule), spec.timezone, new Date(last_fired), now).latest; } catch { continue; }
        if (!latest) continue;
        const id = routineJobId(spec.routine, latest);
        const job = JobSpec.parse({
          protocol_version: JOB_PROTOCOL_VERSION, id, source: { routine: spec.routine, round: 1, fired_at: latest.toISOString() },
          runtime: actor, lease: spec.lease, run: spec.template.run, workdir: spec.template.workdir,
          ...(spec.template.gpus ? { gpus: spec.template.gpus } : {}), timeout_seconds: spec.template.timeout_seconds, created: latest.toISOString(),
        });
        if (db.query("INSERT OR IGNORE INTO queue(id, spec, state, acked) VALUES (?, ?, 'queued', 1)").run(id, JSON.stringify(job)).changes) fired.push(id);
        db.query("UPDATE routines SET last_fired=? WHERE routine=?").run(latest.toISOString(), spec.routine);
      }
    })();
    return fired;
  }
}

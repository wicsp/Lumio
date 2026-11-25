import type { Database } from "bun:sqlite";
import { ExecutionOverviewItem, type ExecutionOverview } from "@lumio/schema";

const status = "json_extract(record, '$.status')";
const sourceTask = "json_extract(record, '$.spec.source.task')";
const created = "julianday(json_extract(record, '$.spec.created'))";
const live = `${status} IN ('queued', 'assigned', 'running')`;
const standalone = `${sourceTask} IS NULL AND ${status} IN ('waiting_for_human', 'failed', 'unknown')`;

// The covering index keeps prompts and reports out of both counts and ranking.
export const overviewIndex = `CREATE INDEX IF NOT EXISTS jobs_overview ON jobs(${sourceTask}, ${status}, ${created}, id)`;
export interface OverviewTurns {
  visible: string[];
  current: string[];
  needs: string[];
}

/** Called inside the Hub's read transaction with its snapshot of Work turns. */
export function readExecutionOverview(db: Database, turns: OverviewTurns, before?: string): ExecutionOverview | undefined {
  const cursor = before && db.query<{ time: number }, [string]>(
    `SELECT ${created} AS time FROM jobs WHERE id = ? AND ${sourceTask} IS NULL`,
  ).get(before);
  if (before && !cursor) return undefined;

  const activity = db.query<{ id: string; live_count: number }, [string, string]>(`
    WITH metadata AS MATERIALIZED (
      SELECT id, ${sourceTask} AS task, ${live} AS live, ${created} AS time FROM jobs INDEXED BY jobs_overview
    ), candidates AS (
      SELECT id, live, time,
        row_number() OVER (PARTITION BY coalesce(task, id) ORDER BY live DESC, time DESC, id DESC) AS priority
      FROM metadata WHERE task IS NULL OR id IN (SELECT value FROM json_each(?))
        OR (live AND task NOT IN (SELECT value FROM json_each(?)))
    )
    SELECT id, sum(live) OVER () AS live_count FROM candidates WHERE priority = 1
    ORDER BY live DESC, time DESC, id DESC LIMIT 5
  `).all(JSON.stringify(turns.current), JSON.stringify(turns.visible));

  const counts = db.query<{ execution: number; attention: number }, [string]>(`
    SELECT count(*) FILTER (WHERE ${live} OR (${standalone}) OR id IN (SELECT value FROM json_each(?))) AS execution,
      count(*) FILTER (WHERE ${standalone}) AS attention
    FROM jobs INDEXED BY jobs_overview
  `).get(JSON.stringify(turns.needs))!;
  const page = db.query<{ id: string }, (number | string)[]>(`
    SELECT id FROM jobs INDEXED BY jobs_overview WHERE ${standalone}
    ${cursor ? `AND (${created}, id) < (?, ?)` : ""}
    ORDER BY ${created} DESC, id DESC LIMIT 21
  `).all(...(cursor && before ? [cursor.time, before] : []));

  const selectItem = db.query<Record<string, string | number | null>, [number, string]>(`
    SELECT id, ${status} AS status, json_extract(record, '$.spec.created') AS created, ${sourceTask} AS task,
      json_extract(record, '$.spec.source.routine') AS routine, json_extract(record, '$.spec.source.round') AS round,
      json_extract(record, '$.spec.run.engine') AS engine,
      substr(coalesce(json_extract(record, '$.spec.run.engine'), json_extract(record, '$.spec.run.argv[0]'), ''), 1, 240) AS label,
      CASE WHEN ? THEN substr(CASE WHEN ${status} = 'waiting_for_human' THEN json_extract(record, '$.result.question')
        ELSE json_extract(record, '$.result.error') END, 1, 240) END AS preview
    FROM jobs WHERE id = ?
  `);
  const item = (id: string, preview: boolean) => {
    const row = selectItem.get(Number(preview), id)!;
    return ExecutionOverviewItem.parse(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)));
  };
  return {
    activity: activity.map(row => item(row.id, false)), activity_live_count: activity[0]?.live_count ?? 0,
    execution_count: counts.execution,
    standalone_attention: {
      total: counts.attention, items: page.slice(0, 20).map(row => item(row.id, true)),
      ...(page.length > 20 ? { next_before: page[19]!.id } : {}),
    },
  };
}

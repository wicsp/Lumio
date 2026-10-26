import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { RoutineFollowup, type Job } from "@lumio/schema";

const usage = "用法：lumio routine list [--json]；lumio routine followup <例行任务> <日期，如 2026-10-26 或 \"2026-10-26 09:00\"> [--json]";
const OUTCOME: Record<string, string> = { done: "完成", waiting_for_human: "有问题", failed: "失败", unknown: "情况不明", cancelled: "已取消",
  assigned: "执行中", running: "执行中", queued: "排队中" };

/** 时区里的本地日期时间，`2026-10-26 09:00`。 */
function localTime(iso: string, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** 例行任务（ADR 0019 第 6 节，P2-5）：列出、从某一次开出追问任务。只能经 Hub。 */
export async function runRoutines(args: string[], log: (line: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: "boolean" } } });
  const [action, reference, date] = positionals;
  const list = action === "list" && positionals.length === 1;
  const followup = action === "followup" && positionals.length === 3 && reference && date;
  if (!list && !followup) throw new Error(usage);
  const url = process.env.LUMIO_HUB_URL, token = process.env.LUMIO_TOKEN;
  if (!url || !token) throw new Error("routine 命令需要设置非空的 LUMIO_HUB_URL 和 LUMIO_TOKEN");
  const client = createClient({ url, token });
  const routines = await client.routines();
  if (list) {
    if (values.json) { log(JSON.stringify(routines)); return 0; }
    if (!routines.length) log("没有例行任务");
    for (const r of routines) {
      const state = r.problem ? `未生效：${r.problem}` : r.status === "paused" ? "已暂停" : `下次 ${r.next ? localTime(r.next, r.timezone) : "—"}  执行器 ${r.runtime ?? "—"}`;
      const last = r.last ? `上次 ${localTime(r.last.fired_at, r.timezone)} ${OUTCOME[r.last.status] ?? r.last.status}` : "还没有执行过";
      log(`${r.routine.title}  ${r.schedule}（${r.timezone}）  ${state}  ${last}`);
    }
    return 0;
  }
  const note = await client.show(reference!);
  if (note.note.type !== "routine" || !note.note.id) throw new Error("这不是一篇有 ID 的例行任务笔记");
  const routine = note.note.id;
  const timezone = routines.find((r) => r.routine.id === routine)?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const wanted = date!.trim().replace("T", " ");
  const runs = (await client.jobs(undefined, undefined, routine)).filter((j): j is Job & { spec: { source: { fired_at: string } } } => Boolean(j.spec.source?.fired_at));
  const matches = runs.filter((j) => localTime(j.spec.source.fired_at, timezone).startsWith(wanted));
  if (!matches.length) throw new Error(`${note.note.title} 在 ${wanted} 没有执行记录`);
  if (matches.length > 1) {
    throw new Error(`${wanted} 有 ${matches.length} 次执行，请写到分钟：${matches.map((j) => localTime(j.spec.source.fired_at, timezone)).join("、")}`);
  }
  const operation = RoutineFollowup.parse({ op: "routine.followup", args: { routine, job: matches[0]!.spec.id } });
  const result = await client.operation({ operation });
  if (values.json) { log(JSON.stringify(result)); return 0; }
  log(result.status === "applied" && result.note ? `已新建追问任务：${result.note.path}\n写下你的追问后，把 turn 改成 agent（或运行 lumio task continue）` : "已提交，等待批准");
  return 0;
}

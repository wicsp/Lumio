import { language } from "@lumio/platform";
import { text as msg } from "./messages.ts";
import { hubCredentials } from "./config.ts";
import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { RoutineFollowup, type Job } from "@lumio/schema";

const usage = () => msg("routines.usage_lumio_routine_list_json_lumio_routine_followup_routine_date_e");
const outcomes = (): Record<string, string> => ({ done: msg("tasks.completed"), waiting_for_human: msg("routines.has_a_question"), failed: msg("tasks.failed"), unknown: msg("tasks.unknown"), cancelled: msg("tasks.cancelled"),
  assigned: msg("tasks.running"), running: msg("tasks.running"), queued: msg("tasks.queued") });

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
  if (!list && !followup) throw new Error(usage());
  const { url, token } = hubCredentials();
  const client = createClient({ language: language(), url, token });
  const routines = await client.routines();
  if (list) {
    if (values.json) { log(JSON.stringify(routines)); return 0; }
    if (!routines.length) log(msg("execution-routines.no_routines"));
    for (const r of routines) {
      const state = r.problem ? msg("routines.inactive", r.problem) : r.status === "paused" ? msg("execution-routines.paused") : msg("routines.next_runtime", r.next ? localTime(r.next, r.timezone) : "—", r.runtime ?? "—");
      const last = r.last ? msg("routines.last", localTime(r.last.fired_at, r.timezone), outcomes()[r.last.status] ?? r.last.status) : msg("routines.no_runs_yet");
      log(`${r.routine.title}  ${r.schedule}（${r.timezone}）  ${state}  ${last}`);
    }
    return 0;
  }
  const note = await client.show(reference!);
  if (note.note.type !== "routine" || !note.note.id) throw new Error(msg("routines.this_is_not_a_routine_note_with_an_id"));
  const routine = note.note.id;
  const timezone = routines.find((r) => r.routine.id === routine)?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const wanted = date!.trim().replace("T", " ");
  const runs = (await client.jobs(undefined, undefined, routine)).filter((j): j is Job & { spec: { source: { fired_at: string } } } => Boolean(j.spec.source?.fired_at));
  const matches = runs.filter((j) => localTime(j.spec.source.fired_at, timezone).startsWith(wanted));
  if (!matches.length) throw new Error(msg("routines.no_run_record_for_at", note.note.title, wanted));
  if (matches.length > 1) {
    throw new Error(msg("routines.has_runs_specify_the_minute", wanted, matches.length, matches.map((j) => localTime(j.spec.source.fired_at, timezone)).join("、")));
  }
  const operation = RoutineFollowup.parse({ op: "routine.followup", args: { routine, job: matches[0]!.spec.id } });
  const result = await client.operation({ operation });
  if (values.json) { log(JSON.stringify(result)); return 0; }
  log(result.status === "applied" && result.note ? msg("routines.created_followup_task_write_your_followup_then_set_turn_to_agent_or", result.note.path) : msg("routines.submitted_waiting_for_approval"));
  return 0;
}

import { errorMessage, text as msg } from "./messages.ts";
import { language } from "@lumio/platform";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createClient, ApiClientError } from "@lumio/api-client";
import { ExecutionRoutineCommandRequest, WorkCommandRequest, textContainsCardNumber } from "@lumio/schema";
import { hubCredentials } from "./config.ts";

/** Return undefined only before a v2 object resolves, so failed mutations are never repeated through v1. */
export async function runExecutionRoutines(args: string[], log: (line: string) => void): Promise<number | undefined> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    json: { type: "boolean" }, legacy: { type: "boolean" }, schedule: { type: "string" }, timezone: { type: "string" }, to: { type: "string" },
    description: { type: "string" }, file: { type: "string" }, patch: { type: "string" }, revision: { type: "string" }, status: { type: "string" },
    context: { type: "string" }, "request-id": { type: "string" },
  } });
  if (values.legacy) return;
  const [action, reference, date] = positionals;
  if (!action) throw new Error(msg("execution-routines.usage_lumio_routine_new_list_show_edit_update_status_followup_add_le"));
  if (!["new", "create", "list"].includes(action) && !/^rtn_[0-9A-HJKMNP-TV-Z]{26}$/.test(reference ?? "")) return;
  const client = createClient({ ...hubCredentials(), language: language() }), request = values["request-id"] ?? randomUUID();
  const send = (op: string, fields: object) => client.executionCommand(ExecutionRoutineCommandRequest.parse({ request_id: request, operation: { op, args: fields } }));
  const emit = (value: unknown) => log(values.json ? JSON.stringify(value) : typeof value === "object" && value && "title" in value ? `${value.title}（${"id" in value ? value.id : ""}）` : JSON.stringify(value));
  if (action === "new" || action === "create") {
    emit(await send("execution.routine.create", { title: positionals.slice(1).join(" "), schedule: values.schedule, timezone: values.timezone,
      assignee: values.to, context: values.context, description: values.file ? await readFile(values.file, "utf8") : values.description })); return 0;
  }
  let resolved = false;
  try {
    if (action === "list") {
      const rows = await client.executionRoutines(); resolved = true;
      if (values.json) log(JSON.stringify(rows)); else {
        if (!rows.length) log(msg("execution-routines.no_routines"));
        for (const row of rows) log(`${row.routine.id}  ${row.routine.title}  ${row.routine.schedule}（${row.routine.timezone}）  ${row.problem ?? (row.routine.status === "paused" ? msg("execution-routines.paused") : msg("execution-routines.next", row.next ?? "—"))}  ${row.last ? msg("execution-routines.last", row.last.status) : msg("execution-routines.not_run_yet")}`);
      }
      return 0;
    }
    const current = await client.executionRoutine(reference!); resolved = true;
    if (action === "show") { emit(current); if (!values.json) log(current.description); return 0; }
    if (action === "followup") {
      if (!date) throw new Error(msg("execution-routines.specify_a_run_s_job_id_or_date_and_time"));
      const local = (iso: string) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: current.timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso)).map((v) => [v.type, v.value]));
        return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
      };
      const runs = (await client.jobs(undefined, undefined, current.id)).filter((job) => job.spec.source?.fired_at && (job.spec.id === date || local(job.spec.source.fired_at).startsWith(date.replace("T", " "))));
      if (runs.length !== 1) throw new Error(runs.length ? msg("execution-routines.multiple_runs_on_this_date_specify_the_minute_or_job_id") : msg("execution-routines.run_not_found"));
      const job = runs[0]!, report = job.result?.report ?? msg("execution-routines.no_report");
      const sensitive = textContainsCardNumber(report) || /\b(?:sk-|gh[pousr]_|github_pat_|AKIA|xox[abprs]-|lumio_)[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(report);
      const { workdir, model, gpus, timeout_minutes } = current;
      emit(await client.workCommand(WorkCommandRequest.parse({ request_id: request, operation: { op: "work.task.create", args: {
        title: msg("execution-routines.followup", current.title, local(job.spec.source!.fired_at!)), assignee: "human", workdir, model, gpus, timeout_minutes,
        description: msg("execution-routines.source_run_result", values.description ?? msg("execution-routines.write_your_followup_here"), sensitive ? msg("execution-routines.report_may_contain_sensitive_information_use_lumio_job_show_to_view") : report.slice(0, 20_000)),
        references: [{ module: "execution", id: current.id }, { module: "execution", id: job.spec.id }],
      } } }))); return 0;
    }
    const expected_revision = values.revision === undefined ? current.revision : Number(values.revision);
    if (action === "edit") {
      if (values.file && values.revision === undefined) throw new Error(msg("execution-routines.saving_text_with_file_requires_revision"));
      const directory = values.file ? undefined : await mkdtemp(join(tmpdir(), "lumio-routine-edit-"));
      const path = values.file ?? join(directory!, "description.md");
      if (directory) {
        await writeFile(path, current.description, { mode: 0o600 });
        const editor = (process.env.VISUAL ?? process.env.EDITOR ?? "vi").trim().split(/\s+/);
        const child = Bun.spawn([...editor, path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        if (await child.exited) throw new Error(msg("execution-routines.editor_failed_text_saved_at", path));
      }
      try {
        const result = await send("execution.routine.update", { routine: current.id, expected_revision, patch: { description: await readFile(path, "utf8") } });
        emit(result); if (directory) await rm(directory, { recursive: true }); return 0;
      } catch (cause) {
        if (cause instanceof ApiClientError) throw new ApiClientError({ code: cause.code, message: msg("execution-routines.edited_text_saved_at", errorMessage(cause), path) }, cause.status);
        throw new Error(msg("execution-routines.could_not_save_text_edited_text_saved_at", path));
      }
    }
    let patch: unknown;
    if (action === "status") patch = { status: values.status ?? date };
    else if (action === "update" && values.patch) { try { patch = JSON.parse(values.patch); } catch { throw new Error(msg("execution-routines.patch_must_be_a_json_object")); } }
    else throw new Error(msg("execution-routines.use_update_patch_edit_or_status_to_update"));
    emit(await send("execution.routine.update", { routine: current.id, expected_revision, patch })); return 0;
  } catch (cause) {
    if (!resolved && cause instanceof ApiClientError && cause.status === 404 && ["list", "show", "followup"].includes(action)) return;
    throw cause;
  }
}

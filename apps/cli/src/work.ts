import { errorMessage, text as msg } from "./messages.ts";
import { language } from "@lumio/platform";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiClientError, createClient } from "@lumio/api-client";
import { HandoffPlan, WorkCommandRequest, idOf, type WorkCommandResult, type WorkTask, type WorkTaskDetail } from "@lumio/schema";
import { hubCredentials } from "./config.ts";

import { WORK_OPTIONS as options } from "./command-definitions.ts";

const usage = () => msg("work.usage_lumio_task_new_list_show_update_edit_status_assign_comment_con");

/** Returns undefined only when an old task command must use the v1 compatibility path. */
export async function runWork(kind: "task" | "project", args: string[], log: (line: string) => void): Promise<number | undefined> {
  if (kind === "task" && args.includes("--legacy")) return;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options });
  const [action, reference, ...rest] = positionals;
  if (values.ready && values.blocked) throw new Error(msg("work.readiness_exclusive"));
  if (!action || !["new", "create", "list", "show", "update", "edit", "status", "assign", "comment", "continue", "hand", "finish", "cancel", "reopen", "ack", "plan", "checkpoint"].includes(action)) {
    if (kind === "task") return;
    throw new Error(usage());
  }
  if (kind === "task" && ["status", "assign", "ack"].includes(action)) throw new Error(msg("work.use_turn_commands"));
  const client = createClient({ ...hubCredentials(), language: language(), onOfflineTargets: targets => console.error(msg("targets.offline", targets.join(", "))) });
  const emit = (value: unknown) => log(values.json ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2));
  const send = async (op: string, payload: Record<string, unknown>): Promise<WorkCommandResult> => client.workCommand(WorkCommandRequest.parse({
    request_id: values["request-id"] ?? randomUUID(), operation: { op, args: payload },
  }));
  let resolved = false;
  try {
    if (kind === "task" && action === "plan") {
      const taskId = rest[0];
      if (!["set", "show"].includes(reference ?? "") || rest.length !== 1 || !taskId || (reference === "set" && !values.file)) throw new Error(msg("work.plan_usage"));
      const task = (await client.workTask(taskId)).task;
      if (reference === "show") emit(task.plan ?? null);
      else emit(await send("work.task.plan.set", { task: taskId, expected_revision: values.revision === undefined ? task.revision : Number(values.revision),
        plan: await readPlan(values.file!, true), from: values.from }));
      return 0;
    }
    if (kind === "task" && action === "checkpoint") {
      if (!reference || rest.length || !values.stage || !values.action || !["continue", "send-back", "finish", "hold"].includes(values.action)) throw new Error(msg("work.checkpoint_usage"));
      emit(await send("work.task.checkpoint", { task: reference, stage: values.stage, action: values.action.replace("-", "_"), back_to: values["back-to"], comment: values.comment }));
      return 0;
    }
    if (action === "list") {
      if (reference) throw new Error(usage());
      if (kind === "project") {
        const projects = await client.workProjects({ status: values.status });
        if (values.json) emit(projects); else for (const project of projects) log(`${project.id}  ${project.status}  ${project.title}`);
      } else {
        const tasks = await client.workTasks({ project: values.project, status: values.status, query: values.query,
          readiness: values.ready ? "ready" : values.blocked ? "blocked" : undefined, tag: values.tag, parent: values.parent });
        const groups = ["me", "agents", "external", "hold"] as const;
        if (values.turn && !groups.includes(values.turn as typeof groups[number])) throw new Error(msg("work.invalid_turn"));
        const group = (task: typeof tasks[number]) => task.turn.holder === "human" ? "me" : task.turn.holder === "external" ? "external" : task.turn.holder === "nobody" ? "hold" : "agents";
        const filtered = tasks.filter(task => !values.turn || group(task) === values.turn);
        if (values.json) emit(filtered); else for (const key of groups) {
          const rows = filtered.filter(task => group(task) === key);
          if (!rows.length) continue;
          log(msg(`work.turn.${key}`));
          for (const task of rows) {
            const blocked = taskBlockedLabel(task);
            log(`${task.id}  ${task.outcome}  ${task.turn.holder} (${task.turn.reason})  ${task.title}${blocked ? `  ${blocked}` : ""}`);
          }
        }
      }
      return 0;
    }
    if (!reference) throw new Error(usage());
    if (action === "new" || action === "create") {
      if (rest.length) throw new Error(msg("work.quote_titles_containing_spaces"));
      if (kind === "task" && (values.to || values.status)) throw new Error(msg("work.use_turn_commands"));
      const description = values.file ? await readFile(values.file, "utf8") : values.description;
      const fields = kind === "project" ? { goal: values.goal, repo: values.repo, deadline: values.deadline, workdir: values.workdir }
        : { project: values.project, parent: values.parent,
          dependencies: values.depends?.split(",").filter(Boolean), due: values.due, workdir: values.workdir, model: values.model,
          timeout_minutes: values.timeout === undefined ? undefined : Number(values.timeout), gpus: values.gpus?.split(",").map(Number) };
      const result = await send(`work.${kind}.create`, { title: reference, description, ...fields });
      if (values.json) emit(result); else if (result.kind === "task") log(`${result.task.id}  ${result.task.title}`); else if (result.kind === "project") log(`${result.project.id}  ${result.project.title}`);
      return 0;
    }
    if (kind === "task" && !idOf("task").safeParse(reference).success && ["show", "continue"].includes(action)) return;
    const taskDetail = kind === "task" ? await client.workTask(reference) : undefined;
    const current = taskDetail?.task ?? await client.workProject(reference);
    resolved = true;
    if (action === "show") {
      if (values.json) emit(taskDetail ?? current);
      else {
        const relations = taskDetail ? `\n\n${formatTaskRelations(taskDetail, await client.workTasks())}\n\n${JSON.stringify(taskDetail, null, 2)}` : "";
        log(`${current.id}  ${current.type === "task" ? `${current.outcome} / ${current.turn.holder} (${current.turn.reason})` : current.status}  ${current.title}\n\n${current.description}${relations}`);
      }
      return 0;
    }
    if (action === "continue" && kind === "task") {
      const result = await send("work.task.dispatch", { task: reference, to: values.to, comment: values.comment, expected_revision: values.revision === undefined ? current.revision : Number(values.revision) });
      if (values.json) emit(result.kind === "job" ? result.job : result); else if (result.kind === "job") log(msg("work.dispatched", result.job.spec.id)); else emit(result);
      return 0;
    }
    if (["hand", "finish", "cancel", "reopen"].includes(action) && kind === "task") {
      const payload = { task: reference, expected_revision: values.revision === undefined ? current.revision : Number(values.revision) };
      emit(await send(action === "hand" ? "work.task.hand" : action === "reopen" ? "work.task.reopen" : "work.task.finish",
        { ...payload, ...(action === "hand" ? { to: values.to, note: values.note } : action === "reopen" ? {} : { outcome: action === "finish" ? "done" : "cancelled" }) }));
      return 0;
    }
    if (action === "comment" && kind === "task") {
      const body = values.file ? await readFile(values.file, "utf8") : rest.join(" ");
      const result = await send("work.task.comment", { task: reference, body }); emit(result); return 0;
    }
    let patch: Record<string, unknown>;
    if (action === "edit") {
      if (values.file && values.revision === undefined) throw new Error(msg("work.submitting_existing_text_with_file_requires_revision_read_the_revisi"));
      let directory: string | undefined;
      const path = values.file ?? join(directory = await mkdtemp(join(tmpdir(), "lumio-edit-")), "description.md");
      if (!values.file) {
        await writeFile(path, current.description, { mode: 0o600 });
        const editor = process.env.VISUAL ?? process.env.EDITOR;
        if (!editor) throw new Error(msg("work.set_visual_editor_or_submit_text_with_file_edit_copy_saved_at", path));
        const argv = editor.trim().split(/\s+/);
        const child = Bun.spawn([...argv, path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        if (await child.exited) throw new Error(msg("execution-routines.editor_failed_text_saved_at", path));
      }
      const description = await readFile(path, "utf8");
      try {
        const result = await send(`work.${kind}.update`, { [kind]: reference, expected_revision: values.revision === undefined ? current.revision : Number(values.revision), patch: { description } });
        emit(result); if (directory) await rm(directory, { recursive: true }); return 0;
      } catch (cause) {
        const message = cause instanceof ApiClientError ? errorMessage(cause) : msg("work.could_not_save_text");
        if (cause instanceof ApiClientError) throw new ApiClientError({ code: cause.code, message: msg("execution-routines.edited_text_saved_at", message, path),
          reason: cause.reason, operation: cause.operation, proposal: cause.proposal }, cause.status);
        throw new Error(msg("execution-routines.edited_text_saved_at", message, path));
      }
    } else if (values.patch) {
      try { patch = JSON.parse(values.patch); } catch { throw new Error(msg("execution-routines.patch_must_be_a_json_object")); }
    } else if (action === "update") {
      const fields = current.type === "project" ? { goal: values.goal, repo: values.repo, deadline: values.deadline, workdir: values.workdir }
        : { project: values.project, parent: values.parent, dependencies: values.depends?.split(",").filter(Boolean), due: values.due, workdir: values.workdir, model: values.model,
          gpus: values.gpus?.split(",").map(Number), timeout_minutes: values.timeout === undefined ? undefined : Number(values.timeout) };
      patch = Object.fromEntries(Object.entries({ ...fields, description: values.file ? await readFile(values.file, "utf8") : values.description }).filter(([, value]) => value !== undefined));
    } else if (action === "status") patch = { status: values.status ?? rest[0] };
    else throw new Error(msg("work.use_patch_to_update_use_edit_for_text_status_for_status_and_assign_f"));
    const result = await send(`work.${kind}.update`, { [kind]: reference, expected_revision: values.revision === undefined ? current.revision : Number(values.revision), patch });
    emit(result); return 0;
  } catch (cause) {
    if (!resolved && kind === "task" && cause instanceof ApiClientError && cause.status === 404 && ["list", "show", "continue"].includes(action)) return;
    throw cause;
  }
}

async function readPlan(path: string, nullable = false): Promise<HandoffPlan | null> {
  const content = await readFile(path, "utf8");
  try {
    const value: unknown = JSON.parse(content);
    return nullable && value === null ? null : HandoffPlan.parse(value);
  } catch { throw new Error(msg("work.invalid_plan_file")); }
}

export async function runPlanTemplates(args: string[], log: (line: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    file: { type: "string" }, template: { type: "string" }, json: { type: "boolean" }, "request-id": { type: "string" },
  } });
  const [action, reference, ...rest] = positionals;
  if (rest.length || !["list", "save", "delete"].includes(action ?? "") || (action === "list" ? Boolean(reference) : !reference)
    || (action === "save" && !values.file)) throw new Error(msg("work.template_usage"));
  const client = createClient({ ...hubCredentials(), language: language() });
  const requestId = values["request-id"] ?? randomUUID();
  if (action === "list") {
    const templates = await client.workPlanTemplates();
    if (values.json) log(JSON.stringify(templates)); else for (const value of templates) log(`${value.id}  ${value.name}`);
  } else {
    const value = action === "save" ? await client.saveWorkPlanTemplate({ name: reference!, plan: (await readPlan(values.file!))!, template: values.template }, requestId)
      : await client.deleteWorkPlanTemplate(reference!, requestId);
    log(JSON.stringify(value, null, values.json ? undefined : 2));
  }
  return 0;
}

export async function runAttention(args: string[], log: (line: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
  if (positionals.length) throw new Error(msg("attention.usage"));
  const items = await createClient({ ...hubCredentials(), language: language() }).workAttention();
  if (values.json) log(JSON.stringify(items));
  else if (!items.length) log(msg("attention.empty"));
  else for (const item of items) log(`${item.task}  ${msg(`attention.${item.kind}`)}  ${item.title}\n${item.question ?? item.summary ?? ""}`);
  return 0;
}

/** Dependency facts are layered over the existing turn; piped output stays plain text. */
export function taskBlockedLabel(task: WorkTask, terminal = process.stdout.isTTY === true && process.env.TERM !== "dumb"): string {
  const count = task.outcome === "open" ? task.blocked_by?.length ?? 0 : 0;
  return count ? `${terminal ? "⛓ " : ""}${msg("work.waiting_for", count)}` : "";
}

export function formatTaskRelations(detail: WorkTaskDetail, visible: WorkTask[]): string {
  const tasks = new Map(visible.map(task => [task.id, task]));
  const section = (key: string, ids: string[]) => [msg(key), ...(ids.length ? ids.map(id => {
    const task = tasks.get(id);
    return task ? `  ${id}  ${task.title} (${msg(`work.outcome.${task.outcome}`)})` : `  ${id}  ${msg("work.deleted_task")}`;
  }) : [`  ${msg("tasks.none")}`])].join("\n");
  return [section("work.prerequisites", detail.task.dependencies), section("work.dependents", detail.dependents), section("work.children", detail.children)].join("\n\n");
}

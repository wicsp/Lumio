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
  if (!action) throw new Error("用法：lumio routine new|list|show|edit|update|status|followup；旧笔记加 --legacy");
  if (!["new", "create", "list"].includes(action) && !/^rtn_[0-9A-HJKMNP-TV-Z]{26}$/.test(reference ?? "")) return;
  const client = createClient(hubCredentials()), request = values["request-id"] ?? randomUUID();
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
        if (!rows.length) log("没有例行任务");
        for (const row of rows) log(`${row.routine.id}  ${row.routine.title}  ${row.routine.schedule}（${row.routine.timezone}）  ${row.problem ?? (row.routine.status === "paused" ? "已暂停" : `下次 ${row.next ?? "—"}`)}  ${row.last ? `上次 ${row.last.status}` : "尚未执行"}`);
      }
      return 0;
    }
    const current = await client.executionRoutine(reference!); resolved = true;
    if (action === "show") { emit(current); if (!values.json) log(current.description); return 0; }
    if (action === "followup") {
      if (!date) throw new Error("请指定一次执行的 Job ID 或日期时间");
      const local = (iso: string) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: current.timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso)).map((v) => [v.type, v.value]));
        return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
      };
      const runs = (await client.jobs(undefined, undefined, current.id)).filter((job) => job.spec.source?.fired_at && (job.spec.id === date || local(job.spec.source.fired_at).startsWith(date.replace("T", " "))));
      if (runs.length !== 1) throw new Error(runs.length ? "这一天有多次执行，请写到分钟或提供 Job ID" : "找不到这一次执行");
      const job = runs[0]!, report = job.result?.report ?? "（没有汇报）";
      const sensitive = textContainsCardNumber(report) || /\b(?:sk-|gh[pousr]_|github_pat_|AKIA|xox[abprs]-|lumio_)[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(report);
      const { workdir, model, gpus, timeout_minutes } = current;
      emit(await client.workCommand(WorkCommandRequest.parse({ request_id: request, operation: { op: "work.task.create", args: {
        title: `${current.title} · ${local(job.spec.source!.fired_at!)} 追问`, assignee: "human", workdir, model, gpus, timeout_minutes,
        description: `${values.description ?? "在这里写下追问。"}\n\n## 来源执行结果\n\n${sensitive ? "汇报疑似包含敏感信息，请用 lumio job show 查看。" : report.slice(0, 20_000)}`,
        references: [{ module: "execution", id: current.id }, { module: "execution", id: job.spec.id }],
      } } }))); return 0;
    }
    const expected_revision = values.revision === undefined ? current.revision : Number(values.revision);
    if (action === "edit") {
      if (values.file && values.revision === undefined) throw new Error("使用 --file 保存正文时必须提供 --revision");
      const directory = values.file ? undefined : await mkdtemp(join(tmpdir(), "lumio-routine-edit-"));
      const path = values.file ?? join(directory!, "description.md");
      if (directory) {
        await writeFile(path, current.description, { mode: 0o600 });
        const editor = (process.env.VISUAL ?? process.env.EDITOR ?? "vi").trim().split(/\s+/);
        const child = Bun.spawn([...editor, path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        if (await child.exited) throw new Error(`编辑器退出失败，正文保存在 ${path}`);
      }
      try {
        const result = await send("execution.routine.update", { routine: current.id, expected_revision, patch: { description: await readFile(path, "utf8") } });
        emit(result); if (directory) await rm(directory, { recursive: true }); return 0;
      } catch (cause) {
        if (cause instanceof ApiClientError) throw new ApiClientError({ code: cause.code, message: `${cause.message}；编辑内容保存在 ${path}` }, cause.status);
        throw new Error(`无法保存正文；编辑内容保存在 ${path}`);
      }
    }
    let patch: unknown;
    if (action === "status") patch = { status: values.status ?? date };
    else if (action === "update" && values.patch) { try { patch = JSON.parse(values.patch); } catch { throw new Error("--patch 必须是 JSON 对象"); } }
    else throw new Error("更新请使用 update --patch、edit 或 status");
    emit(await send("execution.routine.update", { routine: current.id, expected_revision, patch })); return 0;
  } catch (cause) {
    if (!resolved && cause instanceof ApiClientError && cause.status === 404 && ["list", "show", "followup"].includes(action)) return;
    throw cause;
  }
}

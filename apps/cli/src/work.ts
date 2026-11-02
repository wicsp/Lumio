import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiClientError, createClient } from "@lumio/api-client";
import { WorkCommandRequest, idOf, type WorkCommandResult } from "@lumio/schema";
import { hubCredentials } from "./config.ts";

const usage = "用法：lumio task new|list|show|update|edit|status|assign|comment|continue；lumio project new|list|show|update|edit；支持 --json；旧笔记命令加 --legacy";
const options = {
  json: { type: "boolean" }, legacy: { type: "boolean" }, to: { type: "string" }, description: { type: "string" },
  file: { type: "string" }, status: { type: "string" }, project: { type: "string" }, parent: { type: "string" },
  depends: { type: "string" }, due: { type: "string" }, workdir: { type: "string" }, model: { type: "string" },
  timeout: { type: "string" }, patch: { type: "string" }, revision: { type: "string" }, "request-id": { type: "string" },
  goal: { type: "string" }, repo: { type: "string" }, deadline: { type: "string" },
} as const;

/** Returns undefined only when an old task command must use the v1 compatibility path. */
export async function runWork(kind: "task" | "project", args: string[], log: (line: string) => void): Promise<number | undefined> {
  if (kind === "task" && args.includes("--legacy")) return;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options });
  const [action, reference, ...rest] = positionals;
  if (!action || !["new", "create", "list", "show", "update", "edit", "status", "assign", "comment", "continue"].includes(action)) {
    if (kind === "task") return;
    throw new Error(usage);
  }
  const client = createClient(hubCredentials());
  const emit = (value: unknown) => log(values.json ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2));
  const send = async (op: string, payload: Record<string, unknown>): Promise<WorkCommandResult> => client.workCommand(WorkCommandRequest.parse({
    request_id: values["request-id"] ?? randomUUID(), operation: { op, args: payload },
  }));
  let resolved = false;
  try {
    if (action === "list") {
      if (reference) throw new Error(usage);
      if (kind === "project") {
        const projects = await client.workProjects();
        if (values.json) emit(projects); else for (const project of projects) log(`${project.id}  ${project.status}  ${project.title}`);
      } else {
        const tasks = await client.workTasks({ project: values.project, status: values.status });
        if (values.json) emit(tasks); else for (const task of tasks) log(`${task.id}  ${task.status}  ${task.assignee}  ${task.title}`);
      }
      return 0;
    }
    if (!reference) throw new Error(usage);
    if (action === "new" || action === "create") {
      if (rest.length) throw new Error("标题包含空格时请用引号包起来");
      const description = values.file ? await readFile(values.file, "utf8") : values.description;
      const fields = kind === "project" ? { goal: values.goal, repo: values.repo, deadline: values.deadline }
        : { assignee: values.to, status: values.status, project: values.project, parent: values.parent,
          dependencies: values.depends?.split(",").filter(Boolean), due: values.due, workdir: values.workdir, model: values.model,
          timeout_minutes: values.timeout === undefined ? undefined : Number(values.timeout) };
      const result = await send(`work.${kind}.create`, { title: reference, description, ...fields });
      if (values.json) emit(result); else if (result.kind === "task") log(`${result.task.id}  ${result.task.title}`); else if (result.kind === "project") log(`${result.project.id}  ${result.project.title}`);
      return 0;
    }
    if (kind === "task" && !idOf("task").safeParse(reference).success && ["show", "continue"].includes(action)) return;
    const current = kind === "task" ? (await client.workTask(reference)).task : await client.workProject(reference);
    resolved = true;
    if (action === "show") {
      const detail = kind === "task" ? await client.workTask(reference) : current;
      if (values.json) emit(detail); else log(`${current.id}  ${current.status}  ${current.title}\n\n${current.description}${kind === "task" ? `\n\n${JSON.stringify(detail, null, 2)}` : ""}`);
      return 0;
    }
    if (action === "continue" && kind === "task") {
      const result = await send("work.task.dispatch", { task: reference, to: values.to, expected_revision: current.revision });
      if (values.json) emit(result.kind === "job" ? result.job : result); else if (result.kind === "job") log(`已派出：${result.job.spec.id}`);
      return 0;
    }
    if (action === "comment" && kind === "task") {
      const body = values.file ? await readFile(values.file, "utf8") : rest.join(" ");
      const result = await send("work.task.comment", { task: reference, body }); emit(result); return 0;
    }
    let patch: Record<string, unknown>;
    if (action === "edit") {
      if (values.file && values.revision === undefined) throw new Error("通过 --file 提交已有正文时必须提供 --revision；先用 show --json 读取版本，或直接运行 edit 打开带版本的编辑副本");
      let directory: string | undefined;
      const path = values.file ?? join(directory = await mkdtemp(join(tmpdir(), "lumio-edit-")), "description.md");
      if (!values.file) {
        await writeFile(path, current.description, { mode: 0o600 });
        const editor = process.env.VISUAL ?? process.env.EDITOR;
        if (!editor) throw new Error(`请设置 VISUAL/EDITOR，或用 --file 提交正文；编辑副本保存在 ${path}`);
        const argv = editor.trim().split(/\s+/);
        const child = Bun.spawn([...argv, path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        if (await child.exited) throw new Error(`编辑器退出失败，正文保存在 ${path}`);
      }
      const description = await readFile(path, "utf8");
      try {
        const result = await send(`work.${kind}.update`, { [kind]: reference, expected_revision: values.revision === undefined ? current.revision : Number(values.revision), patch: { description } });
        emit(result); if (directory) await rm(directory, { recursive: true }); return 0;
      } catch (cause) {
        const message = cause instanceof ApiClientError ? cause.message : "无法保存正文";
        if (cause instanceof ApiClientError) throw new ApiClientError({ code: cause.code, message: `${message}；编辑内容保存在 ${path}`,
          reason: cause.reason, operation: cause.operation, proposal: cause.proposal }, cause.status);
        throw new Error(`${message}；编辑内容保存在 ${path}`);
      }
    } else if (values.patch) {
      try { patch = JSON.parse(values.patch); } catch { throw new Error("--patch 必须是 JSON 对象"); }
    } else if (action === "status") patch = { status: values.status ?? rest[0] };
    else if (action === "assign" && kind === "task") patch = { assignee: values.to ?? rest[0] };
    else throw new Error("更新时请提供 --patch；修改正文使用 edit，状态使用 status，负责人使用 assign");
    const result = await send(`work.${kind}.update`, { [kind]: reference, expected_revision: values.revision === undefined ? current.revision : Number(values.revision), patch });
    emit(result); return 0;
  } catch (cause) {
    if (!resolved && kind === "task" && cause instanceof ApiClientError && cause.status === 404 && ["list", "show", "continue"].includes(action)) return;
    throw cause;
  }
}

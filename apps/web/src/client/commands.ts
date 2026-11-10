/**
 * 命令构造（ADR 0026）：纯函数，便于用 @lumio/schema 做契约测试。
 *
 * - 描述与结构化字段分成两个独立命令（schema 不允许混在一个 patch 里）。
 * - 每个命令都带 expected_revision 和新的 request_id；委派与交接是单独命令（ADR 0032，见 turn.ts）。
 */
import type { ExecutionRoutine, ExecutionRoutineCommandRequest, WorkCommandRequest, WorkProject, WorkTask } from "@lumio/schema";
import { t, locale } from "./i18n.ts";

export function newRequestId(prefix = "web"): string {
  const bytes = new Uint8Array(12); crypto.getRandomValues(bytes);
  return `${prefix}-${Date.now().toString(36)}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function taskDescriptionCommand(task: Pick<WorkTask, "id" | "revision" | "description">, description: string, requestId = newRequestId()): WorkCommandRequest | undefined {
  if (description === task.description) return undefined;
  return { request_id: requestId, operation: { op: "work.task.update", args: { task: task.id, expected_revision: task.revision, patch: { description } } } };
}

export function projectFieldsCommand(project: WorkProject, draft: { title: string; status: WorkProject["status"] }, requestId = newRequestId()): WorkCommandRequest | undefined {
  const patch: Record<string, unknown> = {};
  if (draft.title.trim() && draft.title.trim() !== project.title) patch.title = draft.title.trim();
  if (draft.status !== project.status) patch.status = draft.status;
  if (!Object.keys(patch).length) return undefined;
  return { request_id: requestId, operation: { op: "work.project.update", args: { project: project.id, expected_revision: project.revision, patch } } } as WorkCommandRequest;
}

export function projectDescriptionCommand(project: WorkProject, description: string, requestId = newRequestId()): WorkCommandRequest | undefined {
  if (description === project.description) return undefined;
  return { request_id: requestId, operation: { op: "work.project.update", args: { project: project.id, expected_revision: project.revision, patch: { description } } } };
}

/**
 * 属性面板的即时保存：只发送这一处修改，带看到的 revision。
 * 值与当前相同（null 与缺省视为相同）时返回 undefined，不发请求。
 */
export function workPatchCommand(record: WorkTask | WorkProject, patch: Record<string, unknown>, requestId = newRequestId()): WorkCommandRequest | undefined {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const current = (record as Record<string, unknown>)[key] ?? null;
    if (JSON.stringify(current) !== JSON.stringify(value ?? null)) changed[key] = value;
  }
  if (!Object.keys(changed).length) return undefined;
  return record.type === "task"
    ? { request_id: requestId, operation: { op: "work.task.update", args: { task: record.id, expected_revision: record.revision, patch: changed } } } as WorkCommandRequest
    : { request_id: requestId, operation: { op: "work.project.update", args: { project: record.id, expected_revision: record.revision, patch: changed } } } as WorkCommandRequest;
}

export function taskCreateCommand(input: { title: string; description?: string; project?: string; parent?: string }, requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.task.create", args: {
    title: input.title.trim(), ...(input.description ? { description: input.description } : {}), ...(input.project ? { project: input.project } : {}),
    ...(input.parent ? { parent: input.parent } : {}) } } };
}

export function projectCreateCommand(input: { title: string; description?: string; goal?: string; workdir?: string }, requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.project.create", args: {
    title: input.title.trim(), ...(input.description ? { description: input.description } : {}), ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}),
    ...(input.workdir?.trim() ? { workdir: input.workdir.trim() } : {}) } } };
}

export function commentCommand(task: string, body: string, requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.task.comment", args: { task, body } } };
}

/** 显式委派/继续：目标是选中的 engine@device，并锁定看到的版本。 */
export function dispatchCommand(task: Pick<WorkTask, "id" | "revision">, target: string, requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.task.dispatch", args: { task: task.id, to: target, expected_revision: task.revision } } };
}

/** 回答并继续（ADR 0030）：评论与委派在同一事务里提交；目标缺省为上一轮的 agent。 */
export function answerCommand(task: Pick<WorkTask, "id" | "revision">, target: string | undefined, comment: string, requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.task.dispatch", args: {
    task: task.id, ...(target ? { to: target } : {}), expected_revision: task.revision, comment: comment.trim() } } } as WorkCommandRequest;
}

/** 执行器登记的引擎 → 可选目标 engine@device。 */
export function engineTargets(runtimes: Array<{ online: boolean; registration: { name: string; engines: Array<{ name: string; version: string; sandbox?: string }> } }>): Array<{ target: string; label: string; online: boolean; sandbox?: string }> {
  return runtimes.flatMap((runtime) => runtime.registration.engines.map((engine) => ({
    target: `${engine.name}@${runtime.registration.name}`, label: t("{0} @ {1} ({2}{3})", engine.name, runtime.registration.name, engine.version, runtime.online ? "" : t(", offline")), online: runtime.online,
    sandbox: engine.sandbox,
  })));
}

export interface RoutineDraft {
  title: string; description: string; schedule: string; timezone: string; assignee: string;
  context: ExecutionRoutine["context"]; workdir: string; timeout_minutes: string;
}

export function routineCreateCommand(draft: RoutineDraft, requestId = newRequestId()): ExecutionRoutineCommandRequest {
  const timeout = Number(draft.timeout_minutes);
  return { request_id: requestId, operation: { op: "execution.routine.create", args: {
    title: draft.title.trim(), description: draft.description, schedule: draft.schedule.trim(), assignee: draft.assignee, context: draft.context,
    ...(draft.timezone.trim() ? { timezone: draft.timezone.trim() } : {}), ...(draft.workdir.trim() ? { workdir: draft.workdir.trim() } : {}),
    ...(draft.timeout_minutes.trim() ? { timeout_minutes: timeout } : {}) } } };
}

export function routineUpdateCommand(routine: ExecutionRoutine, draft: RoutineDraft, requestId = newRequestId()): ExecutionRoutineCommandRequest | undefined {
  const patch: Record<string, unknown> = {};
  const timeout = draft.timeout_minutes.trim() ? Number(draft.timeout_minutes) : null;
  if (draft.title.trim() !== routine.title) patch.title = draft.title.trim();
  if (draft.description !== routine.description) patch.description = draft.description;
  if (draft.schedule.trim() !== routine.schedule) patch.schedule = draft.schedule.trim();
  if (draft.timezone.trim() && draft.timezone.trim() !== routine.timezone) patch.timezone = draft.timezone.trim();
  if (draft.assignee !== routine.assignee) patch.assignee = draft.assignee;
  if (draft.context !== routine.context) patch.context = draft.context;
  if ((draft.workdir.trim() || null) !== (routine.workdir ?? null)) patch.workdir = draft.workdir.trim() || null;
  if (timeout !== (routine.timeout_minutes ?? null)) patch.timeout_minutes = timeout;
  if (!Object.keys(patch).length) return undefined;
  return { request_id: requestId, operation: { op: "execution.routine.update", args: { routine: routine.id, expected_revision: routine.revision, patch } } } as ExecutionRoutineCommandRequest;
}

export function routineStatusCommand(routine: ExecutionRoutine, status: ExecutionRoutine["status"], requestId = newRequestId()): ExecutionRoutineCommandRequest {
  return { request_id: requestId, operation: { op: "execution.routine.update", args: { routine: routine.id, expected_revision: routine.revision, patch: { status } } } };
}

/** 显示时间：本地时区 + 时区名；无效值原样显示。 */
export function formatTime(iso: string | undefined, timeZone?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale(), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short", ...(timeZone ? { timeZone } : {}) }).format(date);
}

/** 下载文件名只保留安全字符，避免路径与控制字符。 */
export function safeFileName(key: string, fallback = "download"): string {
  const base = key.split("/").pop() ?? "";
  const cleaned = base.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || fallback;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyArtifact(bytes:ArrayBuffer,expected:{size:number;sha256:string}):Promise<boolean>{
  return bytes.byteLength===expected.size&&await sha256Hex(bytes)===expected.sha256;
}

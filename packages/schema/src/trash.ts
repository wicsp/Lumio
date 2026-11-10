import { KnowledgeReferenceCount } from "./query.ts";
/**
 * 删除与回收站（ADR 0038）。删除即移入回收站，30 天后由 Hub 永久删除；只有人可以删除、恢复、彻底删除。
 *
 * - 任务、项目：走 Work 命令 `work.task.delete` / `work.project.delete`（见 work.ts），结果 kind 为 trashed。
 * - 笔记：`KnowledgeDeleteRequest`；对话：`AssistantConversationDeleteRequest`；结果均为 `TrashItem`。
 * - 回收站中的对象按 ID 读取时返回 NOT_FOUND，`error.reason` 为 `trashed`（不新增错误码）。
 */
import { z } from "zod";
import { Id, RequestId, Timestamp, idOf } from "./common.ts";
import { KnowledgeRevision } from "./knowledge-editing.ts";

export const TRASH_KINDS = ["task", "project", "note", "conversation"] as const;
export const TrashKind = z.enum(TRASH_KINDS);

/** 回收站保留天数（ADR 0038 第 1 节）。 */
export const TRASH_RETENTION_DAYS = 30;

/** 读取已在回收站中的对象时，NOT_FOUND 错误里的 `reason`。 */
export const TRASHED_REASON = "trashed";

/** 回收站里的一项：只有摘要，不含正文。 */
export const TrashItem = z.strictObject({
  kind: TrashKind,
  id: Id.describe("被删除对象自身的 ID（task_/prj_/笔记 id/conv_）；恢复与彻底删除都用它"),
  title: z.string().describe("删除时的标题"),
  deleted_at: Timestamp,
  deleted_by: idOf("act"),
  expires_at: Timestamp.describe("到期后 Hub 永久删除；等于 deleted_at 加 30 天"),
  project: idOf("prj").optional().describe("kind=task：删除时所属的项目"),
  detached_tasks: z.array(idOf("task")).optional().describe("kind=project：删除时被置为无项目的任务"),
  stopped_job: idOf("job").optional().describe("kind=task：删除时被停掉的那一轮"),
  path: z.string().min(1).optional().describe("kind=note：删除前在 vault 中的相对路径"),
});

/** `GET /v2/trash`：按删除时间倒序。 */
export const TrashListArgs = z.strictObject({ kind: TrashKind.optional() });
export const TrashListResult = z.strictObject({ items: z.array(TrashItem) });

/** `DELETE /v2/knowledge/notes/<id>`：只限有稳定 ID 的知识笔记；`life/` 与旧格式笔记拒绝（ADR 0038 第 2 节）。 */
export const KnowledgeDeleteRequest = z.strictObject({ request_id: RequestId, expected_revision: KnowledgeRevision });

/** `DELETE /v2/assistant/conversations/<id>`：正在生成回复时先停止生成。不删除从对话保存的记忆。 */
export const AssistantConversationDeleteRequest = z.strictObject({ request_id: RequestId });

/** 删除笔记或对话的结果。 */
export const TrashResult = z.strictObject({ request_id: RequestId, item: TrashItem, knowledge_references: KnowledgeReferenceCount.optional() });

/** `POST /v2/trash/<id>/restore`：对象回到删除前的状态。 */
export const TrashRestoreRequest = z.strictObject({ request_id: RequestId });
export const TrashRestoreResult = z.strictObject({
  request_id: RequestId,
  kind: TrashKind,
  id: Id,
  reattached_tasks: z.array(idOf("task")).optional().describe("kind=project：重新挂回的任务（恢复时仍无项目的那些）"),
  path: z.string().min(1).optional().describe("kind=note：恢复后的实际路径；原路径被占用时带后缀"),
  renamed: z.boolean().optional().describe("kind=note：原路径被占用、恢复到了别的文件名"),
});

/** `DELETE /v2/trash/<id>`：彻底删除，不可撤销。执行记录不受影响。 */
export const TrashPurgeRequest = z.strictObject({ request_id: RequestId });
export const TrashPurgeResult = z.strictObject({ request_id: RequestId, kind: TrashKind, id: Id });

export type TrashKind = z.infer<typeof TrashKind>;
export type TrashItem = z.infer<typeof TrashItem>;
export type TrashListArgs = z.infer<typeof TrashListArgs>;
export type TrashListResult = z.infer<typeof TrashListResult>;
export type KnowledgeDeleteRequest = z.infer<typeof KnowledgeDeleteRequest>;
export type AssistantConversationDeleteRequest = z.infer<typeof AssistantConversationDeleteRequest>;
export type TrashResult = z.infer<typeof TrashResult>;
export type TrashRestoreRequest = z.infer<typeof TrashRestoreRequest>;
export type TrashRestoreResult = z.infer<typeof TrashRestoreResult>;
export type TrashPurgeRequest = z.infer<typeof TrashPurgeRequest>;
export type TrashPurgeResult = z.infer<typeof TrashPurgeResult>;

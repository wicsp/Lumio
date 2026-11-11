import { z } from "zod";
import { DerivedFrom, Id, RequestId, Timestamp, idOf } from "./common.ts";
import { ExecutionRoutineInfo } from "./execution.ts";
import { ExecutionTarget, ExecutionTargetListArgs, Job, JobStatus } from "./job.ts";
import { Proposal } from "./proposal.ts";
import { KnowledgeRevision } from "./knowledge-editing.ts";
import { LinksResult, NOTE_TYPES, NoteDetail, NoteRef, SearchResult } from "./query.ts";
import {
  ProjectStatus, TaskStatus, WorkCommandResult, WorkProject, WorkProjectCreate, WorkProjectUpdate,
  WorkAttention, WorkTask, WorkTaskComment, WorkTaskCreate, WorkTaskDetail, WorkTaskDispatch, WorkTaskHand, WorkTaskPlanSet, WorkTaskUpdate,
} from "./work.ts";

/**
 * 能力目录（ADR 0029 第 2 节）：Lumio 对 agent 提供的全部能力，一处定义。
 *
 * - 内置助手把每项注册为工具（工具名见 toolName，参数 schema 导出为 JSON Schema 交给模型）。
 * - `lumio` 命令覆盖每一项并以 `--json` 输出 result；skill 的命令表由这里生成。
 * - 以后的 MCP 适配层同样从这里生成。
 *
 * 这里只定义"能做什么、参数和结果长什么样"。谁能做由 Hub 的规则表决定（ADR 0016、0029 第 3 节），
 * 不在目录里写权限；agent 的参数限制由 Hub 授权表判断。
 * 写入类能力的 request_id 由调用方生成（助手用工具调用 ID，CLI 用 --request-id 或随机值），不属于参数。
 */

export const CAPABILITY_KINDS = ["read", "write"] as const;
export const CapabilityKind = z.enum(CAPABILITY_KINDS);

/** 能力名称：模块、对象、动作，可带一级子动作。工具名见 toolName。 */
export const CapabilityName = z.string().regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*){2,3}$/);

/** 给模型和 skill 看的说明；英文为基准（ADR 0028、0029）。 */
export const CapabilitySummary = z.strictObject({ en: z.string().min(1), zh: z.string().min(1) });

/** 笔记引用：ID、论文 citekey 或文件名（不含 .md），与 `lumio show` 相同。 */
const NoteReference = z.string().min(1).describe("ID, paper citekey, or file name without .md");
const Limit = z.number().int().min(1).max(100);

// ───────────────────────── 参数 ─────────────────────────

export const KnowledgeSearchArgs = z.strictObject({
  query: z.string().min(1).describe("Full-text query (substring match, Chinese and English)"),
  type: z.enum(NOTE_TYPES).optional().describe("Only notes of this type"),
  limit: Limit.optional().describe("Default 20"),
});
export const KnowledgeShowArgs = z.strictObject({ ref: NoteReference });
export const KnowledgeLinksArgs = z.strictObject({ ref: NoteReference });

/**
 * AI 笔记（ADR 0051 第 4、6 节）：agent 只能新建和带版本更新 AI 笔记。
 * Hub 填写 id、时间、generated_by，并把调用方所在的对话消息或 Job 加进 derived_from；
 * derived_from 中有调用方不可见的资源时拒绝。
 *
 */
const AiNoteTitle = z.string().trim().min(1).max(500);
const AiNoteBody = z.string().max(500000).describe("Markdown body. Link other notes with [[name]]; link conversations, tasks or runs with [text](lumio:<id>)");
const AiNoteTags = z.array(z.string().trim().min(1).max(100)).max(100);
const AiNoteSources = z.array(DerivedFrom).max(100).describe("Where this came from: Lumio IDs (message, run, note…) or URLs. Your current message or run is added automatically");
export const KnowledgeAiNoteCreateArgs = z.strictObject({
  title: AiNoteTitle,
  body: AiNoteBody,
  tags: AiNoteTags.optional(),
  derived_from: AiNoteSources.optional(),
  model: z.string().trim().min(1).max(200).optional().describe("Model that wrote it, if known"),
});
export const KnowledgeAiNoteUpdateArgs = z
  .strictObject({
    note: idOf("ain"),
    expected_revision: KnowledgeRevision.describe("revision from your last read or write; a newer human edit returns CONFLICT"),
    title: AiNoteTitle.optional(),
    body: AiNoteBody.optional(),
    tags: AiNoteTags.optional().describe("Replaces all tags"),
    derived_from: AiNoteSources.optional().describe("Replaces all sources"),
  })
  .refine((args) => args.title !== undefined || args.body !== undefined || args.tags !== undefined || args.derived_from !== undefined, "Nothing to update");
export const AI_NOTE_CAPABILITY_NAMES = ["knowledge.ainote.create", "knowledge.ainote.update"] as const;
export const AI_NOTE_SUMMARIES = {
  "knowledge.ainote.create": { en: "Write knowledge as an AI note (one note per topic) when the user asks to record something or a task requires it. You cannot write other note types.", zh: "把知识写成一份 AI 笔记（一件事一份），用于用户要求记下来或任务要求写入时。不能写其他类型的笔记。" },
  "knowledge.ainote.update": { en: "Update an AI note, e.g. regenerate a summary. Requires the revision you last saw; returns CONFLICT if the user edited it since.", zh: "更新一份 AI 笔记（例如重新生成摘要）。需要带上次看到的版本；用户之后改过则返回冲突。" },
} as const satisfies Record<(typeof AI_NOTE_CAPABILITY_NAMES)[number], { en: string; zh: string }>;
export const KnowledgeAiNoteResult = z.strictObject({
  note: NoteRef,
  revision: KnowledgeRevision.describe("SHA-256 of the file after writing; pass as expected_revision next time"),
});

export const KnowledgeAiNoteCommand = z.strictObject({
  request_id: RequestId,
  operation: z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal(AI_NOTE_CAPABILITY_NAMES[0]), args: KnowledgeAiNoteCreateArgs }),
    z.strictObject({ op: z.literal(AI_NOTE_CAPABILITY_NAMES[1]), args: KnowledgeAiNoteUpdateArgs }),
  ]),
});
export type KnowledgeAiNoteCommand = z.infer<typeof KnowledgeAiNoteCommand>;

export const WorkTaskListArgs = z.strictObject({
  readiness: z.enum(["ready", "blocked"]).optional(),
  tag: z.string().min(1).optional(),
  parent: idOf("task").optional(),
  project: idOf("prj").optional(),
  status: TaskStatus.optional(),
  query: z.string().min(1).optional().describe("Substring of title or description"),
});
export const WorkTaskShowArgs = z.strictObject({ task: idOf("task") });
export const WorkAttentionListArgs = z.strictObject({});
export const WorkProjectListArgs = z.strictObject({ status: ProjectStatus.optional() });
export const WorkProjectShowArgs = z.strictObject({ project: idOf("prj") });

export const ExecutionJobListArgs = z.strictObject({
  status: JobStatus.optional(),
  task: idOf("task").optional(),
  routine: idOf("rtn").optional(),
  limit: Limit.optional().describe("Most recent first; default 20"),
});
export const ExecutionJobShowArgs = z.strictObject({ job: idOf("job") });
export const ExecutionRoutineListArgs = z.strictObject({});
export const ApprovalListArgs = z.strictObject({});

// ───────────────────────── 目录 ─────────────────────────

interface CapabilityDef<A extends z.ZodType, R extends z.ZodType> {
  name: string;
  kind: z.infer<typeof CapabilityKind>;
  summary: z.infer<typeof CapabilitySummary>;
  args: A;
  result: R;
}
const define = <A extends z.ZodType, R extends z.ZodType>(def: CapabilityDef<A, R>) => def;

/** Work 写入能力直接复用 Work 命令的参数和结果。 */
export const CAPABILITIES = [
  define({ name: "knowledge.note.search", kind: "read", args: KnowledgeSearchArgs, result: SearchResult,
    summary: { en: "Search the user's notes (papers, ideas, sources). Snippets are short; read a hit with knowledge.note.show.", zh: "搜索用户的笔记（论文、想法、资料）。片段很短，需要时用 knowledge.note.show 读全文。" } }),
  define({ name: "knowledge.note.show", kind: "read", args: KnowledgeShowArgs, result: NoteDetail,
    summary: { en: "Read one note in full.", zh: "读取一篇笔记的全文。" } }),
  define({ name: "knowledge.note.links", kind: "read", args: KnowledgeLinksArgs, result: LinksResult,
    summary: { en: "List a note's outgoing and incoming links.", zh: "列出一篇笔记的出链与反链。" } }),
  define({ name: AI_NOTE_CAPABILITY_NAMES[0], kind: "write", args: KnowledgeAiNoteCreateArgs, result: KnowledgeAiNoteResult,
    summary: AI_NOTE_SUMMARIES[AI_NOTE_CAPABILITY_NAMES[0]] }),
  define({ name: AI_NOTE_CAPABILITY_NAMES[1], kind: "write", args: KnowledgeAiNoteUpdateArgs, result: KnowledgeAiNoteResult,
    summary: AI_NOTE_SUMMARIES[AI_NOTE_CAPABILITY_NAMES[1]] }),
  define({ name: "work.task.list", kind: "read", args: WorkTaskListArgs, result: z.array(WorkTask),
    summary: { en: "List tasks with derived blocked_by and next_target; filter by readiness (ready or blocked), tag, parent, project, status or text.", zh: "列出任务与推导的 blocked_by、next_target（下一次委派给谁），可按可开工/被阻塞、标签、父任务、项目、状态或文字筛选。" } }),
  define({ name: "work.task.show", kind: "read", args: WorkTaskShowArgs, result: WorkTaskDetail,
    summary: { en: "Show a task with derived blocked_by, next_target, dependents, children, discussion and execution rounds.", zh: "查看任务及推导的 blocked_by、next_target、后续任务、子任务、讨论和执行轮次。" } }),
  define({ name: "work.attention.list", kind: "read", args: WorkAttentionListArgs, result: z.array(WorkAttention),
    summary: { en: "List what needs the user now: questions from agents, finished rounds awaiting review, and failed rounds.", zh: "列出现在需要用户处理的事：agent 的提问、等待验收的结果、失败的轮次。" } }),
  define({ name: "work.project.list", kind: "read", args: WorkProjectListArgs, result: z.array(WorkProject),
    summary: { en: "List projects.", zh: "列出项目。" } }),
  define({ name: "work.project.show", kind: "read", args: WorkProjectShowArgs, result: WorkProject,
    summary: { en: "Show one project.", zh: "查看一个项目。" } }),
  define({ name: "execution.target.list", kind: "read", args: ExecutionTargetListArgs, result: z.array(ExecutionTarget),
    summary: { en: "List registered delegation targets, including offline targets.", zh: "列出已登记的委派目标，包括离线目标。" } }),
  define({ name: "approval.proposal.withdraw", kind: "write", args: z.strictObject({ proposal: idOf("prop") }), result: Proposal,
    summary: { en: "Withdraw your own pending proposal.", zh: "撤回自己的待批准提议。" } }),
  define({ name: "execution.job.list", kind: "read", args: ExecutionJobListArgs, result: z.array(Job),
    summary: { en: "List agent and command runs, most recent first.", zh: "列出 agent 与命令的执行轮次，最新的在前。" } }),
  define({ name: "execution.job.show", kind: "read", args: ExecutionJobShowArgs, result: Job,
    summary: { en: "Show one run, including the agent's report.", zh: "查看一轮执行，包括 agent 的汇报。" } }),
  define({ name: "execution.routine.list", kind: "read", args: ExecutionRoutineListArgs, result: z.array(ExecutionRoutineInfo),
    summary: { en: "List scheduled routines with their next and last runs.", zh: "列出例行任务及下次、上次执行。" } }),
  define({ name: "approval.proposal.list", kind: "read", args: ApprovalListArgs, result: z.array(Proposal),
    summary: { en: "List pending approvals. Only the user can accept or reject them.", zh: "列出待批准的提议。只有用户本人能接受或拒绝。" } }),
  define({ name: "work.task.create", kind: "write", args: WorkTaskCreate.shape.args, result: WorkCommandResult,
    summary: { en: "Create a task with the human todo turn. Creation never starts a run.", zh: "新建任务，默认轮到人（todo），不会开始执行。" } }),
  define({ name: "work.task.update", kind: "write", args: WorkTaskUpdate.shape.args, result: WorkCommandResult,
    summary: { en: "Change task fields. Tasks have outcome and turn, with no status or assignee; only the user decides completion.", zh: "修改任务字段。任务没有状态与负责人；完成由用户决定。" } }),
  define({ name: "work.task.comment", kind: "write", args: WorkTaskComment.shape.args, result: WorkCommandResult,
    summary: { en: "Add a comment to a task's discussion.", zh: "在任务讨论里发表评论。" } }),
  define({ name: "work.task.dispatch", kind: "write", args: WorkTaskDispatch.shape.args, result: WorkCommandResult,
    summary: { en: "Delegate or continue a task. Agent calls propose the delegation and require user approval before it starts.", zh: "委派或继续任务。agent 调用时提交提议，用户批准后才开始执行轮次。" } }),
  define({ name: "work.task.plan.set", kind: "write", args: WorkTaskPlanSet.shape.args, result: WorkCommandResult,
    summary: { en: "Set, replace, or clear a task handoff plan. Agent calls require user approval. Saving the plan does not start a round. Use null to clear it.", zh: "设置、替换或清除任务交接计划。agent 调用时需要用户批准。保存计划后仍需另行派出执行。传 null 清除计划。" } }),
  define({ name: "work.task.hand", kind: "write", args: WorkTaskHand.shape.args, result: WorkCommandResult,
    summary: { en: "Hand a task back to the human or to external waiting (with a note). Agents cannot hand to nobody.", zh: "交回给人或交给外部等待（附说明）。agent 不能交给无人。" } }),
  define({ name: "work.project.create", kind: "write", args: WorkProjectCreate.shape.args, result: WorkCommandResult,
    summary: { en: "Create a project, optionally with a default_target used for tasks never dispatched before.", zh: "新建项目，可设默认执行者 default_target（用于还没派过的任务）。" } }),
  define({ name: "work.project.update", kind: "write", args: WorkProjectUpdate.shape.args, result: WorkCommandResult,
    summary: { en: "Change project fields, including default_target (null clears it).", zh: "修改项目字段，包括默认执行者 default_target（null 清空）。" } }),
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityNameOf = Capability["name"];
export const CAPABILITY_NAMES = CAPABILITIES.map((capability) => capability.name) as readonly CapabilityNameOf[];

/** 按名称查找；未知名称返回 undefined。 */
export function capability(name: string): Capability | undefined {
  return CAPABILITIES.find((item) => item.name === name);
}

/**
 * 交给模型的工具名：兼容 Chat Completions 的函数名只允许 [a-zA-Z0-9_-]，所以把点换成两个下划线
 * （`work.task.list` → `work__task__list`）。能力名本身不含连续下划线，映射可逆。
 */
export const toolName = (name: string): string => name.replaceAll(".", "__");
export function capabilityFromTool(tool: string): Capability | undefined {
  return capability(tool.replaceAll("__", "."));
}

// ───────────────────────── 写入记录与撤回 ─────────────────────────

/**
 * 内置助手的一次写入在对话里显示为变更卡片（ADR 0029 第 3 节）。
 * before 只含被修改的字段的旧值（与 patch 同形），新建时缺失；撤回 = 用 before 作为 patch 的一次普通更新，带 after_revision。
 */
export const CapabilityChange = z.strictObject({
  capability: CapabilityName,
  target: Id.describe("被修改或新建的对象"),
  before: z.record(z.string(), z.unknown()).optional().describe("被修改字段的旧值；新建或评论时缺失"),
  after_revision: z.number().int().positive().optional().describe("写入后的 revision；撤回时作为 expected_revision"),
  undone: z.strictObject({ at: Timestamp, by: idOf("act") }).optional().describe("已撤回"),
});

export type CapabilityKind = z.infer<typeof CapabilityKind>;
export type CapabilitySummary = z.infer<typeof CapabilitySummary>;
export type CapabilityChange = z.infer<typeof CapabilityChange>;
export type KnowledgeSearchArgs = z.infer<typeof KnowledgeSearchArgs>;
export type WorkTaskListArgs = z.infer<typeof WorkTaskListArgs>;
export type ExecutionJobListArgs = z.infer<typeof ExecutionJobListArgs>;
export type KnowledgeAiNoteCreateArgs = z.infer<typeof KnowledgeAiNoteCreateArgs>;
export type KnowledgeAiNoteUpdateArgs = z.infer<typeof KnowledgeAiNoteUpdateArgs>;
export type KnowledgeAiNoteResult = z.infer<typeof KnowledgeAiNoteResult>;

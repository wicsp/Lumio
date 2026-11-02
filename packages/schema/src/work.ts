import { z } from "zod";
import { AgentTarget, ID_PREFIXES, Id, RequestId, Revision, TaskAssignee, Timestamp, idOf } from "./common.ts";
import { TASK_STATUSES } from "./entities.ts";
import { Job } from "./job.ts";

/**
 * Work 模块契约 v2（ADR 0025 第 1、3、4、8 节，R0-1）。
 *
 * - Project/Task 是数据库里的业务对象，不是笔记：没有 path，不用 NoteRef 表达；v1 的 entities.ts 只用于旧笔记解码。
 * - 全部是严格对象（未知字段拒绝）；可选字段用"缺失"表示未填，不接受 null。只有 patch 里用 null 表示清空。
 * - revision 是正整数，每次修改加一；update 必须带 expected_revision，不相等时 Hub 返回 CONFLICT。
 * - 负责人只是"谁在负责"，不是执行开关；派活必须用 work.task.dispatch（ADR 0025 第 4 节）。
 */

export const MODULES = ["knowledge", "work", "execution", "assistant"] as const;
export const Module = z.enum(MODULES);

/** 每个模块的 ResourceRef 可以指向哪些前缀的对象。 */
export const MODULE_ID_PREFIXES = {
  knowledge: [ID_PREFIXES.paper, ID_PREFIXES.idea, ID_PREFIXES.source, ID_PREFIXES.experiment, ID_PREFIXES.post, ID_PREFIXES.asset, ID_PREFIXES.report],
  work: [ID_PREFIXES.project, ID_PREFIXES.task, ID_PREFIXES.work_comment],
  execution: [ID_PREFIXES.job, ID_PREFIXES.routine, ID_PREFIXES.log_event, ID_PREFIXES.artifact],
  assistant: [ID_PREFIXES.conversation, ID_PREFIXES.assistant_message, ID_PREFIXES.assistant_turn, ID_PREFIXES.tool_call, ID_PREFIXES.memory],
} as const satisfies Record<(typeof MODULES)[number], readonly string[]>;

/**
 * 跨模块引用（ADR 0025 第 5 节）：只存 ID，展示时经所属模块的接口读取可见信息。
 * 来源不存在或不可见时引用照样保留。revision 是引用时看到的版本（如知识正文的哈希），只作记录。
 */
export const ResourceRef = z
  .strictObject({
    module: Module,
    id: Id,
    revision: z.string().min(1).optional().describe("引用时对象的版本，只作记录，不保证现在仍是这个版本"),
    label: z.string().min(1).optional().describe("引用时看到的标题，只用于来源不可见时给人提示"),
  })
  .refine(
    (ref) => (MODULE_ID_PREFIXES[ref.module] as readonly string[]).includes(ref.id.slice(0, ref.id.indexOf("_"))),
    { message: "id 的前缀不属于该模块", path: ["id"] },
  );

export const PROJECT_STATUSES = ["planning", "active", "paused", "done"] as const;
export const ProjectStatus = z.enum(PROJECT_STATUSES);
export const TaskStatus = z.enum(TASK_STATUSES);

/** 派活时的执行配置（与 v1 任务笔记的平铺字段同名同义）。 */
const RunConfigShape = {
  workdir: z.string().min(1).optional().describe("执行器上的工作目录（缺省 ~；绝对路径或以 ~/ 开头）"),
  model: z.string().min(1).optional().describe("指定模型，原样交给 agent"),
  gpus: z.array(z.number().int().nonnegative()).optional().describe("只把这些 GPU 暴露给这一轮"),
  timeout_minutes: z.number().int().positive().optional().describe("每一轮最长运行时间；缺省用执行器默认值"),
};

/** 项目（v2）。 */
export const WorkProject = z.strictObject({
  schema_version: z.literal(2),
  type: z.literal("project"),
  id: idOf("prj"),
  title: z.string().min(1),
  description: z.string().describe("描述正文，可用 Markdown 语法；不是知识笔记"),
  revision: Revision,
  status: ProjectStatus,
  created: Timestamp,
  updated: Timestamp,
  tags: z.array(z.string()),
  goal: z.string().min(1).optional(),
  repo: z.string().min(1).optional().describe("关联代码仓库的路径或 URL"),
  deadline: Timestamp.optional(),
});

/** 任务（v2）。assignee 只有字符串写法；当前执行情况见 WorkTaskDetail.executions 与 Job。 */
export const WorkTask = z
  .strictObject({
    schema_version: z.literal(2),
    type: z.literal("task"),
    id: idOf("task"),
    title: z.string().min(1),
    description: z.string().describe("描述正文，可用 Markdown 语法；不是知识笔记"),
    revision: Revision,
    status: TaskStatus,
    assignee: TaskAssignee.describe("负责人；新建时缺省为 human。修改它不会派活"),
    created: Timestamp,
    updated: Timestamp,
    tags: z.array(z.string()),
    project: idOf("prj").optional(),
    parent: idOf("task").optional().describe("父任务"),
    dependencies: z.array(idOf("task")).describe("要先完成的任务"),
    references: z.array(ResourceRef).describe("资料引用；不是输入快照"),
    due: Timestamp.optional(),
    ...RunConfigShape,
  })
  .superRefine((task, ctx) => {
    if (task.parent === task.id) ctx.addIssue({ code: "custom", path: ["parent"], message: "任务不能是自己的父任务" });
    if (task.dependencies.includes(task.id)) ctx.addIssue({ code: "custom", path: ["dependencies"], message: "任务不能依赖自己" });
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      ctx.addIssue({ code: "custom", path: ["dependencies"], message: "dependencies 不能重复" });
    }
  });

/** 任务讨论中的一条消息（Work 拥有，与 Assistant 对话无关）。 */
export const WorkComment = z.strictObject({
  id: idOf("wmsg"),
  task: idOf("task"),
  author: idOf("act"),
  body: z.string().min(1).describe("Markdown 语法的正文"),
  created: Timestamp,
});

/**
 * 任务与一轮 Job 的关联（派活事务内写入）。Job 的运行状态由 Execution 解释；
 * Job 成功不代表任务完成。applied：这一轮的结果已经通过可靠记录更新到 Work。
 */
export const WorkExecution = z.strictObject({
  task: idOf("task"),
  job: idOf("job"),
  round: z.number().int().positive().describe("这个任务的第几轮"),
  input_revision: Revision.describe("派出时任务的 revision"),
  input_snapshot: z.string().describe("派出时交给执行的输入快照；之后改描述不影响它"),
  created: Timestamp,
  applied: z.boolean(),
});

/** `GET` 单个任务的完整视图。 */
export const WorkTaskDetail = z.strictObject({
  task: WorkTask,
  comments: z.array(WorkComment),
  executions: z.array(WorkExecution),
});

// ───────────────────────── 命令 ─────────────────────────

/** patch 不能为空。服务器字段（id、revision、created、updated 等）由严格对象直接拒绝。 */
const nonEmpty = (patch: object) => Object.keys(patch).length > 0;
/** 描述与结构化字段分别编辑：带 description 的 patch 不能同时改其他字段（ADR 0025 第 4 节）。 */
const descriptionAlone = (patch: object) => !("description" in patch) || Object.keys(patch).length === 1;
const PATCH_EMPTY = "patch 不能为空";
const PATCH_MIXED = "description 要单独修改，不能与结构化字段放在同一个 patch 里";

export const WorkProjectPatch = z
  .strictObject({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: ProjectStatus.optional(),
    tags: z.array(z.string()).optional(),
    goal: z.string().min(1).nullable().optional().describe("null：清空"),
    repo: z.string().min(1).nullable().optional().describe("null：清空"),
    deadline: Timestamp.nullable().optional().describe("null：清空"),
  })
  .refine(nonEmpty, PATCH_EMPTY)
  .refine(descriptionAlone, PATCH_MIXED);

export const WorkTaskPatch = z
  .strictObject({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: TaskStatus.optional(),
    assignee: TaskAssignee.optional().describe("只改负责人，不派活"),
    tags: z.array(z.string()).optional(),
    project: idOf("prj").nullable().optional().describe("null：清空"),
    parent: idOf("task").nullable().optional().describe("null：清空"),
    dependencies: z.array(idOf("task")).optional().describe("整体替换"),
    references: z.array(ResourceRef).optional().describe("整体替换"),
    due: Timestamp.nullable().optional().describe("null：清空"),
    workdir: RunConfigShape.workdir.unwrap().nullable().optional(),
    model: RunConfigShape.model.unwrap().nullable().optional(),
    gpus: RunConfigShape.gpus.unwrap().nullable().optional(),
    timeout_minutes: RunConfigShape.timeout_minutes.unwrap().nullable().optional(),
  })
  .refine(nonEmpty, PATCH_EMPTY)
  .refine(descriptionAlone, PATCH_MIXED);

export const WorkProjectCreate = z.strictObject({
  op: z.literal("work.project.create"),
  args: z.strictObject({
    title: z.string().min(1),
    description: z.string().optional().describe("缺省为空字符串"),
    tags: z.array(z.string()).optional().describe("缺省为 []"),
    goal: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    deadline: Timestamp.optional(),
  }),
});

export const WorkProjectUpdate = z.strictObject({
  op: z.literal("work.project.update"),
  args: z.strictObject({ project: idOf("prj"), expected_revision: Revision, patch: WorkProjectPatch }),
});

export const WorkTaskCreate = z.strictObject({
  op: z.literal("work.task.create"),
  args: z.strictObject({
    title: z.string().min(1),
    description: z.string().optional().describe("缺省为空字符串"),
    status: TaskStatus.optional().describe("缺省 todo"),
    assignee: TaskAssignee.optional().describe("缺省 human；新建不会派活"),
    project: idOf("prj").optional(),
    parent: idOf("task").optional(),
    dependencies: z.array(idOf("task")).optional().describe("缺省 []"),
    references: z.array(ResourceRef).optional().describe("缺省 []"),
    tags: z.array(z.string()).optional().describe("缺省 []"),
    due: Timestamp.optional(),
    ...RunConfigShape,
  }),
});

export const WorkTaskUpdate = z.strictObject({
  op: z.literal("work.task.update"),
  args: z.strictObject({ task: idOf("task"), expected_revision: Revision, patch: WorkTaskPatch }),
});

export const WorkTaskComment = z.strictObject({
  op: z.literal("work.task.comment"),
  args: z.strictObject({ task: idOf("task"), body: z.string().min(1) }),
});

/** 显式派出/继续（取代 v1 的 task.dispatch 在新对象上的用法）。 */
export const WorkTaskDispatch = z.strictObject({
  op: z.literal("work.task.dispatch"),
  args: z.strictObject({
    task: idOf("task"),
    to: AgentTarget.optional().describe("派给谁；缺省用任务的负责人（负责人是 human 时拒绝）"),
    expected_revision: Revision.optional().describe("给出时与当前 revision 不符则 CONFLICT，确保派出的是看到的版本"),
  }),
});

export const WorkCommand = z.discriminatedUnion("op", [
  WorkProjectCreate, WorkProjectUpdate, WorkTaskCreate, WorkTaskUpdate, WorkTaskComment, WorkTaskDispatch,
]);
export const WORK_COMMAND_NAMES = WorkCommand.options.map((o) => o.shape.op.value);

export const WorkCommandRequest = z.strictObject({
  request_id: RequestId,
  operation: WorkCommand,
});

/** 命令结果：create/update → project 或 task；comment → comment；dispatch → job。 */
export const WorkCommandResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project"), project: WorkProject }),
  z.strictObject({ kind: z.literal("task"), task: WorkTask }),
  z.strictObject({ kind: z.literal("comment"), comment: WorkComment }),
  z.strictObject({ kind: z.literal("job"), job: Job }),
]);

export type Module = z.infer<typeof Module>;
export type ResourceRef = z.infer<typeof ResourceRef>;
export type ProjectStatus = z.infer<typeof ProjectStatus>;
export type TaskStatus = z.infer<typeof TaskStatus>;
export type WorkProject = z.infer<typeof WorkProject>;
export type WorkTask = z.infer<typeof WorkTask>;
export type WorkComment = z.infer<typeof WorkComment>;
export type WorkExecution = z.infer<typeof WorkExecution>;
export type WorkTaskDetail = z.infer<typeof WorkTaskDetail>;
export type WorkProjectPatch = z.infer<typeof WorkProjectPatch>;
export type WorkTaskPatch = z.infer<typeof WorkTaskPatch>;
export type WorkCommand = z.infer<typeof WorkCommand>;
export type WorkCommandName = WorkCommand["op"];
export type WorkCommandRequest = z.infer<typeof WorkCommandRequest>;
export type WorkCommandResult = z.infer<typeof WorkCommandResult>;

import { z } from "zod";
import { AgentTarget, ID_PREFIXES, Id, RequestId, Revision, TaskAssignee, Timestamp, idOf } from "./common.ts";
import { TASK_STATUSES } from "./entities.ts";
import { Job } from "./job.ts";
import { HandoffPlan, PlanRun, PlanStageId, PlanTemplate } from "./plan.ts";

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
  created_by: idOf("act").optional().describe("创建者身份；R3 之前的数据缺失"),
  updated_by: idOf("act").optional().describe("最近一次修改者身份（人或 agent，ADR 0029）；R3 之前的数据缺失"),
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
    created_by: idOf("act").optional().describe("创建者身份；R3 之前的数据缺失"),
    updated_by: idOf("act").optional().describe("最近一次修改者身份（人或 agent，ADR 0029）；界面据此显示「由 codex@server」"),
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
  acknowledged: z.strictObject({ at: Timestamp, by: idOf("act") }).optional()
    .describe("人点了「已查看」：这一轮不再出现在需要处理的列表里（ADR 0030）；不改变任务状态"),
});

/** `GET` 单个任务的完整视图。 */
export const WorkTaskDetail = z.strictObject({
  task: WorkTask,
  comments: z.array(WorkComment),
  executions: z.array(WorkExecution),
});


// ───────────────────────── 任务模型 v3（ADR 0032）─────────────────────────
//
// 任务只回答三个问题：结束了吗（outcome）、现在轮到谁（turn）、发生过什么（事件，只追加）。
// v3 与上面的 v2 并存，直到 R4-2 一次性切换：届时 WorkTaskV3 改名为 WorkTask、删除 v2 的 status / assignee 与相关命令。

export const TASK_OUTCOMES = ["open", "done", "cancelled"] as const;
export const TaskOutcome = z.enum(TASK_OUTCOMES);

/** 持有者：人、某个 agent（engine@device）、外部、无人。 */
export const TurnHolder = z.union([z.literal("human"), z.literal("external"), z.literal("nobody"), AgentTarget]);
export const TURN_REASONS = ["todo", "answer", "review", "failed", "working", "waiting", "on_hold"] as const;
export const TurnReason = z.enum(TURN_REASONS);
/** 需要人回应的原因：出现在「需要你处理」并触发推送。 */
export const RESPONSE_REASONS = ["answer", "review", "failed"] as const;

const HUMAN_REASONS = ["todo", "answer", "review", "failed"];
const reasonFits = (holder: string, reason: string) =>
  holder === "human" ? HUMAN_REASONS.includes(reason)
    : holder === "external" ? reason === "waiting"
      : holder === "nobody" ? reason === "on_hold"
        : reason === "working";

/** 现在轮到谁（ADR 0032 第 2 节）。持有者与原因必须匹配。 */
export const Turn = z
  .strictObject({
    holder: TurnHolder,
    reason: TurnReason,
    since: Timestamp,
    round: z.number().int().positive().optional().describe("相关的一轮：agent 正在执行的，或交回给人时刚结束的"),
    job: idOf("job").optional(),
    stage: PlanStageId.optional().describe("有交接计划时所在的阶段"),
    note: z.string().min(1).max(200).optional().describe("外部等待的说明（如「等导师回复」），或停下的原因（如「达到 8 轮上限」）"),
  })
  .refine((turn) => reasonFits(turn.holder, turn.reason), { message: "持有者与原因不匹配", path: ["reason"] });

/** 任务 v3。没有 status 与 assignee；结局只有人能改，轮到谁按 ADR 0032 第 3、4 节变化。 */
export const WorkTaskV3 = z
  .strictObject({
    schema_version: z.literal(3),
    type: z.literal("task"),
    id: idOf("task"),
    title: z.string().min(1),
    description: z.string().describe("描述正文，可用 Markdown 语法；不是知识笔记"),
    revision: Revision,
    outcome: TaskOutcome,
    turn: Turn,
    plan: PlanRun.optional().describe("交接计划与进度（ADR 0032 第 5 节）；缺失表示一轮交付后交回给人"),
    created: Timestamp,
    updated: Timestamp,
    created_by: idOf("act").optional(),
    updated_by: idOf("act").optional(),
    tags: z.array(z.string()),
    project: idOf("prj").optional(),
    parent: idOf("task").optional(),
    dependencies: z.array(idOf("task")),
    references: z.array(ResourceRef),
    due: Timestamp.optional(),
    ...RunConfigShape,
  })
  .superRefine((task, ctx) => {
    if (task.outcome !== "open" && task.turn.holder !== "nobody") ctx.addIssue({ code: "custom", path: ["turn"], message: "已完成或已取消的任务轮到无人" });
    if (task.parent === task.id) ctx.addIssue({ code: "custom", path: ["parent"], message: "任务不能是自己的父任务" });
    if (task.dependencies.includes(task.id) || new Set(task.dependencies).size !== task.dependencies.length) {
      ctx.addIssue({ code: "custom", path: ["dependencies"], message: "dependencies 不能包含自己或重复" });
    }
  });

/** 一次交接（只追加）：谁在何时把「轮到谁」从什么改成什么；结局变化也记在这里。 */
export const TaskTurnChange = z.strictObject({
  task: idOf("task"),
  at: Timestamp,
  by: idOf("act").describe("操作者；一轮结束与交接计划的自动交接记为 Hub 的系统身份"),
  from: Turn,
  to: Turn,
  outcome: TaskOutcome.optional().describe("这次同时改变了结局时的新结局"),
});

/** `GET` 单个任务（v3）：任务、讨论、轮次、交接记录。界面按时间合并成时间线。 */
export const WorkTaskDetailV3 = z.strictObject({
  task: WorkTaskV3,
  comments: z.array(WorkComment),
  executions: z.array(WorkExecution),
  turns: z.array(TaskTurnChange),
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
    comment: z.string().min(1).optional().describe(
      "回答并继续（ADR 0030）：先以调用者身份发表这条评论，再在同一事务里派出，下一轮的输入包含它；派出失败时评论也不保存",
    ),
  }),
});

/**
 * 交回（ADR 0032 第 3 节）：轮到人（todo）、外部（waiting，附说明）或无人（on_hold）。
 * 人都可以；agent 只能交给人或外部（低风险）。不能用它交给 agent，那是委派（work.task.dispatch）。
 */
export const WorkTaskHand = z.strictObject({
  op: z.literal("work.task.hand"),
  args: z
    .strictObject({
      task: idOf("task"),
      expected_revision: Revision,
      to: z.enum(["human", "external", "nobody"]),
      note: z.string().min(1).max(200).optional().describe("交给外部时说明在等什么"),
    })
    .refine((args) => args.to !== "external" || args.note !== undefined, "交给外部时要写明在等什么"),
});

/** 完成或取消（只有人）。正在进行的一轮随之取消，轮到无人。 */
export const WorkTaskFinish = z.strictObject({
  op: z.literal("work.task.finish"),
  args: z.strictObject({ task: idOf("task"), expected_revision: Revision, outcome: z.enum(["done", "cancelled"]) }),
});

/** 重新打开（只有人）：结局回到 open，轮到人（todo）。 */
export const WorkTaskReopen = z.strictObject({
  op: z.literal("work.task.reopen"),
  args: z.strictObject({ task: idOf("task"), expected_revision: Revision }),
});

/**
 * 设置、替换或清除交接计划（ADR 0032 第 5 节）。人设置即生效；agent 设置时需要批准，生成提议。
 * from：从哪个阶段开始（缺省第一个）；plan 为 null 时清除。设置计划不会自己开始委派，由人委派第一轮或在检查点选择继续。
 */
export const WorkTaskPlanSet = z.strictObject({
  op: z.literal("work.task.plan.set"),
  args: z.strictObject({ task: idOf("task"), expected_revision: Revision, plan: HandoffPlan.nullable(), from: PlanStageId.optional() }),
});

/**
 * 人在检查点（或计划结束后的验收）上的处理（只有人）：
 * continue 委派下一阶段；send_back 带评论回到 back_to 指定的 agent 阶段；finish 标记完成；hold 搁置。
 */
export const WorkTaskCheckpoint = z.strictObject({
  op: z.literal("work.task.checkpoint"),
  args: z
    .strictObject({
      task: idOf("task"),
      stage: z.union([PlanStageId, z.literal("end")]).describe("正在等人的阶段，防止对过时的阶段做决定"),
      action: z.enum(["continue", "send_back", "finish", "hold"]),
      back_to: PlanStageId.optional(),
      comment: z.string().min(1).optional(),
    })
    .refine((args) => (args.action === "send_back") === (args.back_to !== undefined), "send_back 必须且只能和 back_to 一起给")
    .refine((args) => args.action !== "send_back" || args.comment !== undefined, "打回时要写明要改什么"),
});

/** 保存计划模板（新建或按 template 覆盖）；删除模板。只有人。 */
export const PlanTemplateSave = z.strictObject({
  op: z.literal("work.plan_template.save"),
  args: z.strictObject({ template: idOf("wft").optional(), name: z.string().min(1).max(80), plan: HandoffPlan }),
});
export const PlanTemplateDelete = z.strictObject({
  op: z.literal("work.plan_template.delete"),
  args: z.strictObject({ template: idOf("wft") }),
});

/**
 * 人确认看过某一轮（等你验收、执行失败）而暂不处理（ADR 0030）。只有人能用；agent 一律拒绝。
 * 已被 ADR 0032 取代（改为 work.task.hand to=human，即「我自己来」）；R4-2 切换时删除。
 */
export const WorkTaskAcknowledge = z.strictObject({
  op: z.literal("work.task.acknowledge"),
  args: z.strictObject({ task: idOf("task"), round: z.number().int().positive() }),
});

export const WorkCommand = z.discriminatedUnion("op", [
  WorkProjectCreate, WorkProjectUpdate, WorkTaskCreate, WorkTaskUpdate, WorkTaskComment, WorkTaskDispatch, WorkTaskAcknowledge,
  WorkTaskHand, WorkTaskFinish, WorkTaskReopen, WorkTaskPlanSet, WorkTaskCheckpoint, PlanTemplateSave, PlanTemplateDelete,
]);

// ───────────────────────── 需要你处理（ADR 0030）─────────────────────────

export const ATTENTION_KINDS = ["question", "review", "failed"] as const;
export const AttentionKind = z.enum(ATTENTION_KINDS);

/**
 * `GET /v2/work/attention`：轮到人、且原因需要回应的任务（ADR 0032 第 2 节）。
 * question ⇔ 轮到人且原因 answer；review ⇔ review（一轮交付或交接计划的检查点）；failed ⇔ failed。轮到人但原因是 todo 时不在这里。
 * 每一项都对应最近的一轮（job、round）；来自检查点时带 stage 与 prompt。
 */
export const WorkAttention = z.strictObject({
  task: idOf("task"),
  title: z.string().min(1).describe("任务标题"),
  kind: AttentionKind,
  job: idOf("job"),
  round: z.number().int().positive(),
  agent: AgentTarget.optional().describe("这一轮由谁执行；回答并继续时默认委派给它"),
  since: Timestamp.describe("轮到人的时间"),
  question: z.string().min(1).optional().describe("kind 为 question 时 agent 的问题"),
  summary: z.string().optional().describe("汇报或失败原因的开头部分（最多 500 字符）；完整内容见 Job"),
  stage: PlanStageId.optional().describe("来自交接计划的检查点或计划结束时：所在阶段（ADR 0032 第 5 节）"),
  prompt: z.string().min(1).optional().describe("检查点给人的提示，如「是否合并？」"),
});

export const WORK_COMMAND_NAMES = WorkCommand.options.map((o) => o.shape.op.value);

export const WorkCommandRequest = z.strictObject({
  request_id: RequestId,
  operation: WorkCommand,
});

/**
 * 命令结果：create/update/hand/finish/reopen/plan/checkpoint → project 或 task；comment → comment；dispatch → job；
 * 模板保存 → template，删除 → removed；agent 发起而需要批准 → proposal（ADR 0031）。
 */
export const WorkCommandResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project"), project: WorkProject }),
  z.strictObject({ kind: z.literal("task"), task: WorkTask }),
  z.strictObject({ kind: z.literal("comment"), comment: WorkComment }),
  z.strictObject({ kind: z.literal("job"), job: Job }),
  z.strictObject({ kind: z.literal("template"), template: PlanTemplate }),
  z.strictObject({ kind: z.literal("removed"), id: idOf("wft") }),
  // agent 的委派或流程需要人批准（ADR 0031 第 2 节）：没有执行，生成了这条提议（只给 ID，避免与提议契约互相引用）
  z.strictObject({ kind: z.literal("proposal"), proposal: idOf("prop") }),
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
export type AttentionKind = z.infer<typeof AttentionKind>;
export type WorkAttention = z.infer<typeof WorkAttention>;
export type TaskOutcome = z.infer<typeof TaskOutcome>;
export type TurnHolder = z.infer<typeof TurnHolder>;
export type TurnReason = z.infer<typeof TurnReason>;
export type Turn = z.infer<typeof Turn>;
export type WorkTaskV3 = z.infer<typeof WorkTaskV3>;
export type TaskTurnChange = z.infer<typeof TaskTurnChange>;
export type WorkTaskDetailV3 = z.infer<typeof WorkTaskDetailV3>;

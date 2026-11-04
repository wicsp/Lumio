import { z } from "zod";
import { AgentTarget, Timestamp, idOf } from "./common.ts";

/**
 * 任务流程（ADR 0031 第 3 节）：有序的步骤，人批准一次后 agent 步骤之间自动委派，遇到人的步骤停下。
 *
 * - agent 步骤：交给某个 agent 做一件事；agent 在汇报里写 `<lumio-outcome>changes</lumio-outcome>` 表示打回，走 on_changes，否则走下一步。
 * - ask 步骤：问人一个问题，人选一个选项，按选项的 next 继续（可以是 "end" 结束流程）。
 * - accept 步骤：交给人验收，人标记完成即结束；人也可以补充意见并指定回到某一步。
 * 步骤 ID 只在本流程内唯一；"end" 是保留字。流程只能委派给自己写明的 agent。
 */

export const WORKFLOW_END = "end" as const;
export const WorkflowStepId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "步骤 ID 只能用小写字母、数字和 -，以字母开头")
  .refine((id) => id !== WORKFLOW_END, "end 是保留字");
const NextStep = z.union([WorkflowStepId, z.literal(WORKFLOW_END)]);

export const WorkflowAgentStep = z.strictObject({
  kind: z.literal("agent"),
  id: WorkflowStepId,
  agent: AgentTarget.describe("这一步交给谁，如 codex@mac"),
  instruction: z.string().min(1).max(4000).describe("这一步要做什么；与任务描述和此前各轮的汇报一起交给 agent"),
  next: NextStep.optional().describe("通过后去哪；缺省为下一个步骤，最后一步缺省为 end"),
  on_changes: WorkflowStepId.optional().describe("汇报带 <lumio-outcome>changes</lumio-outcome> 时回到哪一步；缺省表示不允许打回，按通过处理"),
});

export const WorkflowAskStep = z.strictObject({
  kind: z.literal("ask"),
  id: WorkflowStepId,
  question: z.string().min(1).max(500),
  options: z.array(z.strictObject({ label: z.string().min(1).max(60), next: NextStep })).min(2).max(4),
});

export const WorkflowAcceptStep = z.strictObject({
  kind: z.literal("accept"),
  id: WorkflowStepId,
  instruction: z.string().max(500).optional().describe("给验收人的提示，如「看一下页面是否正常」"),
});

export const WorkflowStep = z.discriminatedUnion("kind", [WorkflowAgentStep, WorkflowAskStep, WorkflowAcceptStep]);

export const DEFAULT_WORKFLOW_MAX_ROUNDS = 8;

/** 流程定义：步骤与轮数上限。引用的步骤必须存在。 */
export const Workflow = z
  .strictObject({
    steps: z.array(WorkflowStep).min(1).max(20),
    max_rounds: z.number().int().min(1).max(30).optional().describe(`agent 轮数上限，缺省 ${DEFAULT_WORKFLOW_MAX_ROUNDS}；到达上限即停下交给人`),
  })
  .superRefine((workflow, ctx) => {
    const ids = workflow.steps.map((step) => step.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["steps"], message: "步骤 ID 不能重复" });
    const known = new Set<string>([...ids, WORKFLOW_END]);
    workflow.steps.forEach((step, index) => {
      const refs = step.kind === "agent" ? [step.next, step.on_changes] : step.kind === "ask" ? step.options.map((option) => option.next) : [];
      for (const ref of refs) if (ref !== undefined && !known.has(ref)) ctx.addIssue({ code: "custom", path: ["steps", index], message: `引用了不存在的步骤 ${ref}` });
    });
    if (!workflow.steps.some((step) => step.kind !== "agent")) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: "流程至少要有一个人的步骤（ask 或 accept），完成由人决定" });
    }
  });

export const WORKFLOW_STOP_REASONS = ["max_rounds", "failed", "unknown", "paused", "cancelled", "by_human"] as const;

/**
 * 任务上的流程运行状态（存在 WorkTask.workflow）。
 * approved 缺失表示还没生效（agent 提出、等人批准的流程以提议存在，批准后才写到任务上，所以任务上的流程一般都已批准）。
 */
export const WorkflowRun = z.strictObject({
  workflow: Workflow,
  approved: z.strictObject({ at: Timestamp, by: idOf("act"), proposal: idOf("prop").optional() }),
  current: z.union([WorkflowStepId, z.literal(WORKFLOW_END)]).describe("当前步骤；end 表示流程已结束"),
  rounds: z.number().int().nonnegative().describe("流程已委派的 agent 轮数"),
  stopped: z.strictObject({ at: Timestamp, reason: z.enum(WORKFLOW_STOP_REASONS) }).optional()
    .describe("流程停下来交给人的原因；人重新开始（work.task.workflow.set 带 from）后清除"),
});

/** 流程模板（ADR 0031 第 3 节）：常用流程，新建任务时套用。 */
export const WorkflowTemplate = z.strictObject({
  id: idOf("wft"),
  name: z.string().min(1).max(80),
  workflow: Workflow,
  created: Timestamp,
  updated: Timestamp,
});

export type WorkflowStep = z.infer<typeof WorkflowStep>;
export type Workflow = z.infer<typeof Workflow>;
export type WorkflowRun = z.infer<typeof WorkflowRun>;
export type WorkflowTemplate = z.infer<typeof WorkflowTemplate>;

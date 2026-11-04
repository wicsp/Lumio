import { z } from "zod";
import { AgentTarget, Timestamp, idOf } from "./common.ts";

/**
 * 交接计划（ADR 0032 第 5 节，取代 ADR 0031 原来的「流程」）：只回答「一轮交付之后交给谁」。
 *
 * - agent 阶段：交给谁、做什么；可声明 back_to（agent 汇报里写 `<lumio-outcome>changes</lumio-outcome>` 时回到那个 agent 阶段）。
 * - 检查点：轮到人（review），附一句提示；人的处理固定为继续 / 打回 / 完成 / 搁置（work.task.checkpoint）。
 * - 计划走完 → 轮到人验收（review）。没有带选项的分支、没有单独的验收步骤和停止状态。
 */

export const PlanStageId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "阶段 ID 只能用小写字母、数字和 -，以字母开头");

export const PlanAgentStage = z.strictObject({
  kind: z.literal("agent"),
  id: PlanStageId,
  agent: AgentTarget.describe("这一阶段交给谁，如 codex@mac"),
  instruction: z.string().min(1).max(4000).describe("这一阶段要做什么；与任务描述等一起交给 agent（ADR 0032 第 6 节）"),
  back_to: PlanStageId.optional().describe("agent 汇报打回（<lumio-outcome>changes</lumio-outcome>）时回到哪个 agent 阶段；缺省表示不能打回，按交付处理"),
});

export const PlanCheckpoint = z.strictObject({
  kind: z.literal("checkpoint"),
  id: PlanStageId,
  prompt: z.string().min(1).max(200).describe("给人的一句提示，如「是否合并？」"),
});

export const PlanStage = z.discriminatedUnion("kind", [PlanAgentStage, PlanCheckpoint]);

export const DEFAULT_PLAN_MAX_ROUNDS = 8;

export const HandoffPlan = z
  .strictObject({
    stages: z.array(PlanStage).min(1).max(20),
    max_rounds: z.number().int().min(1).max(30).optional().describe(`计划内 agent 轮数上限，缺省 ${DEFAULT_PLAN_MAX_ROUNDS}；到达上限轮到人`),
  })
  .superRefine((plan, ctx) => {
    const ids = plan.stages.map((stage) => stage.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["stages"], message: "阶段 ID 不能重复" });
    const agents = new Set(plan.stages.filter((stage) => stage.kind === "agent").map((stage) => stage.id));
    plan.stages.forEach((stage, index) => {
      if (stage.kind === "agent" && stage.back_to !== undefined && !agents.has(stage.back_to)) {
        ctx.addIssue({ code: "custom", path: ["stages", index, "back_to"], message: `back_to 必须指向一个 agent 阶段：${stage.back_to}` });
      }
    });
    if (!plan.stages.some((stage) => stage.kind === "agent")) ctx.addIssue({ code: "custom", path: ["stages"], message: "计划至少要有一个 agent 阶段" });
  });

/** 任务上的计划与进度。stage 是正在进行或刚停下的阶段；end 表示计划已走完（之后轮到人验收）。 */
export const PlanRun = z.strictObject({
  plan: HandoffPlan,
  approved: z.strictObject({ at: Timestamp, by: idOf("act"), proposal: idOf("prop").optional() }),
  stage: z.union([PlanStageId, z.literal("end")]),
  rounds: z.number().int().nonnegative().describe("计划内已委派的 agent 轮数"),
});

/** 计划模板：常用计划，新建任务时套用（ID 前缀 wft）。 */
export const PlanTemplate = z.strictObject({
  id: idOf("wft"),
  name: z.string().min(1).max(80),
  plan: HandoffPlan,
  created: Timestamp,
  updated: Timestamp,
});

export type PlanStage = z.infer<typeof PlanStage>;
export type HandoffPlan = z.infer<typeof HandoffPlan>;
export type PlanRun = z.infer<typeof PlanRun>;
export type PlanTemplate = z.infer<typeof PlanTemplate>;

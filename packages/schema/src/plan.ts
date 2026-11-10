import { z } from "zod";
import { AgentTarget, Timestamp, idOf } from "./common.ts";

/**
 * 交接计划（ADR 0032 第 5 节；ADR 0049 扩展为有向无环的交接图，增加阶段权限、钩子与自动完成，取代 ADR 0031 原来的「流程」）：只回答「一轮交付之后交给谁」。
 *
 * - agent 阶段：交给谁、做什么；可声明 back_to（agent 汇报里写 `<lumio-outcome>changes</lumio-outcome>` 时回到那个 agent 阶段）。
 * - 检查点：轮到人（review），附一句提示；人的处理固定为继续 / 打回 / 完成 / 搁置（work.task.checkpoint）。
 * - 计划走完 → 轮到人验收（review）。没有带选项的分支、没有单独的验收步骤和停止状态。
 */

export const PlanStageId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "阶段 ID 只能用小写字母、数字和 -，以字母开头");

/** 本阶段注入的密钥名（ADR 0049 第 3 节）：只在执行节点解析，不进入提示、汇报与日志。 */
export const SecretName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "密钥名只能用小写字母、数字、_ 和 -");

/**
 * 阶段权限（ADR 0049 第 3 节）。缺省与 ADR 0049 之前的行为一致：可写工作目录、不能写 Git、没有额外密钥。
 * sandbox 为 os 的引擎由沙箱强制；sandbox 为 none 的引擎只能作为说明传给 agent。
 */
export const StageAccess = z.enum(["read", "write", "full"]);
export const StagePermissionsShape = {
  access: StageAccess.optional().describe("read 只读；write 可写工作目录（缺省）；full 不使用沙箱，以执行器账号运行"),
  git: z.boolean().optional().describe("允许写 Git 元数据（fetch、分支、提交、推送）；缺省 false"),
  secrets: z.array(SecretName).max(16).optional().describe("本阶段注入的密钥名"),
};
export const StagePermissions = z.strictObject(StagePermissionsShape);

/** 可选钩子（ADR 0049 第 4 节）：argv 不经过 shell，由 Runtime 以执行器账号在任务工作目录运行。 */
export const PlanHook = z.strictObject({
  argv: z.array(z.string().min(1)).min(1).max(64),
  timeout_minutes: z.number().int().min(1).max(1440).optional().describe("缺省 30"),
});
export const DEFAULT_HOOK_TIMEOUT_MINUTES = 30;

const After = z.array(PlanStageId).max(20).optional()
  .describe("在这些节点都交付后开始（ADR 0049 第 2 节）；缺省为列表中的上一个节点，第一个节点缺省没有前驱");

export const PlanAgentStage = z.strictObject({
  kind: z.literal("agent"),
  id: PlanStageId,
  agent: AgentTarget.describe("这一阶段交给谁，如 codex@mac"),
  instruction: z.string().min(1).max(4000).describe("这一阶段要做什么；与任务描述等一起交给 agent（ADR 0032 第 6 节）"),
  back_to: PlanStageId.optional().describe("agent 汇报打回（<lumio-outcome>changes</lumio-outcome>）时回到哪个 agent 阶段；缺省表示不能打回，按交付处理"),
  after: After,
  ...StagePermissionsShape,
  hooks: z.strictObject({ before: PlanHook.optional(), after: PlanHook.optional() }).optional()
    .describe("before 失败不启动 agent；after 失败按这一轮失败处理"),
});

export const PlanCheckpoint = z.strictObject({
  kind: z.literal("checkpoint"),
  id: PlanStageId,
  prompt: z.string().min(1).max(200).describe("给人的一句提示，如「是否合并？」"),
  after: After,
});

export const PlanStage = z.discriminatedUnion("kind", [PlanAgentStage, PlanCheckpoint]);

export const DEFAULT_PLAN_MAX_ROUNDS = 8;

export const PlanFinish = z.enum(["review", "auto"]);

/** 每个节点的前驱：显式 after，或列表中的上一个节点（ADR 0049 第 2 节）。 */
export function planPredecessors(stages: readonly { id: string; after?: readonly string[] | undefined }[]): Map<string, string[]> {
  return new Map(stages.map((stage, index) => [stage.id, stage.after ? [...stage.after] : index > 0 ? [stages[index - 1]!.id] : []]));
}

/** 每个节点的全部祖先（不含自己）。调用前要先确认无环。 */
export function planAncestors(stages: readonly { id: string; after?: readonly string[] | undefined }[]): Map<string, Set<string>> {
  const preds = planPredecessors(stages), memo = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    const known = memo.get(id);
    if (known) return known;
    const result = new Set<string>();
    memo.set(id, result);
    for (const pred of preds.get(id) ?? []) { result.add(pred); for (const value of visit(pred)) result.add(value); }
    return result;
  };
  for (const stage of stages) visit(stage.id);
  return memo;
}

/** 没有后继的节点：它们都完成时计划走完。 */
export function planSinks(stages: readonly { id: string; after?: readonly string[] | undefined }[]): string[] {
  const preds = planPredecessors(stages), used = new Set([...preds.values()].flat());
  return stages.map((stage) => stage.id).filter((id) => !used.has(id));
}

const writes = (stage: z.infer<typeof PlanStage>) => stage.kind === "agent" && (stage.access ?? "write") !== "read";

export const HandoffPlan = z
  .strictObject({
    stages: z.array(PlanStage).min(1).max(20),
    max_rounds: z.number().int().min(1).max(30).optional().describe(`计划内 agent 轮数上限，缺省 ${DEFAULT_PLAN_MAX_ROUNDS}；到达上限轮到人`),
    finish: PlanFinish.optional().describe("review：走完轮到人验收（缺省）；auto：走完自动完成，只允许含检查点的计划（ADR 0049 第 5 节）"),
  })
  .superRefine((plan, ctx) => {
    const ids = plan.stages.map((stage) => stage.id);
    if (new Set(ids).size !== ids.length) { ctx.addIssue({ code: "custom", path: ["stages"], message: "阶段 ID 不能重复" }); return; }
    const agents = new Set(plan.stages.filter((stage) => stage.kind === "agent").map((stage) => stage.id));
    plan.stages.forEach((stage, index) => {
      if (stage.kind === "agent" && stage.back_to !== undefined && !agents.has(stage.back_to)) {
        ctx.addIssue({ code: "custom", path: ["stages", index, "back_to"], message: `back_to 必须指向一个 agent 阶段：${stage.back_to}` });
      }
      for (const pred of stage.after ?? []) {
        if (!ids.includes(pred)) ctx.addIssue({ code: "custom", path: ["stages", index, "after"], message: `after 指向不存在的阶段：${pred}` });
        if (pred === stage.id) ctx.addIssue({ code: "custom", path: ["stages", index, "after"], message: "阶段不能在自己之后" });
      }
    });
    if (!plan.stages.some((stage) => stage.kind === "agent")) ctx.addIssue({ code: "custom", path: ["stages"], message: "计划至少要有一个 agent 阶段" });
    // 无环：按前驱做拓扑排序。
    const preds = planPredecessors(plan.stages);
    if ([...preds.values()].flat().some((pred) => !ids.includes(pred))) return;
    const pending = new Map([...preds].map(([id, list]) => [id, new Set(list)]));
    let progressed = true;
    while (pending.size && progressed) {
      progressed = false;
      for (const [id, list] of pending) if (![...list].some((pred) => pending.has(pred))) { pending.delete(id); progressed = true; }
    }
    if (pending.size) { ctx.addIssue({ code: "custom", path: ["stages"], message: `after 构成了环：${[...pending.keys()].join(", ")}` }); return; }
    // 可能同时进行的两个节点：互相都不是祖先。
    const ancestors = planAncestors(plan.stages);
    const concurrent = (a: string, b: string) => a !== b && !ancestors.get(a)!.has(b) && !ancestors.get(b)!.has(a);
    plan.stages.forEach((stage, index) => {
      const others = plan.stages.filter((other) => concurrent(stage.id, other.id));
      if (stage.kind === "checkpoint" && others.length) {
        ctx.addIssue({ code: "custom", path: ["stages", index, "after"], message: `检查点不能与其他节点并行：${stage.id}` });
      }
      if (writes(stage) && others.some((other) => writes(other) && plan.stages.indexOf(other) > index)) {
        ctx.addIssue({ code: "custom", path: ["stages", index, "access"], message: `同一时间最多一个可写阶段：${stage.id} 与 ${others.filter(writes).map((o) => o.id).join(", ")} 可能并行` });
      }
    });
    if (plan.finish === "auto" && !plan.stages.some((stage) => stage.kind === "checkpoint")) {
      ctx.addIssue({ code: "custom", path: ["finish"], message: "finish: auto 只允许用于含检查点的计划" });
    }
  });

/**
 * 任务上的计划与进度。stage 是正在进行或刚停下的节点（并行时为 active 中的第一个）；end 表示计划已走完。
 * active：同时在执行的 agent 阶段（只在并行时出现，至少两个）；done：已交付的节点（缺省视为 stage 之前的线性前缀，兼容 ADR 0049 之前的数据）。
 */
export const PlanRun = z.strictObject({
  plan: HandoffPlan,
  approved: z.strictObject({ at: Timestamp, by: idOf("act"), proposal: idOf("prop").optional() }),
  stage: z.union([PlanStageId, z.literal("end")]),
  active: z.array(PlanStageId).min(2).optional(),
  done: z.array(PlanStageId).optional(),
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
export type StagePermissions = z.infer<typeof StagePermissions>;
export type StageAccess = z.infer<typeof StageAccess>;
export type PlanHook = z.infer<typeof PlanHook>;
export type PlanFinish = z.infer<typeof PlanFinish>;
export type HandoffPlan = z.infer<typeof HandoffPlan>;
export type PlanRun = z.infer<typeof PlanRun>;
export type PlanTemplate = z.infer<typeof PlanTemplate>;

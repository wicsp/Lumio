import { z } from "zod";
import { RequestId, idOf } from "./common.ts";
import { PlanTemplateSave, WorkTaskDispatch, WorkTaskPlanSet } from "./work.ts";

/** 执行器上的高权限命令（ADR 0019 第 7 节、ADR 0020）：由执行器代一轮之内的 agent 提交，一律需要批准。 */
export const ExecPrivileged = z.strictObject({
  op: z.literal("exec.privileged"),
  args: z.strictObject({
    runtime: idOf("act"),
    job: idOf("job"),
    argv: z.array(z.string().min(1)).min(1),
  }),
});

/**
 * agent 发起、需要人批准的 Work 命令（ADR 0031 第 2 节、ADR 0032 第 5 节）：委派一轮、设置交接计划，
 * 或保存计划模板（ADR 0049 第 6 节：一句话生成计划后由人预览保存）。
 * 提议里存完整的命令；人批准后 Hub 以原 request_id 执行，任务 revision 已变或命令已不适用时失败并说明。
 * 它只出现在提议里（ProposalOperation），不加入 v1 的 Operation，`POST /v2/approval/privileged` 不接受它。
 */
export const WorkCommandProposal = z.strictObject({
  op: z.literal("work.command"),
  args: z.strictObject({
    request_id: RequestId,
    operation: z.discriminatedUnion("op", [WorkTaskDispatch, WorkTaskPlanSet, PlanTemplateSave]),
  }),
});

export const Operation = ExecPrivileged;
export const OPERATION_NAMES = [ExecPrivileged.shape.op.value];

export type Operation = z.infer<typeof Operation>;
export type OperationName = Operation["op"];

/** 提议里可以存的操作：高权限命令与 agent 的 Work 命令（ADR 0031、0032）。 */
export const ProposalOperation = z.discriminatedUnion("op", [ExecPrivileged, WorkCommandProposal]);
export type ProposalOperation = z.infer<typeof ProposalOperation>;
export type WorkCommandProposal = z.infer<typeof WorkCommandProposal>;

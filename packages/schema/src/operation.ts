import { z } from "zod";
import { AgentAssignee, idOf } from "./common.ts";

/**
 * 操作（ADR 0016 第 2 节）：程序对 vault 的每一次修改都表示为一个有名字的操作。
 * Hub 对每个操作先做授权（允许 / 拒绝 / 需要批准），再执行；需要批准的操作原样存进提议。
 *
 * 新增一种操作 = 在这里加一个成员，并在 Hub 中实现它的授权与执行。这是契约变更（ADR）。
 * `link.add` 已删除（ADR 0018）。
 */
/** 派出任务的下一轮（ADR 0019 第 3 节）。三种触发方式都走这一个操作。 */
export const TaskDispatch = z.strictObject({
  op: z.literal("task.dispatch"),
  args: z.strictObject({
    task: idOf("task"),
    trigger: z.enum(["assignee", "cli", "followup"]).describe("assignee：人把负责人改成 agent；cli：lumio task continue；followup：routine followup"),
    to: AgentAssignee.optional().describe("CLI 指定的负责人；缺省用最近一轮的 agent 与执行器"),
  }),
});

/**
 * 从例行任务的某一次结果开出一个普通任务（ADR 0019 第 6 节，P2-5）。Hub 在 `plan/tasks/` 新建任务笔记，
 * 执行配置照抄例行任务，`assignee: human`，等人写下追问后再派出。
 */
export const RoutineFollowup = z.strictObject({
  op: z.literal("routine.followup"),
  args: z.strictObject({
    routine: idOf("rtn"),
    job: idOf("job").describe("例行任务的哪一次（那一次的 Job）"),
  }),
});

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
 * 全部操作。TaskDispatch（P2-4）、RoutineFollowup（P2-5）已实现；ExecPrivileged 的格式已批准（ADR 0019、0020），
 * 由 P2-6 实现——在此之前 Hub 的授权表里没有它的规则，一律拒绝。
 */
export const Operation = z.discriminatedUnion("op", [TaskDispatch, RoutineFollowup, ExecPrivileged]);

export const OPERATION_NAMES = Operation.options.map((o) => o.shape.op.value);

export type Operation = z.infer<typeof Operation>;
export type OperationName = Operation["op"];

import { z } from "zod";
import { idOf } from "./common.ts";

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
    trigger: z.enum(["turn", "cli", "followup"]).describe("turn：人在笔记里把 turn 改成 agent；cli：lumio task continue；followup：routine followup"),
  }),
});

/** 执行器上的高权限命令（ADR 0019 第 7 节）：经 `lumio sudo` 发起，P2 中一律需要批准。 */
export const ExecPrivileged = z.strictObject({
  op: z.literal("exec.privileged"),
  args: z.strictObject({
    runtime: idOf("act"),
    job: idOf("job"),
    argv: z.array(z.string().min(1)).min(1),
  }),
});

/**
 * Hub 当前实现了的操作。TaskDispatch 由 P2-4 加入，ExecPrivileged 由 P2-6 加入；
 * 它们的格式已经批准（ADR 0019），实现时只需把它们放进这个列表。
 */
export const Operation = z.discriminatedUnion("op", [TaskDispatch]);

export const OPERATION_NAMES = Operation.options.map((o) => o.shape.op.value);

export type Operation = z.infer<typeof Operation>;
export type OperationName = Operation["op"];

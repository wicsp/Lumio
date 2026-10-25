import { z } from "zod";
import { Id } from "./common.ts";

/**
 * 操作（ADR 0016 第 2 节）：程序对 vault 的每一次修改都表示为一个有名字的操作。
 * Hub 对每个操作先做授权（允许 / 拒绝 / 需要批准），再执行；需要批准的操作原样存进提议。
 *
 * 新增一种操作 = 在这里加一个成员，并在 Hub 中实现它的授权与执行。这是契约变更（ADR）。
 * P1 只有 `link.add`。
 */
export const LinkAdd = z.strictObject({
  op: z.literal("link.add"),
  args: z.strictObject({
    from: Id.describe("要修改的笔记：在它的 frontmatter `related` 中加入 to"),
    to: Id.describe("要链接到的笔记"),
  }),
});

export const Operation = z.discriminatedUnion("op", [LinkAdd]);

export const OPERATION_NAMES = Operation.options.map((o) => o.shape.op.value);

export type Operation = z.infer<typeof Operation>;
export type OperationName = Operation["op"];

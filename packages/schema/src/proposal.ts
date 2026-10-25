import { z } from "zod";
import { Timestamp, idOf } from "./common.ts";
import { Operation } from "./operation.ts";

/**
 * 提议（ADR 0014 第 1 节，ADR 0016 第 3 节）：一个"需要批准"的操作，等人决定。
 * 存放在 Hub 的 hub.sqlite 中，不在 vault 里。提议里存的是完整的操作，接受后 Hub 原样执行它。
 */
export const ProposalStatus = z.enum(["pending", "accepted", "rejected"]);

export const Proposal = z.strictObject({
  id: idOf("prop"),
  operation: Operation,
  reason: z.string().min(1).max(2000).describe("提议理由，给人看"),
  author: idOf("act").describe("提交者的身份 ID"),
  status: ProposalStatus,
  created: Timestamp,
  decided: Timestamp.optional(),
  decided_by: idOf("act").optional().describe("做出决定的身份 ID（必须是 human 角色）"),
});

export type ProposalStatus = z.infer<typeof ProposalStatus>;
export type Proposal = z.infer<typeof Proposal>;

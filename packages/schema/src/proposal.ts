import { z } from "zod";
import { Timestamp, idOf } from "./common.ts";
import { ProposalOperation } from "./operation.ts";

/**
 * 提议（ADR 0014 第 1 节，ADR 0016 第 3 节）：一个"需要批准"的操作，等人决定。
 * 存放在 Hub 的 hub.sqlite 中，不在 vault 里。提议里存的是完整的操作，接受后 Hub 原样执行它。
 */
/** withdrawn：作者撤回，或被同一作者对同一任务的同类新提议取代（ADR 0033）。 */
export const ProposalStatus = z.enum(["pending", "accepted", "rejected", "withdrawn"]);

export const Proposal = z.strictObject({
  id: idOf("prop"),
  operation: ProposalOperation.describe("v1 操作，或 agent 的 Work 委派与交接计划（ADR 0031、0032）"),
  reason: z.string().min(1).max(2000).describe("提议理由，给人看"),
  author: idOf("act").describe("提交者的身份 ID"),
  status: ProposalStatus,
  created: Timestamp,
  decided: Timestamp.optional(),
  decided_by: idOf("act").optional().describe("做出决定的身份 ID：接受与拒绝必须是 human 角色；撤回是作者本人"),
  superseded_by: idOf("prop").optional().describe("被哪条新提议取代（只在 withdrawn 时出现，ADR 0033）"),
}).refine((proposal) => proposal.superseded_by === undefined || proposal.status === "withdrawn", { message: "只有已撤回的提议能有 superseded_by", path: ["superseded_by"] });

export type ProposalStatus = z.infer<typeof ProposalStatus>;
export type Proposal = z.infer<typeof Proposal>;

/** 摘要是分析建议。它没有提交命令或决定审批的字段（ADR 0085）。 */
export const ApprovalSummaryRequest = z.strictObject({ refresh: z.literal(true).optional() });

const summaryLine = z.string().trim().min(1).max(400).regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u);
export const ApprovalSummaryAnalysis = z.strictObject({
  intent: summaryLine,
  access: z.enum(["read", "write", "unknown"]),
  targets: z.array(z.string().min(1).max(160).regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u)).max(8),
  network: z.enum(["none", "connection", "exposure", "unknown"]),
  recommendation: z.enum(["approve", "caution", "reject"]),
  reason: summaryLine,
});
const summaryModel = z.string().trim().min(1).max(200);
export const ApprovalSummary = ApprovalSummaryAnalysis.extend({ model: summaryModel, privileged: z.literal(true) });
export const ApprovalSummaryResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("disabled") }),
  z.strictObject({ status: z.literal("empty"), model: summaryModel }),
  z.strictObject({ status: z.literal("blocked"), reason: z.enum(["sensitive", "too_large"]) }),
  z.strictObject({ status: z.literal("failed"), model: summaryModel, previous: ApprovalSummary.optional() }),
  z.strictObject({ status: z.literal("ready"), summary: ApprovalSummary }),
]);

export type ApprovalSummaryRequest = z.infer<typeof ApprovalSummaryRequest>;
export type ApprovalSummaryResult = z.infer<typeof ApprovalSummaryResult>;

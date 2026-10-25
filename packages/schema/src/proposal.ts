import { z } from "zod";
import { Id, Timestamp, idOf } from "./common.ts";

/**
 * AI 的提议（ADR 0014 第 1、7 节，ADR 0007）。存放在 Hub 的 hub.sqlite 中，不在 vault 里。
 * P1 只支持一种提议：在 from 笔记的 frontmatter `related` 中加入 to。
 */
export const PROPOSAL_KINDS = ["link"] as const;

export const ProposalStatus = z.enum(["pending", "accepted", "rejected"]);

export const Proposal = z.strictObject({
  id: idOf("prop"),
  kind: z.enum(PROPOSAL_KINDS),
  from: Id.describe("要修改的笔记"),
  to: Id.describe("要链接到的笔记"),
  reason: z.string().min(1).max(2000).describe("提议理由，给人看"),
  author: z.string().min(1).describe("提交提议的令牌名称，如 claude-code@mac"),
  status: ProposalStatus,
  created: Timestamp,
  decided: Timestamp.optional(),
  decided_by: z.string().optional().describe("做出决定的令牌名称（必须是 human 角色）"),
});

/** 提交提议时的请求体。id、author、status、时间由 Hub 生成。 */
export const NewProposal = Proposal.pick({ kind: true, from: true, to: true, reason: true });

export type Proposal = z.infer<typeof Proposal>;
export type NewProposal = z.infer<typeof NewProposal>;

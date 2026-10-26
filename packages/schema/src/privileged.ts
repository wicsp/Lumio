import { z } from "zod";
import { Timestamp, idOf } from "./common.ts";

/**
 * 高权限命令的批准凭据与回报（ADR 0020）。
 *
 * 人接受 `exec.privileged` 提议后，Hub 签发一张凭据；执行器把它交给 root 助手程序，助手程序用 Hub 的公钥验证后执行一次。
 */

/** 签名覆盖的字段（顺序固定，见 `privilegedSigningPayload`）。 */
export const PrivilegedGrant = z.strictObject({
  proposal: idOf("prop"),
  runtime: idOf("act").describe("只能在这个执行器上执行"),
  job: idOf("job").describe("发起申请的那一轮"),
  argv: z.array(z.string().min(1)).min(1),
  approved_by: idOf("act"),
  approved_at: Timestamp,
  expires: Timestamp.describe("过期后助手程序拒绝执行（批准后 10 分钟）"),
});

export const PrivilegedApproval = PrivilegedGrant.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/).describe("Ed25519 签名，base64url（无填充）"),
});

/** `GET /v1/runtime/privileged/<提议 ID>`：执行器取回申请状态。只有 accepted 带凭据。 */
export const PrivilegedStatus = z.discriminatedUnion("status", [
  z.strictObject({ proposal: idOf("prop"), status: z.literal("pending") }),
  z.strictObject({ proposal: idOf("prop"), status: z.literal("accepted"), approval: PrivilegedApproval }),
  z.strictObject({ proposal: idOf("prop"), status: z.literal("rejected") }),
  z.strictObject({ proposal: idOf("prop"), status: z.literal("expired").describe("这一轮已结束，或凭据已过期") }),
]);

/** `POST /v1/runtime/privileged`：执行完后回报。不含命令输出。 */
export const PrivilegedReport = z.strictObject({
  proposal: idOf("prop"),
  job: idOf("job"),
  status: z.enum(["done", "failed", "refused"]).describe("refused：助手程序拒绝执行（签名、过期、已用过等）"),
  exit_code: z.number().int().optional(),
  started: Timestamp.optional(),
  finished: Timestamp,
  error: z.string().optional().describe("给人看的原因；不含命令输出"),
});

/**
 * 签名的字节串：按固定顺序取字段的 JSON。Hub 签名与助手程序验证都用它，两边不能各写一份。
 */
export function privilegedSigningPayload(grant: z.input<typeof PrivilegedGrant> & { signature?: string }): string {
  const { signature: _signature, ...fields } = grant;
  const g = PrivilegedGrant.parse(fields);
  return JSON.stringify(["lumio-privileged-v1", g.proposal, g.runtime, g.job, g.argv, g.approved_by, g.approved_at, g.expires]);
}

export type PrivilegedGrant = z.infer<typeof PrivilegedGrant>;
export type PrivilegedApproval = z.infer<typeof PrivilegedApproval>;
export type PrivilegedStatus = z.infer<typeof PrivilegedStatus>;
export type PrivilegedReport = z.infer<typeof PrivilegedReport>;

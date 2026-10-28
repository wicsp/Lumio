import { z } from "zod";
import { Timestamp, idOf } from "./common.ts";
import { RuntimeName } from "./job.ts";

/**
 * 安装、配对与自检（ADR 0021）。
 */

/** CLI 配置文件 `~/.config/lumio/config.json`（权限 0600）。环境变量 LUMIO_HUB_URL、LUMIO_TOKEN、LUMIO_VAULT 优先于它。 */
export const CliConfig = z.strictObject({
  hub_url: z.url().describe("如 http://127.0.0.1:7420"),
  token: z.string().min(1).describe("human 身份的令牌"),
  vault: z.string().min(1).optional().describe("本机 vault 的绝对路径；新建笔记、export bib 用"),
});

/** 一次性配对码：base32（无填充、小写），128 位以上。 */
export const PairingCode = z.string().regex(/^[a-z2-7]{26,}$/, "配对码格式不对");

/** `POST /v1/runtime-invites`（human）：为一台执行器生成配对码。 */
export const RuntimeInviteRequest = z.strictObject({ name: RuntimeName });

export const RuntimeInvite = z.strictObject({
  name: RuntimeName,
  actor: idOf("act"),
  code: PairingCode,
  expires: Timestamp.describe("10 分钟后过期，只能用一次"),
  hub_url: z.url().describe("执行器用来连 Hub 的地址（Tailscale）"),
  command: z.string().min(1).describe("在服务器上运行的那一行命令"),
});

/** `POST /v1/runtime/join`（不需要令牌，只认配对码）：执行器用配对码换取令牌。 */
export const RuntimeJoinRequest = z.strictObject({ code: PairingCode });

export const RuntimeJoin = z.strictObject({
  name: RuntimeName,
  actor: idOf("act"),
  token: z.string().min(1).describe("只在这一次响应里出现；同名的旧令牌已吊销"),
});

/** `GET /v1/runtime/signing-key`（runtime）：Hub 的 Ed25519 公钥，安装提权助手时用（ADR 0020、0021）。 */
export const HubSigningKey = z.strictObject({
  public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/).describe("32 字节原始公钥，base64url"),
  fingerprint: z.string().regex(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/).describe("公钥 SHA-256 的前 8 字节，给人核对用"),
});

/** 公钥指纹：SHA-256(原始公钥) 的前 8 字节，十六进制，每 4 位一组。两边都用它显示，人才能对得上。 */
export function signingKeyFingerprint(sha256Hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error("需要 SHA-256 的十六进制值");
  return sha256Hex.slice(0, 16).match(/.{4}/g)!.join("-");
}

export type CliConfig = z.infer<typeof CliConfig>;
export type RuntimeInviteRequest = z.infer<typeof RuntimeInviteRequest>;
export type RuntimeInvite = z.infer<typeof RuntimeInvite>;
export type RuntimeJoinRequest = z.infer<typeof RuntimeJoinRequest>;
export type RuntimeJoin = z.infer<typeof RuntimeJoin>;
export type HubSigningKey = z.infer<typeof HubSigningKey>;

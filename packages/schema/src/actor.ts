import { z } from "zod";
import { Timestamp, idOf } from "./common.ts";

/**
 * 身份（ADR 0016 第 1 节）：Hub 里"谁在操作"。人和每个 AI agent 各是一个身份。
 * 令牌只是身份的凭证，一个身份可以有多个令牌，令牌可以单独吊销；提议、审计记录里存的是身份 ID，不是令牌。
 * 身份存放在 Hub 的 hub.sqlite 中，不在 vault 里。P1 中身份只有名称和角色。
 */
export const ActorRole = z.enum(["human", "agent"]);

export const Actor = z.strictObject({
  id: idOf("act"),
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9@._-]{0,63}$/, "名称只能用小写字母、数字和 @ . _ -")
    .describe("给人看的名称，唯一，如 wenbin、claude-code@mac"),
  role: ActorRole,
  created: Timestamp,
});

export type ActorRole = z.infer<typeof ActorRole>;
export type Actor = z.infer<typeof Actor>;

import { z } from "zod";
import { Actor } from "./actor.ts";
import { Timestamp, idOf } from "./common.ts";

/**
 * agent 访问 Lumio 的凭据（ADR 0029 第 5、6 节）。
 * 令牌只在创建或交付时出现一次；Hub 只存哈希，任何查询接口都不返回令牌原文。
 */

/**
 * 一轮的访问凭据：随 `RuntimeSync.access` 交给执行器，只交给这一轮的 agent 进程（LUMIO_HUB_URL、LUMIO_TOKEN）。
 * 身份是该轮负责人对应的 agent（如 codex@server），权限同其他 agent 令牌；该轮结束、取消或 lease 失效时作废，
 * expires 是硬性上限。不写入 Job 记录、日志或结果。例行任务在执行器本地触发的轮次没有凭据。
 */
export const JobAccess = z.strictObject({
  job: idOf("job"),
  actor: idOf("act").describe("这一轮使用的 agent 身份"),
  token: z.string().min(32).describe("只属于这一轮的令牌"),
  expires: Timestamp.describe("最晚失效时间；该轮提前结束时更早作废"),
});

/** `lumio agent add <名称>`：human 为自己的外部 agent（Codex、Claude Code、pi……）取得令牌。 */
export const AgentTokenRequest = z.strictObject({
  name: Actor.shape.name.describe("agent 身份名称，如 codex@mac；不存在时创建（角色 agent），已存在时为它再发一把令牌"),
  label: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional().describe("令牌标签，便于以后吊销；缺省由 Hub 生成"),
});

/** 创建结果：令牌只出现这一次。 */
export const AgentTokenIssued = z.strictObject({
  actor: Actor,
  label: z.string().min(1),
  token: z.string().min(32),
  created: Timestamp,
});

/** `lumio agent list` 与设置页「已连接的 agent」的一项。 */
export const AgentInfo = z.strictObject({
  actor: Actor,
  tokens: z.array(z.strictObject({
    label: z.string().min(1),
    created: Timestamp,
    last_used: Timestamp.optional(),
    kind: z.enum(["manual", "job"]).describe("manual：用户发的；job：某一轮的临时凭据"),
    job: idOf("job").optional().describe("kind 为 job 时所属的一轮"),
  })).describe("仍有效的令牌（不含令牌原文）"),
  last_activity: Timestamp.optional().describe("最近一次被授权的操作时间"),
});

/** `lumio agent revoke`：吊销某个令牌，或省略 label 吊销该 agent 的全部令牌。 */
export const AgentRevokeRequest = z.strictObject({
  name: Actor.shape.name,
  label: z.string().min(1).optional(),
});

export type JobAccess = z.infer<typeof JobAccess>;
export type AgentTokenRequest = z.infer<typeof AgentTokenRequest>;
export type AgentTokenIssued = z.infer<typeof AgentTokenIssued>;
export type AgentInfo = z.infer<typeof AgentInfo>;
export type AgentRevokeRequest = z.infer<typeof AgentRevokeRequest>;

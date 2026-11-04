import { z } from "zod";
import { Timestamp, idOf } from "./common.ts";

/**
 * 通知（ADR 0031 第 4 节）：Hub 内一个通知接口，事件交给已启用的各个通道；先做 Web Push（PWA）。
 * 正文只含标题与事件类型，不含汇报、问题原文或私密内容；点击打开 path 指向的页面。
 */

export const NOTIFICATION_KINDS = [
  "attention.question", // agent 在等你回答
  "attention.review", // 一轮完成，等你验收
  "attention.failed", // 一轮失败或结果不明
  "attention.decision", // 流程走到你的 ask 步骤
  "proposal.pending", // 待批准的提议（含 agent 的委派与流程）
] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);

/** 交给各通道的一条通知。同一事件只发一次（id 去重）。 */
export const NotificationEvent = z.strictObject({
  id: z.string().min(8).max(128).describe("去重键，如 attention:<task>:<round>:<kind>"),
  kind: NotificationKind,
  owner: idOf("act").describe("收通知的人"),
  title: z.string().min(1).max(120).describe("任务标题或提议摘要；不含汇报与问题原文"),
  path: z.string().regex(/^#[a-z]+(\/[A-Za-z0-9_-]+)?$/).describe("网页内的跳转位置，如 #work/task_…"),
  created: Timestamp,
});

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/);

/** 浏览器 PushSubscription.toJSON() 的内容，外加一个设备名。只接受 https 推送地址。 */
export const PushSubscriptionInput = z.strictObject({
  endpoint: z.string().url().refine((value) => value.startsWith("https://"), "推送地址必须是 https"),
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({ p256dh: Base64Url, auth: Base64Url }),
  label: z.string().min(1).max(60).optional().describe("设备名，如 iPhone；缺省由 Hub 按 User-Agent 生成"),
});

/** 已订阅的设备。不返回推送地址与密钥。 */
export const PushDevice = z.strictObject({
  id: idOf("pdev"),
  owner: idOf("act"),
  label: z.string().min(1).max(60),
  events: z.array(NotificationKind).describe("这台设备接收哪些事件；新订阅缺省全部"),
  created: Timestamp,
  last_success: Timestamp.optional(),
  last_error: z.string().max(200).optional().describe("最近一次发送失败的原因（不含推送地址）；推送服务返回 404/410 时设备被自动移除"),
});

export const PushDeviceUpdate = z.strictObject({
  label: z.string().min(1).max(60).optional(),
  events: z.array(NotificationKind).optional(),
}).refine((update) => update.label !== undefined || update.events !== undefined, "至少修改一项");

/** `GET /v2/notifications/push/key`：网页订阅时用的 VAPID 公钥（base64url）。私钥只在 Hub 私密保存。 */
export const PushPublicKey = z.strictObject({ public_key: Base64Url });

/** 测试通知的结果。 */
export const PushTestResult = z.strictObject({
  delivered: z.boolean(),
  error: z.string().max(200).optional(),
});

export type NotificationKind = z.infer<typeof NotificationKind>;
export type NotificationEvent = z.infer<typeof NotificationEvent>;
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;
export type PushDevice = z.infer<typeof PushDevice>;
export type PushDeviceUpdate = z.infer<typeof PushDeviceUpdate>;
export type PushPublicKey = z.infer<typeof PushPublicKey>;
export type PushTestResult = z.infer<typeof PushTestResult>;

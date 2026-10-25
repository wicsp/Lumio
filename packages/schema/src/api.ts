import { z } from "zod";
import { idOf } from "./common.ts";
import { Operation } from "./operation.ts";
import { Proposal } from "./proposal.ts";

/**
 * Hub API 的通用请求与响应（ADR 0016 第 2–4 节）。
 */

/** `POST /v1/operations` 的请求体。 */
export const OperationRequest = z.strictObject({
  operation: Operation,
  reason: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe("为什么要做这个操作；操作需要批准时必填，会成为提议的理由"),
});

/**
 * `POST /v1/operations` 的成功响应。授权结果为"允许"时立即执行（applied）；
 * 为"需要批准"时生成一条提议（pending_approval，HTTP 202）。"拒绝"走 ApiError。
 */
export const OperationResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("applied"), operation: Operation }),
  z.strictObject({ status: z.literal("pending_approval"), proposal: Proposal }),
]);

/** 错误代码。客户端（包括 AI）按 code 判断该怎么做，message 只给人看。 */
export const API_ERROR_CODES = [
  "INVALID", // 400：请求不合法
  "UNAUTHENTICATED", // 401：没有令牌、令牌错误或已吊销
  "FORBIDDEN", // 403：授权结果为"拒绝"
  "NOT_FOUND", // 404
  "CONFLICT", // 409：状态冲突，如文件已被修改、提议已决定
  "INTERNAL", // 500
] as const;

/**
 * 所有错误响应的格式。授权失败时带上被拒绝的操作和原因，
 * 让 AI 能在对话里告诉人"我想做什么、为什么不行"（决策支持信息）。
 */
export const ApiError = z.strictObject({
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    message: z.string().min(1),
    operation: Operation.optional().describe("被拒绝或出错的操作"),
    reason: z.string().optional().describe("授权被拒绝的原因，如 agent-cannot-decide-proposals"),
    proposal: idOf("prop").optional().describe("相关的提议"),
  }),
});

export type OperationRequest = z.infer<typeof OperationRequest>;
export type OperationResult = z.infer<typeof OperationResult>;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
export type ApiError = z.infer<typeof ApiError>;

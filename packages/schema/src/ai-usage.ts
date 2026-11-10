import { z } from "zod";
import { idOf, Timestamp } from "./common.ts";

export const AIDecimal = z.string().regex(/^-?[0-9]{1,24}(\.[0-9]{1,12})?$/);
const Threshold = AIDecimal.refine(value => !value.startsWith("-"));
const Percentage = z.number().min(0).max(100);
export const AIQuotaWindow = z.strictObject({
  id: z.string().min(1).max(160),
  label: z.string().min(1).max(120).optional(),
  minutes: z.number().int().positive().max(525600).optional(),
  used_percent: Percentage.optional(),
  resets_at: Timestamp.optional(),
});
const QuotaWindows = z.array(AIQuotaWindow).min(1).max(64)
  .refine(windows => new Set(windows.map(window => window.id)).size === windows.length);
export const AIQuotaStatus = z.enum(["waiting", "unsupported", "credentials", "offline", "error", "stale", "ready"]);
export const AIQuotaSnapshot = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("deepseek"), sampled_at: Timestamp, available: z.boolean(),
    balances: z.array(z.strictObject({
      currency: z.enum(["CNY", "USD"]), total: AIDecimal, topped_up: AIDecimal, granted: AIDecimal,
    })).max(2).refine(balances => new Set(balances.map(balance => balance.currency)).size === balances.length),
  }),
  z.strictObject({ source: z.enum(["codex", "claude-code"]), sampled_at: Timestamp, windows: QuotaWindows }),
]);
export const AIQuotaSettings = z.strictObject({
  monitor: z.boolean(),
  thresholds: z.strictObject({ CNY: Threshold.optional(), USD: Threshold.optional(), remaining_percent: Percentage.optional() }),
});
export const ClaudeQuotaBinding = z.strictObject({ connection: idOf("aic"), generation: z.string().uuid() });
export const ClaudeQuotaBindings = z.array(ClaudeQuotaBinding);
export const ClaudeQuotaSample = ClaudeQuotaBinding.extend({
  sampled_at: Timestamp,
  windows: z.array(AIQuotaWindow.extend({
    id: z.enum(["five_hour", "seven_day"]),
    label: z.never().optional(),
    used_percent: Percentage,
  })).min(1).max(2).refine(windows => new Set(windows.map(window => window.id)).size === windows.length),
});
export const AIQuotaView = z.strictObject({
  connection: idOf("aic"),
  status: AIQuotaStatus,
  settings: AIQuotaSettings,
  snapshot: AIQuotaSnapshot.optional(),
  attention: z.boolean(),
  claude_binding: ClaudeQuotaBinding.optional(),
});
export const AIQuotaViews = z.array(AIQuotaView);

export type AIQuotaWindow = z.infer<typeof AIQuotaWindow>;
export type AIQuotaStatus = z.infer<typeof AIQuotaStatus>;
export type AIQuotaSnapshot = z.infer<typeof AIQuotaSnapshot>;
export type AIQuotaSettings = z.infer<typeof AIQuotaSettings>;
export type AIQuotaView = z.infer<typeof AIQuotaView>;
export type ClaudeQuotaBinding = z.infer<typeof ClaudeQuotaBinding>;
export type ClaudeQuotaSample = z.infer<typeof ClaudeQuotaSample>;

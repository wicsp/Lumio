import { AIQuotaWindow, type AIQuotaWindow as Window } from "@lumio/schema";
import type { Wire } from "./rpc.ts";

export function quotaReset(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds >= 253402300800) return;
  return new Date(seconds * 1000).toISOString();
}

export function codexWindows(reply: Wire): Window[] {
  const byId = reply.rateLimitsByLimitId;
  const buckets: [string, Wire][] = byId && typeof byId === "object" && !Array.isArray(byId) && Object.keys(byId).length
    ? Object.entries(byId) : reply.rateLimits ? [[reply.rateLimits.limitId ?? "codex", reply.rateLimits]] : [];
  return buckets.slice(0, 32).flatMap(([id, bucket]) => ["primary", "secondary"].flatMap(slot => {
    const raw = bucket?.[slot];
    if (!raw || typeof raw !== "object") return [];
    const percent = typeof raw.usedPercent === "number" && raw.usedPercent >= 0 && raw.usedPercent <= 100 ? raw.usedPercent : undefined;
    const minutes = Number.isSafeInteger(raw.windowDurationMins) && raw.windowDurationMins > 0 && raw.windowDurationMins <= 525600
      ? raw.windowDurationMins : undefined;
    const resets_at = quotaReset(raw.resetsAt);
    const parsed = AIQuotaWindow.safeParse({ id: `${id}:${slot}`, label: typeof bucket.limitName === "string" ? bucket.limitName.slice(0, 120) || undefined : undefined,
      minutes, used_percent: percent, resets_at });
    return parsed.success && (percent !== undefined || minutes !== undefined || resets_at !== undefined) ? [parsed.data] : [];
  }));
}

import { ResourceRef } from "@lumio/schema";

/** Passed to the new-task dialog in memory only. Never put source titles in a URL. */
export function sourceTaskIntent(refs: ResourceRef[]): string {
  return "new-from:" + JSON.stringify(refs);
}

export function taskSources(intent: string): ResourceRef[] {
  if (!intent.startsWith("new-from:")) return [];
  try {
    const result = ResourceRef.array().min(1).max(2).safeParse(JSON.parse(intent.slice("new-from:".length)));
    return result.success ? result.data : [];
  } catch { return []; }
}

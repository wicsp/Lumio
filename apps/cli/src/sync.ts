import { text } from "./messages.ts";
import { syncVault as sync, type SyncOptions } from "@lumio/storage";
export type { SyncOptions } from "@lumio/storage";

export async function syncVault(root: string, options: SyncOptions = {}): Promise<number> {
  const result = await sync(root, { ...options, text, log: options.log ?? console.log });
  return result.problems || result.skipped ? 1 : 0;
}

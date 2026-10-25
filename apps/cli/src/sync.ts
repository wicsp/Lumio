import { syncVault as sync, type SyncOptions } from "@lumio/core";
export type { SyncOptions } from "@lumio/core";

export async function syncVault(root: string, options: SyncOptions = {}): Promise<number> {
  const result = await sync(root, { ...options, log: options.log ?? console.log });
  return result.problems || result.skipped ? 1 : 0;
}

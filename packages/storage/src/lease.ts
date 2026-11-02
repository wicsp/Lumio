import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { StorageError } from "./errors.ts";

/** SQLite's OS lock is released on process death; the lock file is deliberately never unlinked. */
export async function acquireStateLease(stateDir: string): Promise<{ close(): void }> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, ".business-writer.sqlite"), db = new Database(path, { strict: true });
  try {
    db.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS guard (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE");
    await chmod(path, 0o600);
  } catch {
    db.close(); throw new StorageError("CONFLICT", "业务状态正由另一个 Hub 或迁移进程使用");
  }
  let closed = false;
  return { close() { if (!closed) { closed = true; db.close(); } } };
}

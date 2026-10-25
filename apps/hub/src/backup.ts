import { Database } from "bun:sqlite";
import { chmod, link, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HubError } from "./errors.ts";

/** VACUUM reads a consistent snapshot, including commits still in the live database's WAL. */
export async function backupHub(stateDir: string, destination: string): Promise<void> {
  let db: Database | undefined;
  let temporary: string | undefined;
  const path = resolve(destination);
  try {
    // A 0700 directory keeps the snapshot private while SQLite creates it. Publish with
    // an exclusive hard link only after setting 0600; never overwrite even an empty target.
    temporary = await mkdtemp(join(dirname(path), ".lumio-backup-"));
    const snapshot = join(temporary, "hub.sqlite");
    db = new Database(join(stateDir, "hub.sqlite"), { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout = 5000");
    db.query("VACUUM INTO ?").run(snapshot);
    await chmod(snapshot, 0o600);
    const handle = await open(snapshot, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    await link(snapshot, path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new HubError("CONFLICT", "备份目标已存在");
    if (code === "ENOENT") throw new HubError("INVALID", "备份目标目录或 hub.sqlite 不存在");
    throw new HubError("INTERNAL", "无法备份 hub.sqlite");
  } finally {
    db?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

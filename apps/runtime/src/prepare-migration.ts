import { Database } from "bun:sqlite";
import { resolve, join } from "node:path";
import { acquireStateLease } from "@lumio/storage";
import { RuntimeError } from "./config.ts";

/** Explicit offline prerequisite: discard only derived schedule cache after all effects and receipts are settled. */
export async function prepareMigration(directory: string): Promise<void> {
  const state = resolve(directory), lease = await acquireStateLease(state); let db: Database | undefined;
  try {
    if (!await Bun.file(join(state, "runtime.sqlite")).exists()) throw new RuntimeError("找不到执行器状态库");
    db = new Database(join(state, "runtime.sqlite"), { strict: true });
    const exists = (name: string) => !!db!.query("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(name);
    const count = (sql: string) => db!.query<{ n: number }, []>(sql).get()!.n;
    if (count("SELECT count(*) AS n FROM queue WHERE state<>'finished'") || count("SELECT count(*) AS n FROM outbox")
      || (exists("privileged_outbox") && count("SELECT count(*) AS n FROM privileged_outbox"))
      || (exists("archive_outbox") && count("SELECT count(*) AS n FROM archive_outbox WHERE state<>'confirmed'"))) {
      throw new RuntimeError("仍有未完成执行或待交付结果/文件，请先连上 Hub 完成交回后再准备迁移");
    }
    db.transaction(() => { if (exists("routines")) db!.exec("DELETE FROM routines"); })();
  } finally { db?.close(); lease.close(); }
}

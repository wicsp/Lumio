import { text as msg } from "./messages.ts";
import { Database } from "bun:sqlite";
import { resolve, join } from "node:path";
import { acquireStateLease } from "@lumio/storage";
import { RuntimeError } from "./config.ts";

/** Explicit offline prerequisite: discard only derived schedule cache after all effects and receipts are settled. */
export async function prepareMigration(directory: string): Promise<void> {
  const state = resolve(directory), lease = await acquireStateLease(state); let db: Database | undefined;
  try {
    if (!await Bun.file(join(state, "runtime.sqlite")).exists()) throw new RuntimeError(msg("prepare-migration.runtime_state_database_not_found"));
    db = new Database(join(state, "runtime.sqlite"), { strict: true });
    const exists = (name: string) => !!db!.query("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(name);
    const count = (sql: string) => db!.query<{ n: number }, []>(sql).get()!.n;
    if (count("SELECT count(*) AS n FROM queue WHERE state<>'finished'") || count("SELECT count(*) AS n FROM outbox")
      || (exists("privileged_outbox") && count("SELECT count(*) AS n FROM privileged_outbox"))
      || (exists("archive_outbox") && count("SELECT count(*) AS n FROM archive_outbox WHERE state<>'confirmed'"))) {
      throw new RuntimeError(msg("prepare-migration.unfinished_executions_or_pending_results_files_remain_connect_to_hub"));
    }
    db.transaction(() => { if (exists("routines")) db!.exec("DELETE FROM routines"); })();
  } finally { db?.close(); lease.close(); }
}

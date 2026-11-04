import { HubStore } from "./store.ts";
import { migrateTaskModel } from "@lumio/storage";
import { text as msg } from "./messages.ts";
import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MigrationPlan, idOf } from "@lumio/schema";
import { LegacyMigration, acquireStateLease, StorageError } from "@lumio/storage";
import { WorkError } from "@lumio/work";
import { ExecutionError } from "@lumio/execution";
import { stateDirectory } from "./config.ts";
import { HubError } from "./errors.ts";

export async function runMigration(args: string[], log: (line: string) => void, options: { stateDir?: string } = {}): Promise<void> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    vault: { type: "string" }, output: { type: "string" }, plan: { type: "string" }, backup: { type: "string" },
    "runtimes-prepared": { type: "boolean" }, json: { type: "boolean" },
  } });
  const [action, id] = positionals, allowed = action === "retire" ? ["vault", "json"] : action === "plan" ? ["vault", "output", "json"] : action === "apply" ? ["vault", "plan", "backup", "runtimes-prepared", "json"] : action === "source" ? ["output", "json"] : ["json"];
  if (Object.keys(values).some((key) => !allowed.includes(key)) || !["plan", "apply", "retire", "sources", "source", "task-v3"].includes(action ?? "")
    || positionals.length !== (action === "source" ? 2 : 1)
    || (["plan", "apply", "retire"].includes(action!) && !values.vault)
    || (action === "apply" && (!values.plan || !values.backup || !values["runtimes-prepared"]))
    || (action === "source" && (!id || !values.output))) throw new HubError("INVALID", { key: "migrate.usage_migrate_retire_vault_directory_migrate_plan_vault_directory_ou", args: [] });
  const state = options.stateDir ?? stateDirectory(); let lease: Awaited<ReturnType<typeof acquireStateLease>> | undefined, db: Database | undefined;
  try {
    if (action === "task-v3") {
      lease = await acquireStateLease(state);
      const store = await HubStore.open(state);
      try { log(JSON.stringify(await migrateTaskModel(store.db, state, store.workActor().id))); } finally { store.close(); }
      return;
    }
    if (["apply", "retire"].includes(action!)) lease = await acquireStateLease(state);
    db = new Database(join(state, "hub.sqlite"), { readonly: !["apply", "retire"].includes(action!), strict: true });
    const migration = new LegacyMigration(db, values.vault ? resolve(values.vault) : "", { text: msg });
    if (action === "sources") { log(JSON.stringify(migration.sources())); return; }
    if (action === "source") {
      if (!/^(prj|task|rtn)_[0-9A-HJKMNP-TV-Z]{26}$/.test(id!)) throw new HubError("INVALID", { key: "migrate.invalid_source_id", args: [] });
      const source = migration.source(id!); await writeFile(resolve(values.output!), source.bytes, { flag: "wx", mode: 0o600 });
      log(JSON.stringify(source.entry)); return;
    }
    if (action === "plan") {
      const plan = await migration.plan();
      if (values.output) await writeFile(resolve(values.output), JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      log(JSON.stringify(plan)); return;
    }
    if (action === "retire") { await mkdir(join(state, "backups"), { recursive: true, mode: 0o700 }); log(JSON.stringify(await migration.retire(state, join(state, `backups/retire-${crypto.randomUUID()}`)))); return; }
    let input: unknown;
    try { input = JSON.parse(await readFile(values.plan!, "utf8")); } catch { throw new HubError("INVALID", { key: "migrate.could_not_read_migration_manifest", args: [] }); }
    log(JSON.stringify(MigrationPlan.parse(await migration.apply(input, resolve(values.backup!), values["runtimes-prepared"] === true))));
  } catch (cause) {
    if (cause instanceof HubError) throw cause;
    if (cause instanceof StorageError || cause instanceof WorkError || cause instanceof ExecutionError) throw new HubError(cause.code === "CORRUPT" ? "INVALID" : cause.code, cause.params);
    throw new HubError("INVALID", { key: "migrate.migration_did_not_complete_check_manifest_full_backup_state_director", args: [] });
  } finally { db?.close(); lease?.close(); }
}

import { text as msg } from "./messages.ts";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { migrationReceipt } from "@lumio/storage";
import { diagnosticIO, environment, localAddress, httpURL } from "./diagnostics.ts";
import { parseArgs } from "node:util";
import { upgrade as sharedUpgrade, UpgradeError, type UpgradeOptions } from "@lumio/platform";
export { UpgradeError } from "@lumio/platform";
export type { UpgradeOptions } from "@lumio/platform";

export async function upgrade(options: UpgradeOptions = {}): Promise<void> {
  await sharedUpgrade({ ...options, text: options.text ?? msg, tty: options.tty ?? process.stderr.isTTY, columns: options.columns ?? (() => process.stderr.columns), progress: options.progress ?? ((line) => { process.stderr.write(line); }), log: options.log ?? console.log });
  await legacyUpgradeHint(options);
}
export async function runUpgrade(args: string[], runtimeOnly: boolean, log = console.log): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { version: { type: "string" } } });
  if (positionals.length) throw new UpgradeError({ key: "upgrade.usage_upgrade_version_vx_y_z", args: [runtimeOnly ? "lumio-runtime" : "lumio"] });
  await upgrade({ version: values.version, runtimeOnly, log }); return 0;
}

/** Read-only local diagnosis after upgrade; never reads or writes knowledge files. */
export async function legacyUpgradeHint(options: UpgradeOptions = {}): Promise<void> {
  if (options.runtimeOnly) return;
  const io = diagnosticIO(options); let db: Database | undefined;
  try {
    const config = JSON.parse(await io.read(join(io.home, ".config/lumio/config.json"))) as { hub_url?: string };
    const url = io.env.LUMIO_HUB_URL ?? config.hub_url;
    if (!url || !localAddress(httpURL(url))) return;
    let env: Record<string, string> = {};
    try { env = environment(await io.read(join(io.home, ".config/lumio/hub.env"))); } catch { /* default state */ }
    const path = join(io.env.LUMIO_STATE_DIR ?? env.LUMIO_STATE_DIR ?? join(io.home, ".local/share/lumio"), "hub.sqlite");
    db = new Database(path, { readonly: true, strict: true });
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name='work_tasks' AND type='table'").get() || migrationReceipt(db)) return;
    (options.log ?? console.log)(msg("upgrade.hub_is_using_v2_with_legacy_notes_to_retire_without_importing_tasks"));
  } catch { /* optional diagnosis must not turn a successful upgrade into a failure */ }
  finally { db?.close(); }
}

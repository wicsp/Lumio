import { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MigrationPlan, idOf } from "@lumio/schema";
import { LegacyMigration, acquireStateLease, StorageError } from "@lumio/storage";
import { WorkError } from "@lumio/work";
import { ExecutionError } from "@lumio/execution";
import { stateDirectory } from "./config.ts";
import { HubError } from "./errors.ts";

export async function runMigration(args: string[], log: (line: string) => void): Promise<void> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    vault: { type: "string" }, output: { type: "string" }, plan: { type: "string" }, backup: { type: "string" },
    "runtimes-prepared": { type: "boolean" }, json: { type: "boolean" },
  } });
  const [action, id] = positionals, allowed = action === "plan" ? ["vault", "output", "json"] : action === "apply" ? ["vault", "plan", "backup", "runtimes-prepared", "json"] : action === "source" ? ["output", "json"] : ["json"];
  if (Object.keys(values).some((key) => !allowed.includes(key)) || !["plan", "apply", "sources", "source"].includes(action ?? "")
    || positionals.length !== (action === "source" ? 2 : 1)
    || (["plan", "apply"].includes(action!) && !values.vault)
    || (action === "apply" && (!values.plan || !values.backup || !values["runtimes-prepared"]))
    || (action === "source" && (!id || !values.output))) throw new HubError("INVALID", "用法：migrate plan --vault <目录> [--output 新清单文件]；migrate apply --vault <目录> --plan <清单> --backup <完整备份目录> --runtimes-prepared；migrate sources；migrate source <ID> --output <新文件>");
  const state = stateDirectory(); let lease: Awaited<ReturnType<typeof acquireStateLease>> | undefined, db: Database | undefined;
  try {
    if (action === "apply") lease = await acquireStateLease(state);
    db = new Database(join(state, "hub.sqlite"), { readonly: action !== "apply", strict: true });
    const migration = new LegacyMigration(db, values.vault ? resolve(values.vault) : "");
    if (action === "sources") { log(JSON.stringify(migration.sources())); return; }
    if (action === "source") {
      if (!/^(prj|task|rtn)_[0-9A-HJKMNP-TV-Z]{26}$/.test(id!)) throw new HubError("INVALID", "来源 ID 不合法");
      const source = migration.source(id!); await writeFile(resolve(values.output!), source.bytes, { flag: "wx", mode: 0o600 });
      log(JSON.stringify(source.entry)); return;
    }
    if (action === "plan") {
      const plan = await migration.plan();
      if (values.output) await writeFile(resolve(values.output), JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      log(JSON.stringify(plan)); return;
    }
    let input: unknown;
    try { input = JSON.parse(await readFile(values.plan!, "utf8")); } catch { throw new HubError("INVALID", "无法读取迁移清单"); }
    log(JSON.stringify(MigrationPlan.parse(await migration.apply(input, resolve(values.backup!), values["runtimes-prepared"] === true))));
  } catch (cause) {
    if (cause instanceof HubError) throw cause;
    if (cause instanceof StorageError || cause instanceof WorkError || cause instanceof ExecutionError) throw new HubError(cause.code === "CORRUPT" ? "INVALID" : cause.code, cause.message);
    throw new HubError("INVALID", "迁移未完成，请检查清单、完整备份、状态目录权限和新输出文件路径");
  } finally { db?.close(); lease?.close(); }
}

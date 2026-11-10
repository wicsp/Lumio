import {runNativeMCP} from "./native/mcp.ts";
import { withLanguage, errorMessage, text as msg } from "./messages.ts";
import { parseArgs } from "node:util";
import { doctor } from "./doctor.ts";
import { printChecks } from "./diagnostics.ts";
import { runUpgrade } from "./upgrade.ts";
import { PairingError } from "./pairing-feedback.ts";
import { joinRuntime } from "./pairing.ts";
import { configureSudoEnvironment, installSudoHelper } from "./sudo-install.ts";
import { installService, runtimeEnvironment } from "./service.ts";
import { version } from "./version.ts";
import { runSudo } from "./sudo.ts";
import { runSudoHelper } from "./sudo-helper.ts";
import { readConfig, RuntimeError } from "./config.ts";
import { runRuntime } from "./runtime.ts";
import { runWorker } from "./worker.ts";
import { prepareMigration } from "./prepare-migration.ts";
import { StorageError } from "@lumio/storage";
import { sampleClaudeFromStdin } from "./claude-usage.ts";

export async function run(args: string[]): Promise<void> {
  if(args[0]==="native-mcp"){await runNativeMCP();return;}
  if (args[0] === "claude-usage-sample") {
    try { await sampleClaudeFromStdin(args.slice(1)); }
    catch { console.error(msg("entry.claude_usage_sample_failed")); process.exitCode = 1; }
    return;
  }

  if (args.length === 1 && args[0] === "--version") {
    console.log(version);
  } else if (args[0] === "prepare-migration") {
    try {
      const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { "state-dir": { type: "string" } } });
      if (positionals.length || !values["state-dir"]) throw new RuntimeError(msg("entry.usage_lumio_runtime_prepare_migration_state_dir_runtime_state_direct"));
      await prepareMigration(values["state-dir"]); console.log(msg("entry.migration_preparation_complete_legacy_plan_cache_cleared_history_and"));
    } catch (cause) { console.error(cause instanceof RuntimeError || cause instanceof StorageError ? errorMessage(cause) : msg("entry.runtime_migration_preparation_failed")); process.exitCode = 1; }
  } else if (args[0] === "doctor" || args[0] === "upgrade") {
    try {
      if (args[0] === "upgrade") process.exitCode = await runUpgrade(args.slice(1), true);
      else {
        const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { json: { type: "boolean" } } });
        if (positionals.length) throw new RuntimeError(msg("entry.usage_lumio_runtime_doctor_json"));
        process.exitCode = printChecks(await doctor(), Boolean(values.json), console.log);
      }
    } catch (cause) { console.error(cause instanceof Error ? errorMessage(cause) : msg("entry.runtime_check_or_upgrade_failed")); process.exitCode = 1; }
  } else if (args[0] === "join" || args[0] === "install-sudo-helper") {
    try {
      if (args[0] === "join") await joinRuntime(args.slice(1));
      else await installSudoHelper(args.slice(1));
    } catch (cause) { console.error((cause instanceof RuntimeError || cause instanceof PairingError) ? errorMessage(cause) : msg("entry.runtime_installation_failed_check_configuration_and_permissions")); process.exitCode = 1; }
  } else if (args[0] === "--configure-sudo-helper") {
    try {
      if (process.getuid?.() === 0 || !process.env.HOME || args.length > 2) throw new RuntimeError(msg("entry.update_configuration_through_the_privileged_helper_installation_comm"));
      await configureSudoEnvironment(process.env.HOME, args[1]);
    } catch { console.error(msg("entry.could_not_update_runtime_privileged_configuration")); process.exitCode = 1; }
  } else if (args[0] === "install-service") {
    try { await installService(); }
    catch (cause) { console.error(cause instanceof RuntimeError ? errorMessage(cause) : msg("entry.runtime_service_installation_failed_check_runtime_env_and_service_lo")); process.exitCode = 1; }
  } else if (args[0] === "--job-worker") {
    await withLanguage("en", () => runWorker());
  } else if (args[0] === "--sudo-helper") {
    process.exitCode = await withLanguage("en", () => runSudoHelper());
  } else if (args[0] === "sudo") {
    process.exitCode = await runSudo(args.slice(1));
  } else if (args.length && !(args.length === 1 && args[0] === "serve")) {
    console.error(msg("entry.unknown_runtime_command"));
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    const shutdown = () => controller.abort();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    try {
      const env = await withLanguage("en", () => runtimeEnvironment());
      await withLanguage("en", () => runRuntime(readConfig(env), { signal: controller.signal, env }));
    }
    catch (cause) {
      // Never print fetch exceptions, environment values or agent output.
      withLanguage("en", () => console.error(cause instanceof RuntimeError || cause instanceof StorageError ? errorMessage(cause) : msg("entry.runtime_could_not_start_check_configuration_and_state_directory_perm")));
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
    }
  }

}

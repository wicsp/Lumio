#!/usr/bin/env bun
import { printHelp } from "./help.ts";
import { en, errorMessage, text as msg } from "./messages.ts";
import { basename } from "node:path";
import { runUpgrade } from "./upgrade.ts";
import { runCli } from "./cli.ts";
import { run as runHub } from "../../hub/src/entry.ts";
import { run as runRuntime } from "../../runtime/src/entry.ts";
import { buildWebAssets, webFiles, WEB_CSP, type WebAssets } from "../../web/src/entry.ts";

export function invocation(args: string[], name: string): { role: "cli" | "hub" | "runtime"; args: string[] } {
  if (name === "lumio-hub") return { role: "hub", args };
  if (name === "lumio-runtime") return { role: "runtime", args };
  // Internal subprocesses use the same executable, including the separately installed sudo helper.
  if (["--job-worker", "--sudo-helper", "--configure-sudo-helper"].includes(args[0] ?? "")) return { role: "runtime", args };
  if (args[0] === "hub" && args[1] !== "status") return { role: "hub", args: args.slice(1) };
  if (args[0] === "runtime" && !["add", "list", "remove"].includes(args[1] ?? "")) return { role: "runtime", args: args.slice(1) };
  return { role: "cli", args };
}

export async function main(assets?: WebAssets, args = process.argv.slice(2), name = basename(process.argv0)): Promise<void> {
  const helpArgs = name === "lumio-hub" ? ["hub", ...args] : name === "lumio-runtime" ? ["runtime", ...args] : args;
  if (printHelp(helpArgs, console.log)) return;
  const call = invocation(args, name);
  try {
    if (call.role === "hub") {
      const serving = !call.args.length || (call.args.length === 1 && call.args[0] === "serve");
      await runHub(call.args, serving ? { web: { files: webFiles(assets ?? await buildWebAssets(), { apiBase: "" }), csp: WEB_CSP } } : {});
    } else if (call.role === "runtime" && call.args[0] === "upgrade") {
      // Both installed invocations share the CLI's terminal display and upgrade flow.
      process.exitCode = await runUpgrade(call.args.slice(1), true);
    } else if (call.role === "runtime") await runRuntime(call.args);
    else process.exitCode = await runCli(call.args);
  } catch (cause) {
    // Never echo arguments or exceptions: management commands may be reading credentials.
    const serving = call.role !== "cli" && (!call.args.length || call.args[0] === "serve");
    console.error(serving ? en["main.could_not_execute_lumio_command_check_arguments_configuration_and_se"] : (call.role === "cli" || call.args[0] === "upgrade") && cause instanceof Error ? errorMessage(cause) : msg("main.could_not_execute_lumio_command_check_arguments_configuration_and_se")); process.exitCode = 1;
  }
}
if (import.meta.main) await main();

import { withLanguage, errorMessage, text as msg } from "./messages.ts";
import { language } from "@lumio/platform";
import { parseArgs } from "node:util";
import { setup } from "./setup.ts";
import { version } from "./version.ts";
import { runManagement } from "./cli.ts";
import { readConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { startHub } from "./server.ts";
import { StorageError } from "@lumio/storage";

export async function run(args: string[], options: Parameters<typeof startHub>[1] = {}): Promise<void> {
  try {
    if (args.length === 1 && args[0] === "--version") console.log(version);
    else if (args[0] === "setup") {
      const { values, positionals } = parseArgs({ args: args.slice(1), options: { vault: { type: "string" }, server: { type: "boolean" }, yes: { type: "boolean" }, "public-url": { type: "string" } } });
      if (positionals.length) throw new HubError("INVALID", { key: "entry.usage_lumio_hub_setup_vault_path_server_public_url_url_yes", args: [] });
      const { "public-url": publicUrl, ...rest } = values;
      await setup({ ...rest, ...(publicUrl !== undefined ? { publicUrl } : {}) });
    }
    else if (args.length && !(args.length === 1 && args[0] === "serve")) process.exitCode = await runManagement(args) ?? 0;
    else {
      const hub = await withLanguage("en", () => startHub(readConfig(), options));
      console.log(`Lumio Hub ${version}: http://${(hub.server.hostname ?? "127.0.0.1").includes(":") ? `[${hub.server.hostname}]` : hub.server.hostname}:${hub.server.port}`);
      const shutdown = () => { void hub.stop(); };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    }
  } catch (cause) {
    // Never echo argv, headers or database exceptions, which may contain credentials.
    const code = (cause as NodeJS.ErrnoException).code;
    withLanguage(!args.length || args[0] === "serve" ? "en" : language(), () => console.error(cause instanceof HubError || cause instanceof StorageError ? errorMessage(cause) : ["EPERM", "EACCES", "EADDRINUSE"].includes(code ?? "") ? msg("entry.hub_startup_failed", code) : msg("entry.hub_could_not_start_or_execute_command_check_arguments_lumio_vault_l")));
    process.exitCode = 1;
  }

}

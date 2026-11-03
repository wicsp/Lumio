import { text as msg } from "./messages.ts";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliConfig } from "@lumio/schema";

export const setupHint = () => msg("config.no_configuration_run_install_sh_or_lumio_hub_setup_first");

/** Read once per command; credentials are never included in diagnostics. */
export function readCliConfig(options: { env?: NodeJS.ProcessEnv; home?: string; warn?: (line: string) => void } = {}) {
  const env = options.env ?? process.env;
  const path = join(options.home ?? env.HOME ?? homedir(), ".config/lumio/config.json");
  let file: { hub_url: string; token?: string; vault?: string } | undefined;
  try {
    const mode = statSync(path).mode & 0o777;
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(msg("config.could_not_parse_cli_configuration_run_lumio_hub_setup_again")); }
    const parsed = CliConfig.partial({ token: true }).safeParse(value);
    if (!parsed.success) throw new Error(msg("config.invalid_cli_configuration_format_run_lumio_hub_setup_again"));
    file = parsed.data;
    if (mode !== 0o600) (options.warn ?? console.error)(msg("config.configuration_file_permissions_are_not_0600_run_chmod_600", path.replaceAll("'", "'\\''")));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  return { url: env.LUMIO_HUB_URL ?? file?.hub_url, token: env.LUMIO_TOKEN ?? file?.token, vault: env.LUMIO_VAULT ?? file?.vault };
}

export function hubCredentials(config: { url?: string; token?: string } = readCliConfig()) {
  if (!config.url || !config.token) throw new Error(setupHint());
  return { url: config.url, token: config.token };
}

export function localVault(explicit?: string, config: { vault?: string } = readCliConfig()): string {
  const vault = explicit ?? config.vault;
  if (!vault) throw new Error(setupHint());
  return vault;
}

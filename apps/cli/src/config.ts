import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliConfig } from "@lumio/schema";

export const setupHint = "还没有配置，请先运行 install.sh 或 lumio-hub setup";

/** Read once per command; credentials are never included in diagnostics. */
export function readCliConfig(options: { env?: NodeJS.ProcessEnv; home?: string; warn?: (line: string) => void } = {}) {
  const env = options.env ?? process.env;
  const path = join(options.home ?? env.HOME ?? homedir(), ".config/lumio/config.json");
  let file: CliConfig | undefined;
  try {
    const mode = statSync(path).mode & 0o777;
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("CLI 配置无法解析，请重新运行 lumio-hub setup"); }
    const parsed = CliConfig.safeParse(value);
    if (!parsed.success) throw new Error("CLI 配置格式不合法，请重新运行 lumio-hub setup");
    file = parsed.data;
    if (mode !== 0o600) (options.warn ?? console.error)(`配置文件权限不是 0600，请运行 chmod 600 '${path.replaceAll("'", "'\\''")}'`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  return { url: env.LUMIO_HUB_URL ?? file?.hub_url, token: env.LUMIO_TOKEN ?? file?.token, vault: env.LUMIO_VAULT ?? file?.vault };
}

export function hubCredentials(config: { url?: string; token?: string } = readCliConfig()) {
  if (!config.url || !config.token) throw new Error(setupHint);
  return { url: config.url, token: config.token };
}

export function localVault(explicit?: string, config: { vault?: string } = readCliConfig()): string {
  const vault = explicit ?? config.vault;
  if (!vault) throw new Error(setupHint);
  return vault;
}

import { language } from "@lumio/platform";
import { text as msg } from "./messages.ts";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@lumio/api-client";
import { askTerminal, openTerminal } from "@lumio/platform";
import { pair, PairingError } from "./pairing-feedback.ts";
import { CliConfig, ClientJoin, ClientJoinRequest } from "@lumio/schema";
import { hubCredentials, readCliConfig } from "./config.ts";

async function confirmOverwrite(): Promise<boolean> {
  const terminal = openTerminal();
  if (!terminal) throw new Error(msg("pairing.cli_configuration_exists_confirm_overwrite_in_an_interactive_termina"));
  return (askTerminal(terminal, msg("pairing.cli_configuration_exists_overwrite_type_yes")) ?? "").trim() === "yes";
}
async function writeConfig(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await chmod(temp, 0o600); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export async function runPairing(args: string[], options: {
  home?: string; log?: (line: string) => void; warn?: (line: string) => void; confirm?: () => Promise<boolean>;
  fetch?: typeof globalThis.fetch;
} = {}): Promise<number> {
  const parse = () => parseArgs({ args, allowPositionals: true, options: {
    name: { type: "string" }, code: { type: "string" }, vault: { type: "string" }, json: { type: "boolean" },
  } });
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(); } catch { throw new Error(msg("pairing.invalid_pairing_arguments_check_command_hub_url_and_required_options")); }
  const { positionals, values } = parsed;
  const [command, action, name] = positionals;
  const home = options.home ?? process.env.HOME ?? homedir(), log = options.log ?? console.log;
  const path = join(home, ".config/lumio/config.json");
  if (command === "login") {
    if (positionals.length !== 2 || !action || !values.code || Object.keys(values).some((k) => !["code", "vault"].includes(k))) throw new Error(msg("pairing.usage_lumio_login_hub_url_code_pairing_code_vault_local_vault_path"));
    let url: URL;
    try { url = new URL(action); } catch { throw new Error(msg("pairing.hub_url_must_be_http_s")); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(msg("pairing.hub_url_must_be_http_s_without_credentials_query_or_fragment"));
    let exists = false;
    try { await readFile(path); exists = true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    if (exists && !await (options.confirm ?? confirmOverwrite)()) { log(msg("pairing.login_cancelled")); return 0; }
    if (url.protocol === "http:" && !/^(localhost|\[::1\]|127\.\d+\.\d+\.\d+)$/.test(url.hostname)) (options.warn ?? console.error)(msg("pairing.warning_hub_uses_http_tokens_will_travel_in_plain_text"));
    const hub_url = url.href.replace(/\/+$/, "");
    const request = ClientJoinRequest.safeParse({ code: values.code });
    if (!request.success) throw new PairingError({ key: "pairing.invalid_pairing_code_format_run_lumio_login_code_again", args: [] });
    const joined = await pair(hub_url, request.data.code, "client", ClientJoin, options.fetch, options.warn);
    await writeConfig(path, CliConfig.parse({ hub_url, token: joined.token, ...(values.vault ? { vault: resolve(values.vault) } : {}) }));
    log(msg("pairing.cli_logged_in")); return 0;
  }
  if (command === "logout") {
    if (positionals.length !== 1 || Object.keys(values).length) throw new Error(msg("pairing.usage_lumio_logout"));
    try {
      const config = CliConfig.partial({ token: true }).parse(JSON.parse(await readFile(path, "utf8")));
      delete config.token; await writeConfig(path, config);
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(msg("pairing.could_not_read_cli_configuration_check_configuration_file")); }
    log(msg("pairing.token_removed_from_cli_configuration")); return 0;
  }
  if (command === "login-code") {
    if (positionals.length !== 1 || Object.keys(values).some((k) => k !== "name")) throw new Error(msg("pairing.usage_lumio_login_code_name_cli_hostname"));
    const client = createClient({ language: language(), ...hubCredentials(readCliConfig({ home, warn: options.warn })), fetch: options.fetch });
    log((await client.clientInvite(values.name ?? `cli@${hostname().toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 60)}`)).command); return 0;
  }
  if (command === "runtime" && ["add", "remove"].includes(action ?? "")) {
    if (positionals.length !== 3 || !name || Object.keys(values).some((k) => k !== "json")) throw new Error(msg("pairing.usage_lumio_runtime_add_remove_name_json"));
    const client = createClient({ language: language(), ...hubCredentials(readCliConfig({ home, warn: options.warn })), fetch: options.fetch });
    if (action === "remove") { await client.removeRuntime(name); log(values.json ? "null" : msg("pairing.all_runtime_tokens_revoked")); }
    else {
      const invite = await client.runtimeInvite(name);
      if (values.json) log(JSON.stringify(invite));
      else { log(msg("pairing.run_on_that_machine_valid_for_10_minutes_one_use_only")); log(invite.command); }
    }
    return 0;
  }
  throw new Error(msg("pairing.unknown_pairing_command"));
}

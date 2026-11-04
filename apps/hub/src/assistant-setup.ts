import { text as msg } from "./messages.ts";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { askTerminal, openTerminal } from "@lumio/platform";
import { modelConfiguration } from "./assistant-model.ts";
import { AssistantConfiguration } from "./assistant-config.ts";
import { AssistantConfigView, AssistantConfigUpdate, ApiError, CliConfig } from "@lumio/schema";
import { HubError } from "./errors.ts";
import { optional, runCommand } from "./setup.ts";

/** Always restore the terminal mode, including on EOF or input errors. */
export function hiddenKey(): string {
  const terminal = openTerminal();
  if (!terminal) throw new HubError("INVALID", { key: "assistant-setup.no_interactive_terminal_use_api_key_stdin_to_read_the_key_from_stand", args: [] });
  const fd = openSync(terminal.path, "r+");
  let mode: string | undefined;
  try {
    const saved = Bun.spawnSync(["stty", "-g"], { stdin: fd, stdout: "pipe", stderr: "ignore" });
    if (saved.exitCode) throw new Error();
    mode = saved.stdout.toString().trim();
    if (Bun.spawnSync(["stty", "-echo"], { stdin: fd, stderr: "ignore" }).exitCode) throw new Error();
    return askTerminal(terminal, msg("assistant-setup.api_key_hidden_leave_empty_if_not_required")) ?? "";
  } catch { throw new HubError("INVALID", { key: "assistant-setup.could_not_read_the_key_securely_use_api_key_stdin", args: [] }); }
  finally {
    if (mode) Bun.spawnSync(["stty", mode], { stdin: fd, stderr: "ignore" });
    closeSync(fd); process.stderr.write("\n");
  }
}
export interface AssistantSetupOptions {
  home?: string; platform?: string; uid?: number; log?: (line: string) => void;
  run?: typeof runCommand; fetch?: typeof fetch; timeoutMs?: number;
  ask?: (question: string) => Promise<string>; key?: () => Promise<string>; stdin?: () => Promise<string>;
}

export async function assistantConfiguration(args: string[], options: AssistantSetupOptions = {}): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "base-url": { type: "string" }, model: { type: "string" }, "api-key-stdin": { type: "boolean" }, "skip-check": { type: "boolean" },
  } });
  const action = positionals[0];
  if (positionals.length !== 1 || !["setup", "status", "clear"].includes(action ?? "") || (action !== "setup" && Object.keys(values).length)) {
    throw new HubError("INVALID", { key: "assistant-setup.usage_lumio_hub_assistant_setup_base_url_url_model_name_api_key_stdi", args: [] });
  }
  const log = options.log ?? console.log, home = options.home ?? process.env.HOME ?? homedir();
  const configuration = new AssistantConfiguration({ home, external: options.home ? undefined : modelConfiguration(process.env), fetch: options.fetch, timeoutMs: options.timeoutMs });
  const cliText = await optional(join(home, ".config/lumio/config.json"));
  const cli = cliText ? CliConfig.parse(JSON.parse(cliText)) : undefined;
  const remote = async (method: string, body?: unknown) => {
    let response: Response;
    try { response = await (options.fetch ?? fetch)(`${cli!.hub_url.replace(/\/+$/, "")}/v2/assistant/config`, {
      method, redirect: "error", headers: { Authorization: `Bearer ${cli!.token}`, "Content-Type": "application/json", "Accept-Language": msg("assistant.config.language") },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }); } catch { throw new HubError("INVALID", { key: "assistant.config.unreachable", args: [] }); }
    const result = await response.json();
    if (!response.ok) {
      const error = ApiError.safeParse(result);
      const reason = error.success ? error.data.error.reason : undefined;
      const problem = /^assistant-config-(address|auth|model|response|timeout)$/.exec(reason ?? "")?.[1];
      throw new HubError(error.success ? error.data.error.code : "INVALID", { key: problem ? `assistant.config.${problem}` : reason === "assistant-config-managed-externally" ? "assistant.config.external" : "assistant.config.remote_failed", args: [] }, { reason });
    }
    return AssistantConfigView.parse(result);
  };
  if (!cli) await configuration.load();
  if (action === "status") {
    const view = cli ? await remote("GET") : configuration.view();
    log(msg("assistant-setup.url_model_key", view.base_url ?? msg("setup.not_set"), view.model ?? msg("setup.not_set"), view.api_key_set ? msg("assistant-setup.set") : msg("setup.not_set"))); return;
  }
  if (action === "clear") {
    if (cli) await remote("DELETE"); else await configuration.clear();
  } else {
    const terminal = options.ask ? undefined : openTerminal();
    const ask = options.ask ?? (async (question: string) => {
      if (!terminal) throw new HubError("INVALID", { key: "assistant-setup.non_interactive_mode_requires_base_url_model_and_api_key_stdin", args: [] });
      return askTerminal(terminal, question) ?? "";
    });
    if (!values["api-key-stdin"] && !options.key && !terminal && !options.ask) throw new HubError("INVALID", { key: "assistant-setup.non_interactive_mode_requires_api_key_stdin", args: [] });
    const base = values["base-url"] ?? await ask(msg("assistant-setup.api_url_e_g_https_api_openai_com_v1_or_http_127_0_0_1_8080_v1"));
    const model = values.model ?? await ask(msg("assistant-setup.model_name"));
    const key = values["api-key-stdin"] ? await (options.stdin ?? (() => Bun.stdin.text()))() : await (options.key ?? (async () => hiddenKey()))();
    const input = { base_url: base.trim(), model: model.trim(), api_key: key.replace(/\r?\n$/, "") || undefined,
      clear_api_key: !key.replace(/\r?\n$/, ""), check: !values["skip-check"] };
    if (!AssistantConfigUpdate.safeParse(input).success) throw new HubError("INVALID", { key: "assistant.config.address", args: [] }, { reason: "assistant-config-address" });
    if (cli) await remote("PUT", input); else await configuration.update(input);
  }
  log(msg("assistant.config.saved"));
}

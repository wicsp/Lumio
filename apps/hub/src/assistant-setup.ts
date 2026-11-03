import { text as msg } from "./messages.ts";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { askTerminal, openTerminal } from "@lumio/platform";
import { modelConfiguration } from "./assistant-model.ts";
import { HubError } from "./errors.ts";
import { atomicFile, environmentText, optional, parseEnvironment, runCommand, xml } from "./setup.ts";

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

export async function restartHubEnvironment(env: Record<string, string>, options: AssistantSetupOptions): Promise<void> {
  const home = options.home ?? process.env.HOME ?? homedir(), platform = options.platform ?? process.platform;
  const log = options.log ?? console.log, run = options.run ?? runCommand;
  const path = join(home, platform === "darwin" ? "Library/LaunchAgents/io.lumio.hub.plist" : ".config/systemd/user/lumio-hub.service");
  const service = await optional(path);
  if (!service || !["darwin", "linux"].includes(platform)) { log(msg("assistant-setup.configuration_saved_this_environment_is_unmanaged_restart_hub_manual")); return; }
  if (platform === "darwin") {
    const pattern = /(<key>EnvironmentVariables<\/key>\s*<dict>)[\s\S]*?(<\/dict>)/;
    if (!pattern.test(service)) throw new HubError("INVALID", { key: "assistant-setup.could_not_update_hub_service_file_run_setup_again", args: [] });
    const entries = Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("");
    await atomicFile(path, service.replace(pattern, (_all, start, end) => `${start}${entries}${end}`), 0o600);
    if ((await run(["plutil", "-lint", path])).code) throw new HubError("INVALID", { key: "assistant-setup.hub_service_file_validation_failed_configuration_saved_run_setup_aga", args: [] });
    const domain = `gui/${options.uid ?? process.getuid?.() ?? -1}`;
    await run(["launchctl", "bootout", domain, path]);
    if ((await run(["launchctl", "bootstrap", domain, path])).code) throw new HubError("INVALID", { key: "assistant-setup.configuration_saved_but_hub_restart_failed_run_setup_again", args: [] });
  } else if ((await run(["systemctl", "--user", "restart", "lumio-hub.service"])).code) {
    throw new HubError("INVALID", { key: "assistant-setup.configuration_saved_but_hub_restart_failed_restart_lumio_hub_service", args: [] });
  }
  log(msg("assistant-setup.hub_restarted"));
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
  const path = join(home, ".config/lumio/hub.env"), env = parseEnvironment(await optional(path) ?? "");
  if (action === "status") {
    const key = env.LUMIO_ASSISTANT_API_KEY;
    const safe = (text: string) => key ? text.replaceAll(key, msg("assistant-setup.hidden")) : text;
    log(msg("assistant-setup.url_model_key", safe(env.LUMIO_ASSISTANT_BASE_URL ?? msg("setup.not_set")), safe(env.LUMIO_ASSISTANT_MODEL ?? msg("setup.not_set")), key ? msg("assistant-setup.set") : msg("setup.not_set"))); return;
  }
  if (action === "clear") {
    for (const key of ["LUMIO_ASSISTANT_BASE_URL", "LUMIO_ASSISTANT_MODEL", "LUMIO_ASSISTANT_API_KEY"]) delete env[key];
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
    const candidate = { LUMIO_ASSISTANT_BASE_URL: base.trim(), LUMIO_ASSISTANT_MODEL: model.trim(), LUMIO_ASSISTANT_API_KEY: key.replace(/\r?\n$/, "") };
    if (Object.values(candidate).some(value => /[\r\n\0]/.test(value))) throw new HubError("INVALID", { key: "assistant-setup.assistant_configuration_must_not_contain_newlines_or_nul", args: [] });
    let config;
    try { config = modelConfiguration(candidate); } catch { throw new HubError("INVALID", { key: "assistant-setup.check_the_model_name_and_api_url_the_url_must_be_http_s_without_cred", args: [] }); }
    if (!config) throw new HubError("INVALID", { key: "assistant-setup.enter_the_api_url_and_model_name", args: [] });
    if (!values["skip-check"]) {
      const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      let response: Response | undefined;
      try {
        response = await (options.fetch ?? fetch)(`${config.baseUrl}/chat/completions`, { method: "POST", redirect: "error", signal,
          headers: { "Content-Type": "application/json", ...(config.credential() ? { Authorization: `Bearer ${config.credential()}` } : {}) },
          body: JSON.stringify({ model: config.model, stream: false, messages: [{ role: "user", content: "ping" }] }),
        });
        if (!response.ok) throw new HubError("INVALID", response.status === 401 || response.status === 403 ? { key: "assistant-setup.authentication_failed_401_403_check_key_and_permissions", args: [] } : response.status === 404 ? { key: "assistant-setup.url_or_model_not_found_404_check_api_base_path_and_model_name", args: [] } : response.status >= 500 ? { key: "assistant-setup.model_service_error_5xx_retry_later", args: [] } : { key: "assistant-setup.model_service_rejected_the_request_4xx_check_url_and_model_name", args: [] });
        // A 2xx HTML/error page is not evidence of a working Chat Completions endpoint.
        const reader = response.body?.getReader();
        if (!reader) throw new HubError("INVALID", { key: "assistant-setup.empty_model_response_check_url_and_model_name", args: [] });
        let text = "";
        try {
          for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); if (text.length > 64 * 1024) throw new Error(); }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const body = JSON.parse(text);
        if (!Array.isArray(body?.choices) || !body.choices[0]?.message || body.choices[0].message.role !== "assistant") throw new HubError("INVALID", { key: "assistant-setup.invalid_model_response_format_check_url_and_model_name", args: [] });
      } catch (cause) {
        if (cause instanceof HubError) throw cause;
        throw new HubError("INVALID", signal.aborted ? { key: "assistant-setup.model_verification_timed_out_30_seconds_configuration_was_not_saved", args: [] } : { key: "assistant-setup.could_not_connect_to_model_service_or_response_is_invalid_check_netw", args: [] });
      } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
    }
    Object.assign(env, candidate, { LUMIO_ASSISTANT_BASE_URL: config.baseUrl });
  }
  await atomicFile(path, environmentText(env), 0o600, true);
  await restartHubEnvironment(env, options);
}

import { text as msg } from "./messages.ts";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { JOB_PROTOCOL_VERSION, RuntimeRegistration } from "@lumio/schema";

export class RuntimeError extends Error {
  readonly code = "INVALID";
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!env.LUMIO_HUB_URL || !env.LUMIO_TOKEN) throw new RuntimeError(msg("config.set_non_empty_lumio_hub_url_and_lumio_token"));
  let url: URL;
  try { url = new URL(env.LUMIO_HUB_URL); } catch { throw new RuntimeError(msg("cli.lumio_hub_url_must_be_an_http_s_url")); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RuntimeError(msg("config.lumio_hub_url_must_be_http_s_without_credentials_query_or_fragment"));
  }
  const registration = RuntimeRegistration.safeParse({
    protocol_version: JOB_PROTOCOL_VERSION, name: env.LUMIO_RUNTIME_NAME, engines: [],
    tags: env.LUMIO_RUNTIME_TAGS ? env.LUMIO_RUNTIME_TAGS.split(",").map((tag) => tag.trim()) : [],
    max_concurrent: Number(env.LUMIO_RUNTIME_MAX_CONCURRENT ?? 1),
  });
  if (!registration.success) throw new RuntimeError(msg("config.invalid_lumio_runtime_name_lumio_runtime_tags_or_lumio_runtime_max_c"));
  const pollSeconds = Number(env.LUMIO_RUNTIME_POLL_SECONDS ?? 5);
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0 || pollSeconds * 1000 > 2_147_483_647) {
    throw new RuntimeError(msg("config.lumio_runtime_poll_seconds_must_be_a_valid_positive_number_of_second"));
  }
  if (env.LUMIO_RUNTIME_STATE_DIR === "") throw new RuntimeError(msg("config.lumio_runtime_state_dir_must_not_be_empty"));
  const allowedCommands = env.LUMIO_RUNTIME_ALLOWED_COMMANDS ? env.LUMIO_RUNTIME_ALLOWED_COMMANDS.split(",").map((s) => s.trim()) : [];
  if (allowedCommands.some((s) => !isAbsolute(s))) throw new RuntimeError(msg("config.lumio_runtime_allowed_commands_must_be_comma_separated_absolute_path"));
  const sudoCommand = env.LUMIO_RUNTIME_SUDO_COMMAND?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (sudoCommand.length && !isAbsolute(sudoCommand[0]!)) throw new RuntimeError(msg("config.the_first_lumio_runtime_sudo_command_entry_must_be_an_absolute_path"));
  const sudoTimeout = Number(env.LUMIO_RUNTIME_SUDO_TIMEOUT ?? 1800);
  if (!Number.isFinite(sudoTimeout) || sudoTimeout <= 0 || sudoTimeout * 1000 > 2_147_483_647) throw new RuntimeError(msg("config.lumio_runtime_sudo_timeout_must_be_a_valid_positive_number_of_second"));
  return { sudoCommand, sudoTimeout, allowedCommands, url: url.href.replace(/\/+$/, ""), token: env.LUMIO_TOKEN, registration: registration.data, pollSeconds,
    stateDir: resolve(env.LUMIO_RUNTIME_STATE_DIR ?? join(homedir(), ".local", "share", "lumio-runtime")) };
}
export type RuntimeConfig = ReturnType<typeof readConfig>;

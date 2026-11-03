import { text as msg } from "./messages.ts";
import { browserOrigins } from "./web.ts";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { RuntimeName } from "@lumio/schema";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { modelConfiguration } from "./assistant-model.ts";
import { HubError } from "./errors.ts";

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.LUMIO_STATE_DIR ?? join(homedir(), ".local", "share", "lumio"));
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const listen = env.LUMIO_HUB_LISTEN ?? "127.0.0.1:7420";
  const match = /^(\[[^\]]+\]|[^:/\s]+):(\d+)$/.exec(listen);
  if (!match || Number(match[2]) > 65535) throw new HubError("INVALID", { key: "config.lumio_hub_listen_must_be_host_port", args: [] });
  const trustedProxy = env.LUMIO_TRUSTED_PROXY || undefined;
  if (trustedProxy && !isIP(trustedProxy)) throw new HubError("INVALID", { key: "config.lumio_trusted_proxy_must_be_an_ip_address", args: [] });
  const autosaveIdle = Number(env.LUMIO_AUTOSAVE_IDLE ?? 300);
  if (!Number.isFinite(autosaveIdle) || autosaveIdle <= 0 || autosaveIdle * 1000 > 2_147_483_647) {
    throw new HubError("INVALID", { key: "config.lumio_autosave_idle_must_be_a_valid_positive_number_of_seconds", args: [] });
  }
  let publicUrl: string | undefined;
  if (env.LUMIO_PUBLIC_URL) {
    try {
      const url = new URL(env.LUMIO_PUBLIC_URL);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      publicUrl = url.href.replace(/\/+$/, "");
    } catch { throw new HubError("INVALID", { key: "config.lumio_public_url_must_be_an_http_s_url_without_credentials_query_or", args: [] }); }
  }
  return {
    assistantModel: modelConfiguration(env),
    webOrigins: browserOrigins(env.LUMIO_WEB_ORIGINS),
    localRuntime: undefined as string | undefined,
    publicUrl,
    autosaveIdle,
    vault: env.LUMIO_VAULT ? resolve(env.LUMIO_VAULT) : "", stateDir: stateDirectory(env),
    hostname: match[1]!.replace(/^\[|\]$/g, ""), port: Number(match[2]), trustedProxy,
  };
}
export type HubConfig = ReturnType<typeof readConfig>;

export function isLoopback(host: string): boolean {
  host = host.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function networkWarning(config: Pick<HubConfig, "hostname" | "publicUrl">): string | undefined {
  if (!isLoopback(config.hostname) && (!config.publicUrl || config.publicUrl.startsWith("http://"))) {
    return msg("config.warning_hub_listens_on_a_non_local_address_without_an_https_public_u");
  }
}

/** 与 setup 共用名称规则；升级时把推导值保存进 Hub 配置。 */
export function runtimeName(host: string): string {
  return RuntimeName.parse(host.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 32) || "local");
}
export async function rememberLocalRuntime(stateDir: string, name?: string): Promise<string> {
  const path = join(stateDir, "config.json");
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(await readFile(path, "utf8")); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new HubError("INVALID", { key: "config.could_not_read_hub_configuration", args: [] }); }
  if (!config || Array.isArray(config) || typeof config !== "object") throw new HubError("INVALID", { key: "config.hub_configuration_must_be_an_object", args: [] });
  const localRuntime = RuntimeName.parse(name ?? config.localRuntime ?? runtimeName(hostname()));
  if (config.localRuntime !== localRuntime) {
    await mkdir(stateDir, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ ...config, localRuntime }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  return localRuntime;
}

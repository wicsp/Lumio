import { isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HubError } from "./errors.ts";

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.LUMIO_STATE_DIR ?? join(homedir(), ".local", "share", "lumio"));
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!env.LUMIO_VAULT) throw new HubError("INVALID", "请设置 LUMIO_VAULT");
  const listen = env.LUMIO_HUB_LISTEN ?? "127.0.0.1:7420";
  const match = /^(\[[^\]]+\]|[^:/\s]+):(\d+)$/.exec(listen);
  if (!match || Number(match[2]) > 65535) throw new HubError("INVALID", "LUMIO_HUB_LISTEN 必须是 host:port");
  const trustedProxy = env.LUMIO_TRUSTED_PROXY || undefined;
  if (trustedProxy && !isIP(trustedProxy)) throw new HubError("INVALID", "LUMIO_TRUSTED_PROXY 必须是 IP 地址");
  const autosaveIdle = Number(env.LUMIO_AUTOSAVE_IDLE ?? 300);
  if (!Number.isFinite(autosaveIdle) || autosaveIdle <= 0 || autosaveIdle * 1000 > 2_147_483_647) {
    throw new HubError("INVALID", "LUMIO_AUTOSAVE_IDLE 必须是有效的正秒数");
  }
  return {
    autosaveIdle,
    vault: resolve(env.LUMIO_VAULT), stateDir: stateDirectory(env),
    hostname: match[1]!.replace(/^\[|\]$/g, ""), port: Number(match[2]), trustedProxy,
  };
}
export type HubConfig = ReturnType<typeof readConfig>;

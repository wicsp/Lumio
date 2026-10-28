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
  let publicUrl: string | undefined;
  if (env.LUMIO_PUBLIC_URL) {
    try {
      const url = new URL(env.LUMIO_PUBLIC_URL);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      publicUrl = url.href.replace(/\/+$/, "");
    } catch { throw new HubError("INVALID", "LUMIO_PUBLIC_URL 必须是无凭据、查询或片段的 HTTP(S) 地址"); }
  }
  return {
    publicUrl,
    autosaveIdle,
    vault: resolve(env.LUMIO_VAULT), stateDir: stateDirectory(env),
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
    return "警告：Hub 正在非本机地址监听，且未配置 HTTPS 对外地址；令牌可能以明文传输。请配置反向代理与 LUMIO_PUBLIC_URL。";
  }
}

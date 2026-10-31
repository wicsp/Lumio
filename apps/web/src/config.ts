/**
 * Web 工作台的服务端配置（ADR 0026）。
 *
 * - LUMIO_WEB_LISTEN：监听地址，缺省 127.0.0.1:4317
 * - LUMIO_WEB_HUB_URL：固定的上游 Hub，缺省 http://127.0.0.1:7420；只能是 http(s) 源地址，不能带凭据、路径、查询或锚点
 * - LUMIO_WEB_ORIGINS：可选，逗号分隔的额外允许来源（例如放在反向代理后面时浏览器看到的地址）
 */

export interface WebConfig {
  hostname: string;
  port: number;
  /** 规范化后的 Hub 源地址，不带结尾斜杠。 */
  hubUrl: string;
  /** 额外允许的浏览器来源（Origin）；本机监听地址总是允许。 */
  allowedOrigins: string[];
}

export class WebConfigError extends Error {
  readonly code = "WEB_CONFIG";
  constructor(message: string) { super(message); this.name = "WebConfigError"; }
}

export const DEFAULT_LISTEN = "127.0.0.1:4317";
export const DEFAULT_HUB_URL = "http://127.0.0.1:7420";

export function parseListen(value: string): { hostname: string; port: number } {
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value.trim());
  const port = match ? Number(match[2]) : NaN;
  if (!match || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new WebConfigError(`LUMIO_WEB_LISTEN 应写成 主机:端口，例如 ${DEFAULT_LISTEN}`);
  }
  return { hostname: match[1]!.replace(/^\[|\]$/g, ""), port };
}

/** 只接受 http(s) 源地址：没有用户名/密码、路径、查询或锚点。 */
export function parseOrigin(value: string, name: string): string {
  const raw = value.trim();
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebConfigError(`${name} 不是合法的地址`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebConfigError(`${name} 只能使用 http:// 或 https://`);
  if (url.username || url.password) throw new WebConfigError(`${name} 不能包含用户名或密码`);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || /[?#]/.test(raw)) {
    throw new WebConfigError(`${name} 只能写协议、主机和端口，不能带路径、查询或锚点`);
  }
  return url.origin;
}

export function parseWebConfig(env: Record<string, string | undefined>): WebConfig {
  const { hostname, port } = parseListen(env.LUMIO_WEB_LISTEN || DEFAULT_LISTEN);
  const hubUrl = parseOrigin(env.LUMIO_WEB_HUB_URL || DEFAULT_HUB_URL, "LUMIO_WEB_HUB_URL");
  const allowedOrigins = (env.LUMIO_WEB_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean)
    .map((item) => parseOrigin(item, "LUMIO_WEB_ORIGINS"));
  return { hostname, port, hubUrl, allowedOrigins };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** 浏览器可以用来访问本服务的来源。监听回环地址时，127.0.0.1、localhost 与 [::1] 互相等价。 */
export function listenOrigins(hostname: string, port: number, extra: string[]): string[] {
  const hosts = LOOPBACK.has(hostname) ? ["127.0.0.1", "localhost", "[::1]"] : [hostname.includes(":") ? `[${hostname}]` : hostname];
  return [...new Set([...hosts.map((host) => `http://${host}:${port}`), ...extra])];
}

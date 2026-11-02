/**
 * Lumio Web 工作台服务（ADR 0026）：提供页面与同源 /hub 代理。服务本身不持有任何人的凭据。
 */
import { buildAssets, type WebAssets } from "./build.ts";
import { listenOrigins, type WebConfig } from "./config.ts";
import { version } from "./version.ts";
import { PROXY_PREFIX, SECURITY_HEADERS, checkRequestSource, createHubProxy, proxyError } from "./proxy.ts";

export interface StartWebOptions {
  /** 测试可传入预先构建的资源；缺省时启动时构建一次。 */
  assets?: WebAssets;
  fetch?: typeof globalThis.fetch;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
}

/** 品牌标记：石墨圆点里一盏灯。 */
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#1c2220"/><circle cx="16" cy="16" r="7" fill="#f2b705"/></svg>';

/**
 * 给 doctor 用的健康检查（ADR 0027）：Web 自己的版本，以及从服务端探测到的 Hub 状态。
 * 不经过 /hub 代理（代理只放行浏览器用户接口），也不转发任何凭据。
 */
async function health(hubUrl: string, fetcher: typeof fetch): Promise<Response> {
  let hub: { url: string; ok: boolean; version?: string; error?: string } = { url: hubUrl, ok: false };
  try {
    const response = await fetcher(`${hubUrl}/health`, { redirect: "error", signal: AbortSignal.timeout(3000) });
    const body = await response.json().catch(() => undefined) as { ok?: unknown; version?: unknown } | undefined;
    hub = response.ok && body?.ok === true
      ? { url: hubUrl, ok: true, ...(typeof body.version === "string" ? { version: body.version } : {}) }
      : { url: hubUrl, ok: false, error: `Hub 返回 HTTP ${response.status}` };
  } catch (cause) {
    hub = { url: hubUrl, ok: false, error: cause instanceof DOMException && cause.name === "TimeoutError" ? "连接 Hub 超时" : "连接不上 Hub" };
  }
  return new Response(JSON.stringify({ ok: hub.ok, version, hub }), {
    status: hub.ok ? 200 : 503,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export interface WebServer { url: string; port: number; stop(): Promise<void> }

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumio 工作台</title>
<meta name="lumio-hub" content="__LUMIO_HUB_ORIGIN__">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/app.js"></script>
</head>
<body>
<div id="app" class="app-root"><p class="boot">正在载入 Lumio 工作台…</p></div>
<noscript>Lumio 工作台需要启用 JavaScript。</noscript>
</body>
</html>`;

function asset(body: string, type: string): Response {
  return new Response(body, { headers: { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-cache" } });
}

export async function startWeb(config: WebConfig, options: StartWebOptions = {}): Promise<WebServer> {
  const assets = options.assets ?? await buildAssets();
  const stopped=new AbortController();
  let origins: string[] = [];
  let proxy: ((request: Request) => Promise<Response>) | undefined;
  const server = Bun.serve({
    hostname: config.hostname, port: config.port, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === PROXY_PREFIX || url.pathname.startsWith(`${PROXY_PREFIX}/`)) return proxy!(request);
      if (request.method !== "GET" && request.method !== "HEAD") return proxyError(405, "INVALID", "不支持这种请求方式");
      const rejected = checkRequestSource(request, origins);
      if (rejected) return rejected;
      if (url.pathname === "/favicon.svg") return asset(FAVICON, "image/svg+xml");
      if (url.pathname === "/health") return health(config.hubUrl, options.fetch ?? fetch);
      if (url.pathname === "/") return asset(PAGE.replace("__LUMIO_HUB_ORIGIN__", config.hubUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")), "text/html; charset=utf-8");
      if (url.pathname === "/assets/app.js") return asset(assets.js, "text/javascript; charset=utf-8");
      if (url.pathname === "/assets/app.css") return asset(assets.css, "text/css; charset=utf-8");
      return proxyError(404, "NOT_FOUND", "页面不存在");
    },
  });
  const port = server.port ?? config.port;
  origins = listenOrigins(config.hostname, port, config.allowedOrigins);
  proxy = createHubProxy({ hubUrl: config.hubUrl, allowedOrigins: origins, fetch: options.fetch,
    maxBodyBytes: options.maxBodyBytes, timeoutMs: options.upstreamTimeoutMs, signal:stopped.signal });
  return { url: origins[0]!, port, async stop() { stopped.abort();await server.stop(true); } };
}

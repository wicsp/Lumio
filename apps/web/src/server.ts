/**
 * Lumio Web 工作台服务（ADR 0026）：提供页面与同源 /hub 代理。服务本身不持有任何人的凭据。
 */
import { buildAssets, type WebAssets } from "./build.ts";
import { WebConfigError, listenOrigins, parseWebConfig, type WebConfig } from "./config.ts";
import { PROXY_PREFIX, SECURITY_HEADERS, checkRequestSource, createHubProxy, proxyError } from "./proxy.ts";

export interface StartWebOptions {
  /** 测试可传入预先构建的资源；缺省时启动时构建一次。 */
  assets?: WebAssets;
  fetch?: typeof globalThis.fetch;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
}

export interface WebServer { url: string; port: number; stop(): Promise<void> }

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumio 工作台</title>
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
      if(url.pathname==="/favicon.svg")return asset('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#7b6bdd"/><path d="M16 5v5m0 12v5M5 16h5m12 0h5M8 8l4 4m8 8 4 4M8 24l4-4m8-8 4-4M16 11l5 5-5 5-5-5z" stroke="white" stroke-width="1.7" fill="none"/></svg>',"image/svg+xml");
      if (url.pathname === "/") return asset(PAGE, "text/html; charset=utf-8");
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

if (import.meta.main) {
  try {
    const config = parseWebConfig(process.env);
    const web = await startWeb(config);
    console.log(`Lumio 工作台：${web.url}`);
    console.log(`Hub：${config.hubUrl}`);
  } catch (cause) {
    console.error(cause instanceof WebConfigError ? cause.message : cause instanceof Error ? cause.message : "工作台启动失败");
    process.exitCode = 1;
  }
}

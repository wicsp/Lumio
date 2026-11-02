/**
 * Lumio Web 工作台服务（ADR 0026）：提供页面与同源 /hub 代理。服务本身不持有任何人的凭据。
 */
import { buildAssets, type WebAssets } from "./build.ts";
import { WEB_CSP, webFiles, type WebFile } from "./page.ts";
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

function asset(file: WebFile): Response {
  return new Response(file.body, { headers: { ...SECURITY_HEADERS, "Content-Security-Policy": WEB_CSP, "Content-Type": file.type, "Cache-Control": "no-cache" } });
}

export async function startWeb(config: WebConfig, options: StartWebOptions = {}): Promise<WebServer> {
  const assets = options.assets ?? await buildAssets();
  const files = webFiles(assets, { apiBase: PROXY_PREFIX, hub: config.hubUrl });
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
      const file = files.get(url.pathname);
      if (file) return asset(file);
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

/**
 * Web 页面与静态文件（ADR 0026、0027）。同一份页面用于两种提供方式：
 * - Hub 直接提供（apiBase 为空）：浏览器与 Hub 同源，直接调用 /v1、/v2；
 * - 旧的独立 Web 服务（apiBase 为 "/hub"，并给出固定 Hub 来源）：经同源代理转发。R1-2 之后删除。
 */
import type { WebAssets } from "./build.ts";
import { ICON_SVG, iconPng } from "./icons.ts";
import { SERVICE_WORKER } from "./sw.ts";

export interface WebFile { body: string | Uint8Array; type: string }
export interface PageOptions {
  /** API 前缀：Hub 提供时为 ""；独立 Web 服务为 "/hub"。 */
  apiBase: string;
  /** 独立 Web 服务的固定上游 Hub 来源；Hub 提供时不设，浏览器用页面来源。 */
  hub?: string;
}

/** 页面与资源的 CSP：只允许同源脚本、样式、连接与 service worker；图片允许 data:（图标）；禁止被嵌入。 */
export const WEB_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const escapeAttr = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function renderPage(options: PageOptions): string {
  if (options.apiBase !== "" && !/^\/[a-z0-9-]+$/.test(options.apiBase)) throw new Error("apiBase 只能为空或 /<名称>");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Lumio</title>
<meta name="lumio-api-base" content="${escapeAttr(options.apiBase)}">
${options.hub ? `<meta name="lumio-hub" content="${escapeAttr(options.hub)}">\n` : ""}<meta name="theme-color" content="#f6f7f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#151917" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Lumio">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/app.js"></script>
</head>
<body>
<div id="app" class="app-root"><p class="boot">正在载入 Lumio…</p></div>
<noscript>Lumio 需要启用 JavaScript。</noscript>
</body>
</html>`;
}

export const MANIFEST = {
  name: "Lumio",
  short_name: "Lumio",
  description: "知识、任务与 agent 的个人工作台",
  lang: "zh-CN",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f6f7f5",
  theme_color: "#1c2220",
  icons: [
    { src: "/assets/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

/** 所有对外提供的文件：路径 → 内容与类型。图标在调用时生成一次。 */
export function webFiles(assets: WebAssets, options: PageOptions): Map<string, WebFile> {
  return new Map<string, WebFile>([
    ["/", { body: renderPage(options), type: "text/html; charset=utf-8" }],
    ["/assets/app.js", { body: assets.js, type: "text/javascript; charset=utf-8" }],
    ["/assets/app.css", { body: assets.css, type: "text/css; charset=utf-8" }],
    ["/sw.js", { body: SERVICE_WORKER, type: "text/javascript; charset=utf-8" }],
    ["/manifest.webmanifest", { body: JSON.stringify(MANIFEST), type: "application/manifest+json; charset=utf-8" }],
    ["/favicon.svg", { body: ICON_SVG, type: "image/svg+xml" }],
    ["/assets/icon.svg", { body: ICON_SVG, type: "image/svg+xml" }],
    ["/assets/icon-192.png", { body: iconPng(192), type: "image/png" }],
    ["/assets/icon-512.png", { body: iconPng(512), type: "image/png" }],
    ["/assets/apple-touch-icon.png", { body: iconPng(180), type: "image/png" }],
  ]);
}

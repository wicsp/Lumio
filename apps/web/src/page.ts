/**
 * Web 页面与静态文件（ADR 0026、0027）。同一份页面用于两种提供方式：
 * - Hub 直接提供（apiBase 为空）：浏览器与 Hub 同源，直接调用 /v1、/v2；
 * - 旧的独立 Web 服务（apiBase 为 "/hub"，并给出固定 Hub 来源）：经同源代理转发。R1-2 之后删除。
 */
import type { WebAssets } from "./build.ts";
import { createHash } from "node:crypto";
import { ICON_SVG, iconPng } from "./icons.ts";
import { SERVICE_WORKER } from "./sw.ts";
import { SPEECH_WORKLET } from "./speech-worklet.ts";

export interface WebFile { body: string | Uint8Array; type: string; immutable?: true }
export interface PageOptions {
  /** API 前缀：Hub 提供时为 ""；独立 Web 服务为 "/hub"。 */
  apiBase: string;
  /** 独立 Web 服务的固定上游 Hub 来源；Hub 提供时不设，浏览器用页面来源。 */
  hub?: string;
}

/** 页面与资源的 CSP：脚本、样式、字体、连接与 service worker 同源，图片也允许 data:，禁止被嵌入。 */
export const WEB_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const escapeAttr = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function renderPage(options: PageOptions, script = "/assets/app.js", stylesheet = "/assets/app.css", preloads: string[] = []): string {
  if (options.apiBase !== "" && !/^\/[a-z0-9-]+$/.test(options.apiBase)) throw new Error("apiBase 只能为空或 /<名称>");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>Lumio</title>
<meta name="lumio-api-base" content="${escapeAttr(options.apiBase)}">
${options.hub ? `<meta name="lumio-hub" content="${escapeAttr(options.hub)}">\n` : ""}<meta name="theme-color" content="#f5f5f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#181818" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Lumio">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="stylesheet" href="${escapeAttr(stylesheet)}">
${preloads.map(name => `<link rel="modulepreload" href="/assets/${escapeAttr(name)}">`).join("\n")}
<script type="module" src="${escapeAttr(script)}"></script>
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
  background_color: "#f5f5f5",
  theme_color: "#1c2220",
  // 从其他 App 分享链接或文字到 Lumio，进入 Inbox（ADR 0057，I1-5）。支持 Web Share Target 的系统才会出现在分享菜单里。
  share_target: { action: "/", method: "GET", params: { title: "title", text: "text", url: "url" } },
  icons: [
    { src: "/assets/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

/** 所有对外提供的文件：路径 → 内容与类型。图标在调用时生成一次。 */
export function webFiles(assets: WebAssets, options: PageOptions): Map<string, WebFile> {
  const fingerprint = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);
  const script = `/assets/app-${fingerprint(assets.js)}.js`, stylesheet = `/assets/app-${fingerprint(assets.css)}.css`;
  const js = { body: assets.js, type: "text/javascript; charset=utf-8" }, css = { body: assets.css, type: "text/css; charset=utf-8" };
  const files = new Map<string, WebFile>([
    ["/", { body: renderPage(options, script, stylesheet, assets.preloads), type: "text/html; charset=utf-8" }],
    [script, { ...js, immutable: true }], [stylesheet, { ...css, immutable: true }],
    ["/assets/app.js", js], ["/assets/app.css", css],
    ["/sw.js", { body: SERVICE_WORKER, type: "text/javascript; charset=utf-8" }],
    ["/assets/speech-worklet.js", { body: SPEECH_WORKLET, type: "text/javascript; charset=utf-8" }],
    ["/manifest.webmanifest", { body: JSON.stringify(MANIFEST), type: "application/manifest+json; charset=utf-8" }],
    ["/favicon.svg", { body: ICON_SVG, type: "image/svg+xml" }],
    ["/assets/icon.svg", { body: ICON_SVG, type: "image/svg+xml" }],
    ["/assets/icon-192.png", { body: iconPng(192), type: "image/png" }],
    ["/assets/icon-512.png", { body: iconPng(512), type: "image/png" }],
    ["/assets/apple-touch-icon.png", { body: iconPng(180), type: "image/png" }],
  ]);
  for (const [name, body] of Object.entries(assets.chunks ?? {})) {
    files.set("/assets/" + name, { body, type: js.type, immutable: true });
  }
  if (assets.font) files.set("/assets/" + assets.font.name, {
    body: Buffer.from(assets.font.base64, "base64"), type: "font/woff2", immutable: true,
  });
  return files;
}

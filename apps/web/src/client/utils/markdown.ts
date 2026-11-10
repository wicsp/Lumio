/**
 * 安全 Markdown 渲染（ADR 0026）：纯函数，不依赖 DOM，便于测试。
 *
 * 支持安全的 Markdown 子集、管道表格及 LaTeX 公式。
 * 原文中的 HTML 一律转义；外部链接只允许 http(s)；图片不加载，只显示替代文字；
 * 相对 .md 链接与 wikilink 变成工作台内的跳转（data-note），不是浏览器导航。
 * `lumio:<ID>` 链接变成资源跳转（data-resource，ADR 0051），由工作台按可见性打开。
 */
import { idOfLumioLink } from "@lumio/schema";
import { t } from "../i18n.ts";
import katex from "katex";
import { mathAt, richBlocks, type RichBlock } from "./markdown-extra.ts";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** 只放行 http/https 的绝对地址；其他协议（javascript:、data: 等）返回 undefined。 */
export function safeExternalUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return url.href;
  } catch { /* 不是绝对地址 */ }
  return undefined;
}

/** 相对路径的 .md 链接目标（去掉 #标题），否则 undefined。 */
export function noteLinkTarget(raw: string): string | undefined {
  const target = raw.trim().replace(/#.*$/, "");
  if (!target.endsWith(".md") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//")) return undefined;
  try { return decodeURIComponent(target); } catch { return undefined; }
}

/** wikilink 去掉别名与标题：[[名称#标题|别名]] → { target: 名称, label: 别名 }。 */
export function parseWikilink(inner: string): { target: string; label: string } {
  const [left, alias] = inner.split("|", 2);
  const target = (left ?? "").split("#")[0]!.trim();
  return { target, label: alias?.trim() || target };
}

const INLINE = /`([^`]+)`|\[\[([^\]\n]+)\]\]|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|【【([^】\n]+)】】/y;
const mathCache = new Map<string, string | undefined>();

/** Native MathML needs no remote fonts, inline styles or relaxed CSP. */
export function renderMath(tex: string, display: boolean): string | undefined {
  if (tex.length > 4096) return;
  let depth = 0;
  for (const char of tex) { if (char === "{" && ++depth > 64) return; if (char === "}") depth--; }
  const key = `${display ? "block" : "inline"}:${tex}`;
  if (mathCache.has(key)) return mathCache.get(key);
  let result: string | undefined;
  try {
    result = katex.renderToString(tex, { displayMode: display, output: "mathml", trust: false,
      strict: "ignore", throwOnError: true, maxSize: 20, maxExpand: 1000, macros: {} });
  } catch { /* Preserve the source for unsupported or incomplete formulas. */ }
  if (mathCache.size >= 128) mathCache.delete(mathCache.keys().next().value!);
  mathCache.set(key, result);
  return result;
}

export function renderRichBlock(block: RichBlock, source: string): string {
  if (block.kind === "math") {
    const math = renderMath(block.tex, true);
    return math ? `<div class="math-display">${math}</div>` : `<pre class="math-source">${escapeHtml(source.slice(block.from, block.to))}</pre>`;
  }
  const cell = (value: string, index: number, tag: "th" | "td") => `<${tag}${tag === "th" ? ' scope="col"' : ""}${block.align[index] ? ` class="align-${block.align[index]}"` : ""}>${renderInline(value)}</${tag}>`;
  return `<div class="markdown-table" tabindex="0" role="region" aria-label="${escapeHtml(t("Table"))}"><table><thead><tr>${block.header.map((value, index) => cell(value, index, "th")).join("")}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map((value, index) => cell(value, index, "td")).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function renderInline(text: string): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    const math = mathAt(text, i);
    if (math) {
      const html = renderMath(math.tex, math.display);
      out += html ? `<span class="${math.display ? "math-display" : "math-inline"}">${html}</span>` : escapeHtml(text.slice(i, math.to));
      i = math.to; continue;
    }
    if (text[i] === "\\" && /[\\`*{}[\]()#+\-.!_$|>【】]/.test(text[i + 1] ?? "")) { out += escapeHtml(text[i + 1]!); i += 2; continue; }
    INLINE.lastIndex = i;
    const m = INLINE.exec(text);
    if (!m) { out += escapeHtml(text[i++]!); continue; }
    i += m[0].length;
    if (m[1] !== undefined) out += `<code>${escapeHtml(m[1])}</code>`;
    else if (m[2] !== undefined || m[8] !== undefined) {
      const { target, label } = parseWikilink((m[2] ?? m[8])!);
      out += target ? `<a href="#" class="note-link" data-note="${escapeHtml(target)}">${escapeHtml(label)}</a>` : escapeHtml(m[0]);
    } else if (m[4] !== undefined) out += `<span class="img-placeholder">[${escapeHtml(t("Image: {0}", m[3] || t("Untitled")))}]</span>`;
    else if (m[6] !== undefined) {
      const resource = idOfLumioLink(m[6].trim());
      const external = resource ? undefined : safeExternalUrl(m[6]); const note = external || resource ? undefined : noteLinkTarget(m[6]);
      if (resource) out += `<a href="#" class="resource-link" data-resource="${escapeHtml(resource)}">${escapeHtml(m[5]!)}</a>`;
      else if (external) out += `<a href="${escapeHtml(external)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(m[5]!)}</a>`;
      else if (note) out += `<a href="#" class="note-link" data-note="${escapeHtml(note)}">${escapeHtml(m[5]!)}</a>`;
      else out += escapeHtml(m[5]!);
    } else out += `<strong>${renderInline(m[7]!)}</strong>`;
  }
  return out;
}

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+/;

export function renderMarkdown(source: string): string {
  source = source.replace(/\r\n?/g, "\n");
  const lines = source.split("\n"), blocks = new Map(richBlocks(source).map(block => [block.from, block]));
  const offsets: number[] = []; let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const out: string[] = []; let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) out.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const block = blocks.get(offsets[i]!);
    if (block) {
      flush(); out.push(renderRichBlock(block, source));
      while (i + 1 < lines.length && offsets[i + 1]! < block.to) i++;
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush(); const code: string[] = [];
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      while (++i < lines.length && !close.test(lines[i]!)) code.push(lines[i]!);
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); continue;
    }
    // Indented code only starts after a blank line: an indented line can also continue a paragraph or a list item.
    if (/^(?: {4}|\t)/.test(line) && !paragraph.length && (i === 0 || !lines[i - 1]!.trim()) && !LIST_ITEM.test(line)) {
      flush(); const code: string[] = [];
      while (i < lines.length && /^(?: {4}|\t)/.test(lines[i]!)) code.push(lines[i++]!.replace(/^(?: {4}|\t)/, ""));
      i--; out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flush(); const level = Math.min(heading[1]!.length + 1, 6); out.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`); continue; }
    const list = /^\s*([-*+]|\d+\.)\s+/.exec(line);
    if (list) {
      flush(); const ordered = /\d/.test(list[1]!); const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)) items.push(`<li>${renderInline(lines[i++]!.replace(/^\s*([-*+]|\d+\.)\s+/, ""))}</li>`);
      i--; out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`); continue;
    }
    if (line.startsWith(">")) { flush(); out.push(`<blockquote>${renderInline(line.replace(/^>\s?/, ""))}</blockquote>`); continue; }
    if (!line.trim()) { flush(); continue; }
    paragraph.push(line);
  }
  flush();
  return out.join("\n");
}

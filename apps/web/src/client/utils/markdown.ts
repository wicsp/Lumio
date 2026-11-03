/**
 * 安全 Markdown 渲染（ADR 0026）：纯函数，不依赖 DOM，便于测试。
 *
 * 只支持标题、段落、列表、引用、代码块、行内代码、粗体、链接与 [[wikilink]]。
 * 原文中的 HTML 一律转义；外部链接只允许 http(s)；图片不加载，只显示替代文字；
 * 相对 .md 链接与 wikilink 变成工作台内的跳转（data-note），不是浏览器导航。
 */
import { t } from "../i18n.ts";

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

const INLINE = /`([^`]+)`|\[\[([^\]\n]+)\]\]|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;

export function renderInline(text: string): string {
  let out = "", last = 0;
  for (const m of text.matchAll(INLINE)) {
    out += escapeHtml(text.slice(last, m.index)); last = m.index + m[0].length;
    if (m[1] !== undefined) out += `<code>${escapeHtml(m[1])}</code>`;
    else if (m[2] !== undefined) {
      const { target, label } = parseWikilink(m[2]);
      out += target ? `<a href="#" class="note-link" data-note="${escapeHtml(target)}">${escapeHtml(label)}</a>` : escapeHtml(m[0]);
    } else if (m[4] !== undefined) out += `<span class="img-placeholder">[${escapeHtml(t("Image: {0}", m[3] || t("Untitled")))}]</span>`;
    else if (m[6] !== undefined) {
      const external = safeExternalUrl(m[6]); const note = external ? undefined : noteLinkTarget(m[6]);
      if (external) out += `<a href="${escapeHtml(external)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(m[5]!)}</a>`;
      else if (note) out += `<a href="#" class="note-link" data-note="${escapeHtml(note)}">${escapeHtml(m[5]!)}</a>`;
      else out += escapeHtml(m[5]!);
    } else out += `<strong>${escapeHtml(m[7]!)}</strong>`;
  }
  return out + escapeHtml(text.slice(last));
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = []; let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) out.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^(```|~~~)/.exec(line);
    if (fence) {
      flush(); const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith(fence[1]!)) code.push(lines[i]!);
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); continue;
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

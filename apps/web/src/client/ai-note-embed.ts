/**
 * AI 笔记嵌入（ADR 0051 第 4 节）：人的笔记里**单独成段**、指向 AI 笔记的普通链接，显示为可折叠卡片。
 * 卡片标明是 AI 写的；正文只在展开时读取。不新增 Markdown 语法，其他编辑器里它就是一个链接。
 */
import type { NoteDetail } from "@lumio/schema";
import type { Client } from "./api.ts";
import { clear, h, icon } from "./dom.ts";
import { t } from "./i18n.ts";
import { aiNoteIdOf } from "./resources.ts";
import { renderMarkdown } from "./utils/markdown.ts";

const TTL = 30_000;
const cache = new Map<string, { at: number; note: Promise<NoteDetail> }>();

/** 同一篇 AI 笔记在短时间内只读一次（编辑器每次重绘都会重建卡片）。 */
function load(client: Client, id: string, fresh = false): Promise<NoteDetail> {
  const hit = cache.get(id);
  if (hit && !fresh && Date.now() - hit.at < TTL) return hit.note;
  const note = client.show(id);
  cache.set(id, { at: Date.now(), note });
  note.catch(() => { if (cache.get(id)?.note === note) cache.delete(id); });
  return note;
}

export interface EmbedOptions {
  open(id: string): void;
  /** 编辑器里：回到这一行的原文。 */
  edit?(): void;
}

/** 一行只有一个链接时，返回它指向的 AI 笔记 ID 与链接文字；否则 undefined。 */
export function aiNoteLine(line: string): { id: string; label: string } | undefined {
  const wiki = /^\s*\[\[([^\]\n]+)\]\]\s*$/.exec(line);
  if (wiki) {
    const [left, alias] = wiki[1]!.split("|", 2);
    const target = left!.split("#")[0]!.trim(), id = aiNoteIdOf(target);
    return id ? { id, label: alias?.trim() || "" } : undefined;
  }
  const md = /^\s*(?<!!)\[([^\]\n]+)\]\(([^\s)]+)\)\s*$/.exec(line);
  if (!md) return undefined;
  let target = md[2]!.replace(/#.*$/, "");
  try { target = decodeURIComponent(target); } catch { return undefined; }
  if (!target.endsWith(".md")) return undefined;
  const id = aiNoteIdOf(target);
  return id ? { id, label: md[1]!.trim() } : undefined;
}

export function aiNoteCard(client: Client, id: string, label: string, options: EmbedOptions): HTMLElement {
  const title = h("span", { class: "ai-embed-title" }, label || t("AI note"));
  const body = h("div", { class: "ai-embed-body markdown", hidden: true });
  const toggle = h("button", { type: "button", class: "btn btn-small", "aria-expanded": "false" }, icon("down"), t("Show"));
  const card = h("div", { class: "ai-embed", "data-ai-note": id },
    h("div", { class: "ai-embed-head" },
      h("span", { class: "pill ai-pill", title: t("Written by AI") }, t("AI")),
      title,
      h("span", { class: "bar-spacer" }),
      toggle,
      h("button", { type: "button", class: "btn btn-small", onclick: () => options.open(id) }, t("Open")),
      options.edit && h("button", { type: "button", class: "icon-btn", title: t("Edit link"), "aria-label": t("Edit link"), onclick: () => options.edit!() }, icon("edit"))),
    body);
  let expanded = false;
  const show = async () => {
    clear(body, h("p", { class: "muted" }, t("Loading…")));
    try {
      const note = await load(client, id);
      if (!label) title.textContent = note.note.title;
      body.innerHTML = renderMarkdown(note.body);
    } catch {
      clear(body, h("p", { class: "muted" }, t("This AI note isn't available.")));
    }
  };
  toggle.addEventListener("click", () => {
    expanded = !expanded;
    body.hidden = !expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
    clear(toggle, icon("down"), expanded ? t("Hide") : t("Show"));
    if (expanded) void show();
  });
  // 链接只写了 ID 时，先补上标题。
  if (!label) void load(client, id).then(note => { title.textContent = note.note.title; }, () => { title.textContent = t("AI note"); });
  return card;
}

/** 阅读视图：把单独成段、指向 AI 笔记的链接换成卡片。 */
export function hydrateAiEmbeds(root: HTMLElement, client: Client, options: EmbedOptions): void {
  for (const paragraph of root.querySelectorAll<HTMLParagraphElement>("p")) {
    const links = paragraph.querySelectorAll<HTMLElement>("a[data-note]");
    if (links.length !== 1 || paragraph.childElementCount !== 1) continue;
    const link = links[0]!;
    if ((paragraph.textContent ?? "").trim() !== (link.textContent ?? "").trim()) continue;
    const id = aiNoteIdOf(link.dataset.note!);
    if (!id) continue;
    const text = (link.textContent ?? "").trim();
    paragraph.replaceWith(aiNoteCard(client, id, text.endsWith(id) ? "" : text, options));
  }
}

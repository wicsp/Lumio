/**
 * 资源卡片嵌入（任务、项目、笔记引用）：助手消息里的资源链接显示为紧凑卡片。
 * 卡片只显示标题与类型，点击跳转到对应页面。不新增 Markdown 语法，只是渲染优化。
 */
import type { Client } from "./api.ts";
import { h, icon } from "./dom.ts";
import { t } from "./i18n.ts";
import type { Navigate } from "./navigation.ts";
import { openResource, prefixOf } from "./resources.ts";

type CardKind = { label: string; icon: string };
const CARD_KINDS = new Map<string, CardKind>([
  ["task", { label: "Task", icon: "work" }],
  ["prj", { label: "Project", icon: "folder" }],
  ["pap", { label: "Paper", icon: "knowledge" }],
  ["idea", { label: "Idea", icon: "file" }],
  ["src", { label: "Source", icon: "link" }],
  ["exp", { label: "Experiment", icon: "graph" }],
  ["post", { label: "Post", icon: "file" }],
  ["ain", { label: "AI note", icon: "assistant" }],
]);

function resourceCard(client: Client, navigate: Navigate, id: string, kind: CardKind, label: string): HTMLElement {
  const title = h("span", { class: "resource-card-title" }, label || id);
  const card = h("a", {
    href: "#",
    class: "resource-card",
    "data-resource-id": id,
    onclick: (event: Event) => {
      event.preventDefault();
      void openResource(client, navigate, id);
    },
  },
    h("span", { class: "resource-card-icon" }, icon(kind.icon)),
    h("span", { class: "resource-card-content" },
      h("span", { class: "resource-card-type" }, t(kind.label)),
      title));

  // 异步加载标题
  if (!label || label === id) {
    void client.resource(id).then(summary => {
      if (summary.status === "visible") {
        title.textContent = summary.title;
      }
    }).catch(() => {
      // 加载失败，保持原样
    });
  }

  return card;
}

/**
 * 将助手消息中的资源链接转换为紧凑卡片。
 * 只处理单独成段的资源链接（类似 AI 笔记嵌入的逻辑）。
 */
export function hydrateResourceCards(root: HTMLElement, client: Client, navigate: Navigate): void {
  for (const paragraph of root.querySelectorAll<HTMLParagraphElement>("p")) {
    const link = paragraph.querySelector<HTMLAnchorElement>(":scope > a[data-resource]");
    const id = link?.dataset.resource;
    if (!id) continue;
    const kind = CARD_KINDS.get(prefixOf(id));
    if (!kind || paragraph.childElementCount !== 1) continue;
    const label = (link.textContent ?? "").trim();
    if ((paragraph.textContent ?? "").trim() !== label) continue;
    paragraph.replaceWith(resourceCard(client, navigate, id, kind, label));
  }
}

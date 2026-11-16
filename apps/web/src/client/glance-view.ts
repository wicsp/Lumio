/**
 * 桌面小助手的"所见"展示（ADR 0066，C1-5）：缩略图与 App / 网址标签。
 *
 * 截图要带 human 令牌读取（`GET /v2/glances/<id>/image`），`<img>` 不能带 Authorization 头；
 * 页面 CSP 只允许 `img-src 'self' data:`，所以读成 Blob 后转为 data URL，不放宽 CSP。
 * 截图是屏幕上的第三方内容：只显示，不当作任何批准依据；保留期过后读不到时显示"截图已删除"。
 */
import type { Glance } from "@lumio/schema";
import { ApiClientError } from "@lumio/api-client";
import type { Client } from "./api.ts";
import { h, icon, openDialog } from "./dom.ts";
import { t } from "./i18n.ts";

const MAX_CACHED = 24;
const images = new Map<string, Promise<string | undefined>>();

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("unreadable"));
    reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
    reader.readAsDataURL(blob);
  });
}

/** 截图的 data URL；截图已删除或看不到时为 undefined。同一页面内缓存最近的几张。 */
export function glanceImage(client: Client, id: string): Promise<string | undefined> {
  const cached = images.get(id);
  if (cached) return cached;
  const loading = client.glanceImage(id).then(dataUrl).catch((cause: unknown) => {
    images.delete(id);
    if (cause instanceof ApiClientError && cause.code === "NOT_FOUND") return undefined;
    throw cause;
  });
  images.set(id, loading);
  while (images.size > MAX_CACHED) images.delete(images.keys().next().value!);
  return loading;
}

export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** "Safari · example.com" 这样的来源标签。 */
export function glanceSource(glance: Pick<Glance, "app" | "url">): string {
  return [glance.app.name, hostOf(glance.url)].filter(Boolean).join(" · ");
}

/**
 * 截图缩略图按钮：点开看原图。先占位，图读到后再填；读不到时显示说明。
 * `label` 用作替代文字与大图标题。
 */
export function glanceThumb(client: Client, id: string, label: string): HTMLElement {
  const frame = h("button", { type: "button", class: "glance-thumb is-loading", "aria-label": t("View screenshot: {0}", label), title: label, disabled: true },
    icon("image", "icon glance-thumb-icon"));
  void glanceImage(client, id).then(src => {
    frame.classList.remove("is-loading");
    if (!src) {
      frame.replaceWith(h("span", { class: "glance-thumb-gone muted", title: t("Screenshots used only in chat are deleted after the retention period.") }, icon("image"), t("Screenshot deleted")));
      return;
    }
    frame.replaceChildren(h("img", { src, alt: label, loading: "lazy", decoding: "async" }));
    frame.disabled = false;
    frame.addEventListener("click", () => {
      openDialog(label, h("div", { class: "glance-full" }, h("img", { src, alt: label }),
        h("p", { class: "field-hint" }, t("Screen content captured by the desktop helper. Third-party content, read-only."))), [], { wide: true });
    });
  }).catch(() => {
    frame.classList.remove("is-loading");
    frame.replaceChildren(icon("alert", "icon glance-thumb-icon"));
    frame.title = t("Couldn't load the screenshot.");
  });
  return frame;
}

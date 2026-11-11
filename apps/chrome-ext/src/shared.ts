/** 插件各页面共用：连接配置、Hub 客户端、文案。 */
import { createClient } from "@lumio/api-client";

export interface Connection { hub: string; token: string; actor: string }

const KEY = "lumio.connection";

export async function loadConnection(): Promise<Connection | undefined> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Connection | undefined;
  return stored?.hub && stored.token ? stored : undefined;
}
export async function saveConnection(connection: Connection): Promise<void> { await chrome.storage.local.set({ [KEY]: connection }); }
export async function clearConnection(): Promise<void> { await chrome.storage.local.remove(KEY); }

export const zh = () => chrome.i18n.getUILanguage().toLowerCase().startsWith("zh");

export function hubClient(connection: Pick<Connection, "hub"> & Partial<Connection>) {
  return createClient({ url: connection.hub, ...(connection.token ? { token: connection.token } : {}), language: zh() ? "zh-CN" : "en" });
}

/** 对 Hub 地址的访问权限（optional_host_permissions），连接时向人申请一次。 */
export const hubPattern = (hub: string) => `${new URL(hub).origin}/*`;

export function newRequestId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}-${[...bytes].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

const ZH: Record<string, string> = {
  "Not connected to Lumio": "还没连接 Lumio",
  "Connect": "连接",
  "Saving…": "正在保存…",
  "Saved to Inbox": "已存到 Inbox",
  "Already saved": "之前存过了",
  "You discarded this before": "你之前丢弃过它",
  "Processing…": "Lumio 正在处理…",
  "Ready": "处理完成",
  "Failed": "处理失败",
  "Archive": "存档",
  "Read": "已读",
  "Discard": "丢弃",
  "Open in Lumio": "在 Lumio 中打开",
  "This page can't be saved.": "这个页面不能保存。",
  "Saved the page text.": "存了页面正文。",
  "Saved the page text (the page was too large for full HTML).": "存了页面文字（页面太大，没有存完整 HTML）。",
  "Saved the transcript.": "存了视频字幕。",
  "No transcript found. Saved the description only. Open the transcript panel on the page and try again to include it.": "没取到字幕，只存了简介。可以先在页面上展开字幕或文字记录，再存一次。",
  "Saved the link. Lumio will download it.": "存了链接，由 Lumio 去下载。",
  "Couldn't read this page. Saved the link instead.": "读不到页面内容，改为只存链接。",
  "Lumio settings": "Lumio 设置",
  "Archived": "已存档",
  "Marked as read": "已标为读过",
  "Moved to Recently deleted": "已移到「最近删除」",
  "Can't reach Lumio. Check that the Hub is running.": "连不上 Lumio，请确认 Hub 正在运行。",
  "The connection expired. Connect again in the extension settings.": "连接已失效，请在插件设置里重新连接。",
  // options
  "Connect this browser to Lumio": "把这个浏览器连接到 Lumio",
  "Hub address": "Hub 地址",
  "Pairing code": "配对码",
  "In Lumio, open Settings → Hub & runtimes → Browser extension and create a pairing code.": "在 Lumio 中打开「设置 → Hub 与执行器 → 浏览器插件」，生成一个配对码。",
  "Connected to {0}": "已连接 {0}",
  "Disconnect": "断开",
  "Chrome needs permission to reach your Hub.": "需要允许插件访问你的 Hub 地址。",
  "Enter a valid address, e.g. http://127.0.0.1:7420": "请输入有效的地址，例如 http://127.0.0.1:7420",
  "How to use": "怎么用",
  "Click the Lumio button, or press Alt+Shift+S, on the page you're reading. Right-click a link to save just the link.": "在正在看的页面上点工具栏的 Lumio 按钮，或按 Alt+Shift+S。右键点链接，可以只存这个链接。",
  "Connecting…": "正在连接…",
};

export function t(text: string, ...args: Array<string | number>): string {
  const value = zh() ? ZH[text] ?? text : text;
  return value.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)] ?? ""));
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((event: Event) => void)> = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === "function") element.addEventListener(name.replace(/^on/, ""), value);
    else if (value === true) element.setAttribute(name, "");
    else if (value !== false) element.setAttribute(name, value);
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

/** 把 Hub 错误翻成人话。 */
export function failureText(error: unknown): string {
  const status = (error as { status?: number })?.status;
  if (status === 401) return t("The connection expired. Connect again in the extension settings.");
  if (status === undefined) return t("Can't reach Lumio. Check that the Hub is running.");
  return error instanceof Error ? error.message : String(error);
}

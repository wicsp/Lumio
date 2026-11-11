/**
 * 弹窗：打开即保存当前页面（点工具栏按钮或 Alt+Shift+S），然后显示处理进度；
 * 处理完可以直接存档、标为已读或丢弃，不用回 Lumio 分拣。
 */
import type { Capture, CaptureTriage } from "@lumio/schema";
import { bilibiliTranscript, snapshotPage, youtubeTranscript } from "./inject.ts";
import { buildCapture, strategyFor, type Built, type PageSnapshot, type TranscriptResult } from "./page.ts";
import { failureText, h, hubClient, loadConnection, newRequestId, t, type Connection } from "./shared.ts";

const root = document.getElementById("root")!;
const POLL_MS = 1500, POLL_LIMIT = 40;

function show(...children: Array<Node | string | null | undefined | false>): void { root.replaceChildren(...children.filter(Boolean) as Array<Node | string>); }

async function run(): Promise<void> {
  const connection = await loadConnection();
  if (!connection) {
    show(h("p", { class: "lead" }, t("Not connected to Lumio")),
      h("button", { type: "button", class: "btn primary", onclick: () => void chrome.runtime.openOptionsPage() }, t("Connect")));
    return;
  }
  // 通常保存当前窗口的活动标签页；`?tab=<id>` 指定标签页（自动化测试用，弹窗本身打开在独立标签页时）。
  const requested = Number(new URLSearchParams(location.search).get("tab"));
  const tab = requested ? await chrome.tabs.get(requested) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const strategy = strategyFor(tab?.url);
  if (!tab?.id || !tab.url || strategy === "unsupported") { show(h("p", { class: "lead" }, t("This page can't be saved."))); return; }

  show(header(tab.title ?? tab.url, tab.url), h("p", { class: "status" }, h("span", { class: "spinner" }), t("Saving…")));
  let page: PageSnapshot | undefined, transcript: TranscriptResult | undefined, unreadable = false;
  try {
    if (strategy === "page") page = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: snapshotPage }))[0]?.result as PageSnapshot | undefined;
    else if (strategy === "youtube" || strategy === "bilibili") {
      transcript = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: strategy === "youtube" ? youtubeTranscript : bilibiliTranscript }))[0]?.result as TranscriptResult | undefined;
    }
  } catch { unreadable = true; }
  const built = buildCapture({ strategy, url: tab.url, ...(tab.title ? { title: tab.title } : {}), ...(page ? { page } : {}), ...(transcript ? { transcript } : {}), requestId: newRequestId("ext") });

  const client = hubClient(connection);
  let capture: Capture, duplicate: string;
  try { ({ capture, duplicate } = await client.capture(built.request)); }
  catch (error) { show(header(tab.title ?? tab.url, tab.url), h("p", { class: "status error" }, failureText(error)), footer(connection)); return; }

  const title = duplicate === "existing" ? t("Already saved") : duplicate === "discarded" ? t("You discarded this before") : t("Saved to Inbox");
  const detail = h("p", { class: "hint" }, duplicate === "none" ? noteText(built, unreadable) : "");
  const status = h("p", { class: "status" });
  const actions = h("div", { class: "actions" });
  show(header(capture.title ?? tab.title ?? tab.url, tab.url), h("p", { class: "lead ok" }, title), detail, status, actions, footer(connection));
  await follow(client, connection, capture, status, actions);
}

function noteText(built: Built, unreadable: boolean): string {
  if (unreadable) return t("Couldn't read this page. Saved the link instead.");
  return {
    page: t("Saved the page text."),
    "page-text": t("Saved the page text (the page was too large for full HTML)."),
    transcript: t("Saved the transcript."),
    "no-transcript": t("No transcript found. Saved the description only. Open the transcript panel on the page and try again to include it."),
    link: t("Saved the link. Lumio will download it."),
  }[built.note];
}

/** 等 Hub 处理完，再给出分拣按钮。弹窗关了也不要紧，条目留在 Inbox。 */
async function follow(client: ReturnType<typeof hubClient>, connection: Connection, capture: Capture, status: HTMLElement, actions: HTMLElement): Promise<void> {
  for (let i = 0; i < POLL_LIMIT && (capture.state === "queued" || capture.state === "extracting" || capture.card === "pending"); i++) {
    status.replaceChildren(h("span", { class: "spinner" }), t("Processing…"));
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    try { capture = await client.getCapture(capture.id); } catch { break; }
  }
  if (capture.triage) { status.replaceChildren(); return; }
  if (capture.state === "failed") { status.replaceChildren(h("span", { class: "error" }, t("Failed"), capture.error ? ` · ${capture.error.message}` : "")); return; }
  if (capture.state !== "ready") { status.replaceChildren(); return; }
  status.replaceChildren(t("Ready"));
  const triage = (value: CaptureTriage, label: string, done: string) => h("button", { type: "button", class: "btn", onclick: async () => {
    actions.querySelectorAll("button").forEach(button => { button.disabled = true; });
    try {
      capture = await client.captureCommand(capture.id, { request_id: newRequestId("ext"), expected_revision: capture.revision, action: { op: "triage", triage: value } });
      status.replaceChildren(done); actions.replaceChildren();
    } catch (error) {
      status.replaceChildren(h("span", { class: "error" }, failureText(error)));
      actions.querySelectorAll("button").forEach(button => { button.disabled = false; });
    }
  } }, label);
  actions.replaceChildren(triage("reference", t("Archive"), t("Archived")), triage("read", t("Read"), t("Marked as read")), triage("discard", t("Discard"), t("Moved to Recently deleted")));
  void connection;
}

function header(title: string, url: string): HTMLElement {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* 无效地址 */ }
  return h("header", {}, h("strong", { class: "title" }, title), h("span", { class: "host" }, host));
}

function footer(connection: Connection): HTMLElement {
  return h("footer", {},
    h("a", { href: `${connection.hub}/#inbox`, target: "_blank", rel: "noopener" }, t("Open in Lumio")),
    h("button", { type: "button", class: "link", onclick: () => void chrome.runtime.openOptionsPage() }, t("Lumio settings")));
}

void run();

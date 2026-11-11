/**
 * Inbox（ADR 0057，I1-5）：未分拣的捕获。粘贴链接或正文存下来，Hub 解析出原文并让 AI 写卡片；
 * 人在这里分拣（想读 / 存档 / 已读 / 丢弃）。不分拣也能被检索到。
 *
 * - 处理中的条目每 2 秒刷新一次，处理完就停。
 * - 卡片是这条资料的 AI 笔记；"可能相关"用卡片内容做词法相关推荐（ADR 0035），实时计算、不保存。
 * - 系统分享（PWA share target）带来的链接在 main.ts 暂存，这里取出后直接捕获。
 */
import { type Capture, type CaptureCommand, type CaptureCreate, type CaptureTriage, type NoteDetail, type KnowledgeRelatedResult } from "@lumio/schema";
import { errorText, isConflict, type Client } from "../api.ts";
import { newRequestId, formatTime } from "../commands.ts";
import { autosize, clear, empty, failure, h, icon, loading, openDialog, toast } from "../dom.ts";
import { ago } from "../format.ts";
import { t, translated } from "../i18n.ts";
import type { Navigate } from "../navigation.ts";
import { renderMarkdown } from "../utils/markdown.ts";

const SHARE_KEY = "lumio.web.share";
const POLL_MS = 2000;
const URL_ONLY = /^https?:\/\/\S+$/i;

/** 系统分享进来的内容（main.ts 写入，Inbox 取出一次）。 */
export interface SharedCapture { url?: string; title?: string; text?: string }

/** 从分享参数里整理出要捕获的内容；什么都没有时返回 undefined。分享的 text 里常常只有一个链接。 */
export function sharedCapture(params: URLSearchParams): SharedCapture | undefined {
  const pick = (name: string) => params.get(name)?.trim() || undefined;
  let url = pick("url"), text = pick("text");
  const title = pick("title");
  if (!url && text && URL_ONLY.test(text)) { url = text; text = undefined; }
  if (!url && text) {
    const found = /https?:\/\/\S+/i.exec(text)?.[0];
    if (found && text.replace(found, "").trim().length < 200) { url = found; text = undefined; }
  }
  return url || text ? { ...(url ? { url } : {}), ...(title ? { title } : {}), ...(text ? { text } : {}) } : undefined;
}

export function stashShare(share: SharedCapture): void {
  try { sessionStorage.setItem(SHARE_KEY, JSON.stringify(share)); } catch { /* 存储不可用时放弃这次分享 */ }
}

function takeShare(): SharedCapture | undefined {
  try {
    const raw = sessionStorage.getItem(SHARE_KEY);
    sessionStorage.removeItem(SHARE_KEY);
    return raw ? JSON.parse(raw) as SharedCapture : undefined;
  } catch { return undefined; }
}

/** 输入框里的文字 → 捕获请求：单独一个网址按链接存，其余按粘贴的正文存。 */
export function captureInput(value: string, channel: CaptureCreate["channel"], title?: string): CaptureCreate | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const base = { request_id: newRequestId("capture"), channel, ...(title ? { title } : {}) };
  return URL_ONLY.test(text) ? { ...base, url: text } : { ...base, content: { format: "text", body: text } };
}

const busy = (capture: Capture) => capture.state === "queued" || capture.state === "extracting" || capture.card === "pending";

const KIND_LABEL = translated({ paper: "Paper", web: "Web page", video: "Video", podcast: "Podcast", text: "Pasted text" });
const KIND_ICON: Record<string, string> = { paper: "file", web: "globe", video: "play", podcast: "mic", text: "edit" };
const TRIAGE_LABEL: Record<CaptureTriage, string> = translated({ "to-read": "To read", reading: "Reading", read: "Read", reference: "Archive", discard: "Discarded" });
const ERROR_TEXT = translated({
  blocked: "This address isn't allowed: it points to this computer or a private network.",
  fetch_failed: "Couldn't download the page.",
  too_large: "The page is too large.",
  timeout: "The site took too long to respond.",
  unsupported: "This kind of link isn't supported yet.",
  login_required: "The page needs a sign-in. Paste the text instead.",
  extract_failed: "Couldn't find the main text on the page.",
  runtime_unavailable: "No runtime can process this right now.",
  summary_failed: "The AI couldn't write a card.",
});

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export class InboxPane {
  private input = autosize(h("textarea", { rows: "1", class: "inbox-input", "aria-label": t("Link or text to save"), placeholder: t("Paste a link, or text to save…") }));
  private save = h("button", { type: "button", class: "btn btn-primary" }, t("Save"));
  private list = h("div", { class: "inbox-list" });
  private meta = h("span", { class: "bar-meta" });
  private untriaged = true;
  private captures: Capture[] = [];
  private rows = new Map<string, { key: string; row: HTMLElement }>();
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private active = true;
  private summaryConfigured?: boolean;

  constructor(root: HTMLElement, private client: Client, private navigate: Navigate, private changed: () => void) {
    const seg = h("div", { class: "segmented", role: "group", "aria-label": t("Show") });
    for (const [value, label] of [[true, "To sort"], [false, "All"]] as const) {
      seg.append(h("button", { type: "button", "aria-pressed": String(value === this.untriaged), onclick: (event: Event) => {
        this.untriaged = value; seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === event.currentTarget)));
        this.rows.clear(); void this.load();
      } }, t(label)));
    }
    this.input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.submit(); }
    });
    this.save.addEventListener("click", () => void this.submit());
    root.append(
      h("header", { class: "bar" },
        h("h1", { class: "bar-title" }, t("Inbox"), this.meta),
        h("span", { class: "bar-spacer" }),
        seg,
        h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => void this.load() }, icon("refresh"))),
      h("div", { class: "inbox-scroll" }, h("div", { class: "inbox-page" },
        h("form", { class: "inbox-capture", onsubmit: (event: Event) => { event.preventDefault(); void this.submit(); } },
          this.input, this.save),
        h("p", { class: "field-hint inbox-hint" }, t("Lumio keeps the original text and has AI write a short card. Sort it later, or leave it for the AI to find when it's relevant.")),
        this.list)));
    void this.load();
    void this.loadBindings();
    const share = takeShare();
    if (share) void this.capture({
      request_id: newRequestId("share"), channel: "share",
      ...(share.url ? { url: share.url } : {}), ...(share.title ? { title: share.title } : {}),
      ...(share.text ? { content: { format: "text" as const, body: share.text } } : {}),
    });
  }

  dispose(): void { this.active = false; this.generation++; clearTimeout(this.timer); }
  liveRefresh(): void { void this.load(true); }
  resume(): void { void this.load(true); }
  intent(name: string): void { if (name === "capture") this.input.focus(); }
  get dirty(): boolean { return !!this.input.value.trim(); }

  private async loadBindings(): Promise<void> {
    try {
      const bindings = await this.client.knowledgeBindings();
      if (!this.active) return;
      this.summaryConfigured = bindings.some(binding => binding.purpose === "knowledge.summary");
      // 绑定状态会改变"没有卡片"的提示和按钮，重画已有的行。
      this.rows.clear(); this.render();
    } catch { this.summaryConfigured = undefined; }
  }

  private async submit(): Promise<void> {
    const request = captureInput(this.input.value, "web");
    if (!request) { this.input.focus(); return; }
    if (await this.capture(request)) { this.input.value = ""; this.input.dispatchEvent(new Event("input")); }
  }

  private async capture(request: CaptureCreate): Promise<boolean> {
    this.save.disabled = this.input.disabled = true;
    try {
      const result = await this.client.capture(request);
      if (!this.active) return true;
      if (result.duplicate === "existing") toast(t("Already saved. It's in the list."), "ok", result.capture.entity?.id ? { label: t("Open"), run: () => this.openEntity(result.capture) } : undefined);
      else if (result.duplicate === "discarded") {
        if (result.capture.entity?.id) toast(t("You discarded this before. Restore it from Recently deleted if you want it back."), "ok", { label: t("Open Recently deleted"), run: () => this.navigate("trash") });
        else toast(t("You discarded this before."), "ok");
      }
      this.upsert(result.capture, true);
      this.changed();
      return true;
    } catch (cause) {
      if (this.active) toast(errorText(cause), "error");
      return false;
    } finally {
      this.save.disabled = this.input.disabled = false;
    }
  }

  private async load(quiet = false): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    if (!quiet && !this.captures.length) clear(this.list, loading());
    try {
      const { captures, total } = await this.client.captures({ untriaged: this.untriaged, limit: 100 });
      if (!this.active || generation !== this.generation) return;
      this.captures = captures;
      this.meta.textContent = this.untriaged ? (total ? t("{0} to sort", total) : "") : "";
      this.render();
    } catch (cause) {
      if (this.active && generation === this.generation && !quiet) clear(this.list, failure(errorText(cause), () => void this.load()));
    }
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.active && this.captures.some(busy)) this.timer = setTimeout(() => void this.load(true), POLL_MS);
  }

  /** 新捕获或命令结果：放进列表（新的在最上面），未分拣视图里去掉已分拣的。 */
  private upsert(capture: Capture, first = false): void {
    const others = this.captures.filter(item => item.id !== capture.id);
    const exists = others.length !== this.captures.length;
    if (this.untriaged && capture.triage) this.captures = others;
    else if (exists && !first) this.captures = this.captures.map(item => item.id === capture.id ? capture : item);
    else this.captures = [capture, ...others];
    this.render();
    this.schedule();
  }

  private render(): void {
    if (!this.captures.length) {
      this.rows.clear();
      clear(this.list, empty(this.untriaged ? t("Nothing to sort. Paste a link above, or share one to Lumio from another app.") : t("Nothing saved yet.")));
      return;
    }
    const next = new Map<string, { key: string; row: HTMLElement }>();
    const nodes = this.captures.map(capture => {
      const key = JSON.stringify(capture);
      const old = this.rows.get(capture.id);
      const entry = old && old.key === key ? old : { key, row: this.row(capture) };
      next.set(capture.id, entry);
      return entry.row;
    });
    this.rows = next;
    // 只在顺序或内容变化时重排，保留展开状态与焦点。
    const current = [...this.list.children];
    if (current.length !== nodes.length || nodes.some((node, index) => current[index] !== node)) clear(this.list, ...nodes);
  }

  private row(capture: Capture): HTMLElement {
    const title = capture.entity?.title || capture.title || hostOf(capture.url) || t("Untitled");
    const kind = capture.kind ?? (capture.url ? "web" : "text");
    const meta = [KIND_LABEL[kind], hostOf(capture.url), ago(capture.created)].filter(Boolean).join(" · ");
    const status = this.statusPill(capture);
    const body = h("div", { class: "inbox-body" });
    const row = h("article", { class: `inbox-row${capture.triage ? " is-triaged" : ""}`, tabindex: "0", "data-pad-row": capture.id },
      h("div", { class: "inbox-head" },
        h("span", { class: "inbox-kind", title: KIND_LABEL[kind] }, icon(KIND_ICON[kind] ?? "file")),
        h("div", { class: "inbox-main" },
          capture.entity?.id
            ? h("button", { type: "button", class: "inbox-title", "data-pad-action": "primary", onclick: () => this.openEntity(capture) }, title)
            : h("strong", { class: "inbox-title" }, title),
          h("span", { class: "muted", title: formatTime(capture.created) }, meta)),
        status),
      body,
      this.actions(capture));
    this.fillBody(body, capture);
    return row;
  }

  private statusPill(capture: Capture): HTMLElement | null {
    if (capture.triage) return h("span", { class: `pill${capture.triage === "discard" ? " pill-red" : ""}` }, TRIAGE_LABEL[capture.triage]);
    if (capture.state === "queued" || capture.state === "extracting") return h("span", { class: "pill pill-blue" }, icon("refresh", "icon spin"), capture.state === "queued" ? t("Waiting") : t("Extracting"));
    if (capture.state === "failed") return h("span", { class: "pill pill-red" }, t("Failed"));
    if (capture.card === "pending") return h("span", { class: "pill pill-blue" }, icon("refresh", "icon spin"), t("Writing card"));
    return null;
  }

  private fillBody(body: HTMLElement, capture: Capture): void {
    if (capture.state === "failed") {
      const message = capture.error ? ERROR_TEXT[capture.error.code] ?? capture.error.message : t("Something went wrong.");
      body.append(h("p", { class: "inbox-error" }, icon("alert"), h("span", {}, message)));
      return;
    }
    if (capture.state !== "ready") return;
    if (capture.card === "none") {
      body.append(h("p", { class: "field-hint" }, this.summaryConfigured === false
        ? t("No AI card: choose a summary model in Settings → AI models.")
        : t("No AI card yet.")));
    } else if (capture.card === "failed") {
      body.append(h("p", { class: "inbox-error" }, icon("alert"), h("span", {}, t("The AI couldn't write a card."))));
    } else if ((capture.card === "ready" || capture.card === "deep") && capture.ai_note) {
      const card = h("div", { class: "inbox-card markdown" }, h("p", { class: "muted" }, t("Loading…")));
      const related = h("div", { class: "inbox-related", hidden: true });
      body.append(h("div", { class: "inbox-card-wrap" },
        h("span", { class: "pill ai-pill", title: t("Written by AI") }, capture.card === "deep" ? t("AI · deep read") : t("AI")), card), related);
      void this.loadCard(capture, card, related);
    }
  }

  private async loadCard(capture: Capture, card: HTMLElement, related: HTMLElement): Promise<void> {
    let note: NoteDetail;
    try { note = await this.client.show(capture.ai_note!); }
    catch { if (this.active) clear(card, h("p", { class: "muted" }, t("This AI note isn't available."))); return; }
    if (!this.active) return;
    card.innerHTML = renderMarkdown(note.body);
    if (capture.card === "deep") card.classList.add("is-long");
    let hits: KnowledgeRelatedResult["hits"] = [];
    try {
      const result = await this.client.relatedNotes({ title: note.note.title, text: note.body.slice(0, 20000), focus: "", ...(capture.entity?.id ? { exclude_id: capture.entity.id } : {}) });
      hits = result.hits.filter(hit => hit.note.id !== capture.ai_note && hit.note.id !== capture.entity?.id && hit.note.type !== "ai-note").slice(0, 3);
    } catch { return; }
    if (!this.active || !hits.length) return;
    related.hidden = false;
    clear(related, h("span", { class: "inbox-related-label" }, t("Possibly related")),
      ...hits.map(hit => h("button", { type: "button", class: "inbox-related-row", title: hit.snippet || hit.note.title,
        onclick: () => this.navigate("knowledge", hit.note.id ?? hit.note.path) }, icon("link"), h("span", {}, hit.note.title))));
  }

  private actions(capture: Capture): HTMLElement {
    const bar = h("div", { class: "inbox-actions" });
    const command = (action: CaptureCommand["action"], done?: string) => async (event: Event) => {
      const button = event.currentTarget as HTMLButtonElement;
      bar.querySelectorAll("button").forEach(b => { b.disabled = true; });
      try {
        const updated = await this.client.captureCommand(capture.id, { request_id: newRequestId("inbox"), expected_revision: capture.revision, action });
        if (!this.active) return;
        if (action.op === "triage" && action.triage === "discard") {
          if (updated.entity?.id) toast(t("Moved to Recently deleted"), "ok", { label: t("Open Recently deleted"), run: () => this.navigate("trash") });
          else toast(t("Discarded"), "ok");
        } else if (done) toast(done, "ok");
        this.upsert(updated);
        if (action.op === "triage" && this.untriaged) void this.load(true);
        this.changed();
      } catch (cause) {
        if (!this.active) return;
        toast(isConflict(cause) ? t("This changed in the meantime. The list was refreshed.") : errorText(cause), "error");
        if (isConflict(cause)) void this.load(true);
        bar.querySelectorAll("button").forEach(b => { b.disabled = false; });
        button.focus();
      }
    };
    const triage = (value: CaptureTriage, label: string, done: string, iconName: string, primary = false) =>
      h("button", { type: "button", class: `btn btn-small${primary ? " btn-primary" : ""}`, onclick: command({ op: "triage", triage: value }, done) }, icon(iconName), t(label));

    if (capture.state === "failed" && !capture.triage) {
      // 地址被拒绝、类型不支持、页面太大时，原样重试不会有不同结果，只提供粘贴正文。
      const pointless = capture.error && ["blocked", "unsupported", "too_large"].includes(capture.error.code);
      if (!pointless) bar.append(h("button", { type: "button", class: "btn btn-small btn-primary", "data-pad-action": "retry", onclick: command({ op: "retry" }) }, icon("refresh"), t("Retry")));
      bar.append(h("button", { type: "button", class: `btn btn-small${pointless ? " btn-primary" : ""}`, onclick: () => this.pasteAndRetry(capture, command) }, icon("edit"), t("Paste the text")));
    }
    if (capture.state === "ready" && !capture.triage) {
      bar.append(
        triage("to-read", "To read", t("Kept in your reading list."), "flag", true),
        triage("reference", "Archive", t("Archived. The AI can still find it."), "folder"),
        triage("read", "Read", t("Marked as read."), "check"));
    }
    if (capture.state === "ready" && capture.triage !== "discard") {
      bar.append(h("button", { type: "button", class: "btn btn-small btn-quiet", onclick: () => void this.showOriginal(capture) }, icon("file"), t("Original")));
      if (capture.card === "ready" || capture.card === "failed" || (capture.card === "none" && this.summaryConfigured)) {
        const deep = capture.card === "ready";
        bar.append(h("button", { type: "button", class: "btn btn-small btn-quiet",
          onclick: command({ op: "summarize", depth: deep ? "deep" : "card" }, deep ? t("The AI is reading the full text.") : t("The AI is writing a card.")) },
        icon("assistant"), deep ? t("Deep read") : capture.card === "failed" ? t("Try the card again") : t("Write a card")));
      }
    }
    if (!capture.triage && (capture.state === "ready" || capture.state === "failed")) {
      bar.append(h("span", { class: "bar-spacer" }),
        h("button", { type: "button", class: "icon-btn row-delete", title: t("Discard"), "aria-label": t("Discard"), "data-pad-action": "discard",
          onclick: command({ op: "triage", triage: "discard" }) }, icon("trash")));
    }
    return bar;
  }

  private pasteAndRetry(capture: Capture, command: (action: CaptureCommand["action"], done?: string) => (event: Event) => Promise<void>): void {
    const area = autosize(h("textarea", { rows: "8", "aria-label": t("Text"), placeholder: t("Paste the article text here") }));
    const go = h("button", { type: "button", class: "btn btn-primary" }, t("Save"));
    go.addEventListener("click", event => {
      const body = area.value.trim();
      if (!body) { area.focus(); return; }
      dialog.close();
      void command({ op: "retry", content: { format: "text", body } })(event);
    });
    const dialog = openDialog(t("Paste the text"), h("div", { class: "form-stack" },
      h("p", { class: "field-hint" }, t("Copy the article from your browser and paste it here. Lumio saves it as the original.")), area), [go], { wide: true });
    area.focus();
  }

  private async showOriginal(capture: Capture): Promise<void> {
    const ref = capture.entity?.id ?? capture.entity?.path;
    if (!ref) return;
    const body = h("div", { class: "inbox-original markdown" }, loading());
    const head = h("p", { class: "field-hint" });
    openDialog(capture.entity?.title || t("Original"), h("div", { class: "form-stack" }, head, body), [], { wide: true, cancelLabel: t("Close") });
    try {
      const original = await this.client.showOriginal(ref);
      const fm = original.frontmatter;
      head.textContent = [t("Saved {0}", formatTime(fm.captured)), fm.url ? hostOf(fm.url) : "", t("Third-party content, read-only")].filter(Boolean).join(" · ");
      body.innerHTML = renderMarkdown(original.body);
    } catch (cause) {
      clear(body, failure(errorText(cause)));
    }
  }

  private openEntity(capture: Capture): void {
    const ref = capture.entity?.id ?? capture.entity?.path;
    if (ref) this.navigate("knowledge", ref);
  }
}

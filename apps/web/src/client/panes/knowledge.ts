import { KnowledgeCreate } from "./knowledge-create.ts";
/**
 * 知识（ADR 0026）：搜索、类型筛选、新建笔记、阅读与链接/反向链接。已有笔记仍在外部编辑器修改。
 * 私密内容默认隐藏，需显式打开；关闭时清空已显示的详情并丢弃迟到的私密响应。
 * 旧版任务/项目/例行笔记默认不出现在「全部」里，可在类型菜单中单独查看。
 */
import { NOTE_TYPES, type NoteDetail, type LinksResult, type SearchResult } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { clear, debounce, empty, failure, h, icon, loading, openMenu, placeholder } from "../dom.ts";
import { listKeys, markSelected } from "../list-keys.ts";
import { renderMarkdown, safeExternalUrl } from "../utils/markdown.ts";
import { t, translated } from "../i18n.ts";

const TYPE_LABEL: Record<string, string> = translated({ paper: "Paper", idea: "Idea", experiment: "Experiment", source: "Source", post: "Post", asset: "Asset", project: "Old project", task: "Old task", routine: "Old routine" });
const LEGACY = new Set(["project", "task", "routine"]);

export class KnowledgePane {
  private split = h("div", { class: "split" });
  private results = h("div", { class: "list-scroll" });
  private detail = h("section", { class: "detail-pane", "aria-live": "polite" });
  private query = h("input", { type: "search", name: "q", placeholder: t("Title, text, author, citekey"), autocomplete: "off" });
  private type = "";
  private includePrivate = false;
  private typeButton = h("button", { type: "button", class: "filter-btn" });
  private privateButton = h("button", { type: "button", class: "filter-btn", "aria-pressed": "false", title: t("Show notes marked private") });
  private generation = 0;
  private searchGeneration = 0;
  private active = true;
  private currentPath = "";
  private selected?: string;
  private creator?: KnowledgeCreate;
  private unbindKeys: () => void;

  constructor(root: HTMLElement, private client: Client, initialReference?: string) {
    this.typeButton.addEventListener("click", () => this.pickType());
    this.privateButton.addEventListener("click", () => this.togglePrivate());
    this.query.addEventListener("input", debounce(() => void this.search(), 220));
    this.detail.addEventListener("click", event => {
      const link = (event.target as Element).closest<HTMLElement>("[data-note]");
      if (link) { event.preventDefault(); void this.open(this.resolveReference(link.dataset.note!)); }
    });
    root.append(
      h("header", { class: "bar" }, h("h1", { class: "bar-title" }, t("Knowledge"), h("span", { class: "bar-meta hide-narrow" }, t("Capture papers, sources and ideas"))),
        h("span", { class: "bar-spacer" }),
        h("button", { type: "button", class: "btn btn-primary", onclick: () => this.intent("new") }, icon("plus"), t("New note")),
        h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => { void this.search(); if (this.selected) void this.open(this.selected); } }, icon("refresh"))),
      this.split);
    this.split.append(
      h("div", { class: "list-pane" },
        h("div", { class: "list-tools", role: "search" }, h("label", { class: "search-box" }, icon("search"), this.query), this.typeButton, this.privateButton),
        this.results),
      this.detail);
    this.renderFilters();
    this.showPlaceholder();
    this.unbindKeys = listKeys(this.results, id => void this.open(id));
    void this.search();
    if (initialReference) void this.open(initialReference);
  }

  get dirty(): boolean { return this.creator?.dirty ?? false; }
  canLeave(): boolean { return this.creator?.canLeave() ?? true; }
  intent(name: string): void {
    if (name !== "new") return;
    if (this.creator?.dirty) return;
    if (this.creator?.hasPending) { this.creator.open(); return; }
    this.creator?.dispose();
    this.creator = new KnowledgeCreate(this.client, result => {
      this.query.value = ""; this.type = ""; this.renderFilters(); void this.search(); void this.open(result.id);
    });
    this.creator.open();
  }
  dispose(): void { this.creator?.dispose(); this.active = false; this.generation++; this.searchGeneration++; this.unbindKeys(); }
  open(reference: string): Promise<void> { if (!this.canLeave()) return Promise.resolve(); this.creator?.dispose(); return this.read(reference); }

  private renderFilters(): void {
    clear(this.typeButton, icon("down"), this.type ? TYPE_LABEL[this.type] ?? this.type : t("All types"));
    this.typeButton.classList.toggle("is-set", !!this.type);
    clear(this.privateButton, icon("lock"), this.includePrivate ? t("Incl. private") : t("Private"));
    this.privateButton.classList.toggle("is-set", this.includePrivate);
    this.privateButton.setAttribute("aria-pressed", String(this.includePrivate));
  }

  private pickType(): void {
    const current = NOTE_TYPES.filter(t => !LEGACY.has(t)), legacy = NOTE_TYPES.filter(t => LEGACY.has(t));
    openMenu(this.typeButton, [
      { value: "", label: t("All types"), selected: !this.type },
      ...current.map(type => ({ value: type, label: TYPE_LABEL[type] ?? type, selected: this.type === type })),
      ...legacy.map(type => ({ value: type, label: TYPE_LABEL[type] ?? type, hint: t("pre-migration"), selected: this.type === type })),
    ], value => { this.type = value; this.renderFilters(); void this.search(); });
  }

  private togglePrivate(): void {
    this.includePrivate = !this.includePrivate;
    this.renderFilters();
    // 关闭私密时：作废所有在途请求，清空列表与正文。
    this.generation++; this.searchGeneration++;
    clear(this.results); this.selected = undefined; this.showPlaceholder();
    void this.search();
  }

  private showPlaceholder(): void {
    this.split.classList.remove("has-detail");
    clear(this.detail, placeholder("knowledge", t("Select a note to read. Links inside it open here.")));
  }

  private async search(): Promise<void> {
    const generation = ++this.searchGeneration;
    const includePrivate = this.includePrivate;
    if (!this.results.childElementCount) clear(this.results, loading());
    try {
      const result = await this.client.search(this.query.value.trim(), { includePrivate, limit: 60, ...(this.type ? { type: this.type as (typeof NOTE_TYPES)[number] } : {}) });
      if (!this.active || generation !== this.searchGeneration || includePrivate !== this.includePrivate) return;
      const hits = this.type ? result.hits : result.hits.filter(hit => !LEGACY.has(hit.note.type));
      if (!hits.length) { clear(this.results, empty(this.query.value.trim() ? t("No matching notes.") : t("No notes yet."))); return; }
      clear(this.results, ...hits.map(hit => this.row(hit)));
      markSelected(this.results, this.selected);
    } catch (error) {
      if (this.active && generation === this.searchGeneration) clear(this.results, failure(t("Knowledge is unavailable: {0}", errorText(error)), () => this.search()));
    }
  }

  private row(hit: SearchResult["hits"][number]): HTMLElement {
    const id = hit.note.id ?? hit.note.path;
    return h("div", { class: "row", "data-id": id, role: "button", tabindex: "0", onclick: () => void this.read(id),
      onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter") void this.read(id); } },
      h("span", { class: "type-tag" }, TYPE_LABEL[hit.note.type] ?? hit.note.type),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, hit.note.title), hit.snippet && h("span", { class: "row-sub" }, hit.snippet)));
  }

  private async read(reference: string): Promise<void> {
    const generation = ++this.generation;
    const includePrivate = this.includePrivate;
    this.selected = reference; markSelected(this.results, reference);
    this.split.classList.add("has-detail");
    clear(this.detail, loading());
    try {
      const options = { includePrivate };
      const [note, links] = await Promise.all([this.client.show(reference, options), this.client.links(reference, options).catch(() => undefined)]);
      if (this.active && generation === this.generation && includePrivate === this.includePrivate) this.render(note, links);
    } catch (error) {
      if (this.active && generation === this.generation) clear(this.detail, failure(errorText(error)));
    }
  }

  private resolveReference(reference: string): string {
    if (!reference.endsWith(".md") || !reference.includes("/")) return reference;
    try { const base = new URL(this.currentPath, "https://vault.invalid/"); return decodeURIComponent(new URL(reference, base).pathname.slice(1)); } catch { return reference; }
  }

  private render(note: NoteDetail, links: LinksResult | undefined): void {
    this.currentPath = note.note.path;
    const fm = note.frontmatter;
    const sourceUrl = typeof fm.url === "string" ? safeExternalUrl(fm.url) : undefined;
    const kindLabel = note.note.type === "source" && fm.kind === "video" ? t("Video") : note.note.type === "source" && fm.kind === "web" ? t("Web page") : TYPE_LABEL[note.note.type] ?? note.note.type;
    const attribution = [Array.isArray(fm.authors) ? fm.authors.filter(value => typeof value === "string").join(", ") : typeof fm.author === "string" ? fm.author : "", typeof fm.year === "number" ? String(fm.year) : typeof fm.site === "string" ? fm.site : ""].filter(Boolean).join(" · ");
    const body = h("div", { class: "markdown" });
    body.innerHTML = renderMarkdown(note.body); // renderMarkdown 已转义全部原文，只生成受控标签
    const list = (title: string, items: LinksResult["outgoing"]) => h("section", {}, h("h3", {}, t("{0} ({1})", title, items.length)),
      items.length ? h("ul", {}, ...items.map(l => h("li", {}, l.note ? h("a", { href: "#", "data-note": l.note.id ?? l.note.path }, l.note.title) : h("span", { class: "muted" }, t("{0} (not found)", l.target)))))
        : h("p", { class: "muted" }, t("None")));
    clear(this.detail, h("article", { class: "reader" },
      h("div", { class: "detail-crumbs" }, h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Back to list"), onclick: () => { this.selected = undefined; markSelected(this.results, undefined); this.showPlaceholder(); } }, icon("back"))),
      h("h1", { class: "reader-title" }, note.note.title),
      h("div", { class: "reader-meta" }, h("span", { class: "pill" }, kindLabel), attribution && h("span", {}, attribution), sourceUrl && h("a", { href: sourceUrl, target: "_blank", rel: "noopener noreferrer nofollow", class: "btn btn-small" }, icon("external"), t("Open source")), note.note.citekey && h("span", { class: "pill" }, note.note.citekey), h("span", { class: "reader-path" }, note.note.path)),
      body,
      links && h("footer", { class: "backlinks" }, list(t("Links to"), links.outgoing), list(t("Linked from"), links.incoming))));
    this.detail.scrollTop = 0;
  }
}

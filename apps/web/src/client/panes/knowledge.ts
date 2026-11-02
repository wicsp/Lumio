/**
 * 知识（ADR 0026）：搜索、类型筛选、只读阅读与链接/反向链接。正文仍在外部编辑器修改。
 * 私密内容默认隐藏，需显式打开；关闭时清空已显示的详情并丢弃迟到的私密响应。
 * 旧版任务/项目/例行笔记默认不出现在「全部」里，可在类型菜单中单独查看。
 */
import { NOTE_TYPES, type NoteDetail, type LinksResult, type SearchResult } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { clear, debounce, empty, failure, h, icon, loading, openMenu, placeholder } from "../dom.ts";
import { listKeys, markSelected } from "../list-keys.ts";
import { renderMarkdown } from "../utils/markdown.ts";

const TYPE_LABEL: Record<string, string> = { paper: "论文", idea: "想法", experiment: "实验", source: "资料", post: "发布", asset: "资产", project: "旧项目", task: "旧任务", routine: "旧例行" };
const LEGACY = new Set(["project", "task", "routine"]);

export class KnowledgePane {
  private split = h("div", { class: "split" });
  private results = h("div", { class: "list-scroll" });
  private detail = h("section", { class: "detail-pane", "aria-live": "polite" });
  private query = h("input", { type: "search", name: "q", placeholder: "标题、正文、作者、citekey", autocomplete: "off" });
  private type = "";
  private includePrivate = false;
  private typeButton = h("button", { type: "button", class: "filter-btn" });
  private privateButton = h("button", { type: "button", class: "filter-btn", "aria-pressed": "false", title: "显示标记为私密的笔记" });
  private generation = 0;
  private searchGeneration = 0;
  private active = true;
  private currentPath = "";
  private selected?: string;
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
      h("header", { class: "bar" }, h("h1", { class: "bar-title" }, "知识库", h("span", { class: "bar-meta hide-narrow" }, "只读 · 正文在你的编辑器里修改")),
        h("span", { class: "bar-spacer" }),
        h("button", { type: "button", class: "icon-btn", title: "刷新", "aria-label": "刷新", onclick: () => { void this.search(); if (this.selected) void this.open(this.selected); } }, icon("refresh"))),
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

  dispose(): void { this.active = false; this.generation++; this.searchGeneration++; this.unbindKeys(); }
  open(reference: string): Promise<void> { return this.read(reference); }

  private renderFilters(): void {
    clear(this.typeButton, icon("down"), this.type ? TYPE_LABEL[this.type] ?? this.type : "全部类型");
    this.typeButton.classList.toggle("is-set", !!this.type);
    clear(this.privateButton, icon("lock"), this.includePrivate ? "含私密" : "私密");
    this.privateButton.classList.toggle("is-set", this.includePrivate);
    this.privateButton.setAttribute("aria-pressed", String(this.includePrivate));
  }

  private pickType(): void {
    const current = NOTE_TYPES.filter(t => !LEGACY.has(t)), legacy = NOTE_TYPES.filter(t => LEGACY.has(t));
    openMenu(this.typeButton, [
      { value: "", label: "全部类型", selected: !this.type },
      ...current.map(t => ({ value: t, label: TYPE_LABEL[t] ?? t, selected: this.type === t })),
      ...legacy.map(t => ({ value: t, label: TYPE_LABEL[t] ?? t, hint: "迁移前", selected: this.type === t })),
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
    clear(this.detail, placeholder("knowledge", "选择一条笔记阅读。正文里的链接可以直接跳转。"));
  }

  private async search(): Promise<void> {
    const generation = ++this.searchGeneration;
    const includePrivate = this.includePrivate;
    if (!this.results.childElementCount) clear(this.results, loading());
    try {
      const result = await this.client.search(this.query.value.trim(), { includePrivate, limit: 60, ...(this.type ? { type: this.type as (typeof NOTE_TYPES)[number] } : {}) });
      if (!this.active || generation !== this.searchGeneration || includePrivate !== this.includePrivate) return;
      const hits = this.type ? result.hits : result.hits.filter(hit => !LEGACY.has(hit.note.type));
      if (!hits.length) { clear(this.results, empty(this.query.value.trim() ? "没有找到匹配的笔记。" : "知识库里还没有笔记。")); return; }
      clear(this.results, ...hits.map(hit => this.row(hit)));
      markSelected(this.results, this.selected);
    } catch (error) {
      if (this.active && generation === this.searchGeneration) clear(this.results, failure(`知识库暂不可用：${errorText(error)}`, () => this.search()));
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
    const body = h("div", { class: "markdown" });
    body.innerHTML = renderMarkdown(note.body); // renderMarkdown 已转义全部原文，只生成受控标签
    const list = (title: string, items: LinksResult["outgoing"]) => h("section", {}, h("h3", {}, `${title}（${items.length}）`),
      items.length ? h("ul", {}, ...items.map(l => h("li", {}, l.note ? h("a", { href: "#", "data-note": l.note.id ?? l.note.path }, l.note.title) : h("span", { class: "muted" }, `${l.target}（未找到）`))))
        : h("p", { class: "muted" }, "无"));
    clear(this.detail, h("article", { class: "reader" },
      h("div", { class: "detail-crumbs" }, h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": "返回列表", onclick: () => { this.selected = undefined; markSelected(this.results, undefined); this.showPlaceholder(); } }, icon("back"))),
      h("h1", { class: "reader-title" }, note.note.title),
      h("div", { class: "reader-meta" }, h("span", { class: "pill" }, TYPE_LABEL[note.note.type] ?? note.note.type), note.note.citekey && h("span", { class: "pill" }, note.note.citekey), h("span", { class: "reader-path" }, note.note.path)),
      body,
      links && h("footer", { class: "backlinks" }, list("引用了", links.outgoing), list("被引用", links.incoming))));
    this.detail.scrollTop = 0;
  }
}

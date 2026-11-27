import { sourceTaskIntent } from "../source-task.ts";
import { observeAction } from "../usage-observations.ts";
import type { Navigate } from "../navigation.ts";
import { KnowledgeGraphView } from "../graph/knowledge.ts";
import { NoteEditor } from "../note-editor.ts";
import { NoteImageQueue } from "../note-image-queue.ts";
import { drafts } from "../drafts.ts";
import { confirmDelete, deletableRow } from "../trash-actions.ts";
import { NoteSave } from "../note-save.ts";
import { writingContext } from "../note-text.ts";
import { matchTerms } from "../note-matches.ts";
import type { KnowledgeContext, KnowledgeDocument, KnowledgeRelatedResult, ResourceRef } from "@lumio/schema";
import { KnowledgeCreate } from "./knowledge-create.ts";
import { aiNoteCard, hydrateAiEmbeds } from "../ai-note-embed.ts";
import { resourceStatusText } from "../resources.ts";
/**
 * 知识（ADR 0034、0035）：新建、实时编辑、推荐与链接/反向链接。
 * 私密内容默认隐藏，需显式打开；关闭时清空已显示的详情并丢弃迟到的私密响应。
 * 旧版任务/项目/例行笔记默认不出现在「全部」里，可在类型菜单中单独查看。
 */
import { lumioLink, NOTE_TYPES, type NoteDetail, type LinksResult, type SearchResult } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { append, clear, debounce, empty, failure, h, icon, loading, openDialog, openMenu, placeholder, highlightedText, toast, type MenuItem } from "../dom.ts";
import { noteGraph } from "../graph/data.ts";
import { relationGraph } from "../graph/view.ts";
import { listKeys, markSelected } from "../list-keys.ts";
import { renderMarkdown, safeExternalUrl } from "../utils/markdown.ts";
import { t, translated } from "../i18n.ts";
import { renderedOutline } from "../article-outline.ts";
import { SideRail, type RailEntry } from "../side-rail.ts";
import { refOf } from "../workbench-assist.ts";
import { glanceThumb } from "../glance-view.ts";

function noteImageOrigins(): ReadonlySet<string> {
  const configured = document.querySelector<HTMLMetaElement>('meta[name="lumio-image-origins"]');
  return new Set(configured?.content.split(" ").filter(Boolean));
}

const TYPE_LABEL: Record<string, string> = translated({ paper: "Paper", idea: "Idea", experiment: "Experiment", source: "Source", post: "Post", asset: "Asset", "ai-note": "AI", project: "Old project", task: "Old task", routine: "Old routine" });
const EDITABLE = new Set(["paper", "source", "idea", "experiment", "post", "ai-note"]);

function editableId(note: NoteDetail["note"]): string | undefined {
  return EDITABLE.has(note.type) && !note.path.startsWith("life/") ? note.id : undefined;
}

/**
 * 出链 / 反链（ADR 0018）。AI 笔记的链接单独列出（ADR 0053）：AI 笔记页的「链接到」是它自己写的链接；
 * 其他笔记另有「AI 笔记提到」，不混进人的反链。
 */
function linkSections(links: LinksResult): HTMLElement[] {
  const noteRows = (items: LinksResult["outgoing"]) => items.map(link => h("li", {}, link.note
    ? h("a", { href: "#", "data-note": link.note.id ?? link.note.path }, link.note.title)
    : h("span", { class: "muted" }, t("{0} (not found)", link.target))));
  const taskRows = (links.work_incoming ?? []).map(({ task }) => h("li", {},
    h("a", { href: lumioLink(task.id), class: "resource-link", "data-resource": task.id }, task.title),
    h("span", { class: "muted" }, ` · ${t("Task reference")}`)));
  const section = (title: string, rows: HTMLLIElement[]) => rows.length
    ? h("section", {}, h("h3", {}, t("{0} ({1})", title, rows.length)), h("ul", {}, ...rows)) : undefined;
  const ai = links.note.type === "ai-note";
  return [
    section(t("Links to"), noteRows(ai ? links.ai_outgoing ?? [] : links.outgoing)),
    section(t("Linked from"), [...noteRows(links.incoming), ...taskRows]),
    ...(links.ai_incoming ? [section(t("Mentioned in AI notes"), noteRows(links.ai_incoming))] : []),
  ].filter(item => item !== undefined);
}

interface NoteWritingSession {
  saver: NoteSave;
  images: NoteImageQueue;
  imageSave?: Promise<boolean>;
}

export class KnowledgePane {
  private readonly imageOrigins = noteImageOrigins();
  private graphMode = false;
  private graphHost = h("section", { class: "knowledge-graph-view", "aria-label": t("Knowledge graph"), hidden: true });
  private graphView?: KnowledgeGraphView;
  private listButton = h("button", { type: "button", "aria-pressed": "true" }, t("List"));
  private graphButton = h("button", { type: "button", "aria-pressed": "false" }, t("Graph view"));
  private listPane = h("div", { class: "list-pane" });
  private filterHost = h("div", { class: "list-tools", role: "search" });
  private split = h("div", { class: "split" });
  private results = h("div", { class: "list-scroll" });
  private detail = h("section", { class: "detail-pane", "aria-live": "polite" });
  private outlineEntries: () => RailEntry[] = () => [];
  private outline = new SideRail(this.detail, () => this.outlineEntries(), t("Article outline"), "outline");
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
  private returnPoint?: { id: string; position: number };
  private restorePoint?: { id: string; position: number };
  private async followReference(reference: string): Promise<void> {
    const id = this.displayed?.note.id;
    if (!this.editor || !id || reference === id) { await this.open(reference); return; }
    if (!(await this.beforeLeave()) || !this.active) return;
    this.returnPoint = { id, position: this.editor.position };
    await this.read(reference);
  }

  private async returnToWriting(): Promise<void> {
    const point = this.returnPoint;
    if (!point || !(await this.beforeLeave()) || !this.active) return;
    this.restorePoint = point;
    this.returnPoint = undefined;
    await this.read(point.id);
  }
  private displayed?: NoteDetail;
  private creator?: KnowledgeCreate;
  private editor?: NoteEditor;
  private titleResize?: ResizeObserver;
  private saver?: NoteSave;
  private writing?: NoteWritingSession;
  private readonly writingSessions = new Map<string, NoteWritingSession>();
  private store = drafts();
  private recoveries = new WeakMap<NoteSave, ReturnType<ReturnType<typeof drafts>["claim"]>>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private relatedTimer?: ReturnType<typeof setTimeout>;
  private relatedGeneration=0;
  private related=h("section",{class:"related-notes",hidden:true});
  private relatedHits:KnowledgeRelatedResult["hits"]=[];
  private relatedTerms:string[]=[];
  private relatedExpanded=false;
  private contextKey="";
  private linksRevision="";
  private saveStatus=h("div",{class:"note-save-status",role:"status"});
  private saveError=h("div",{class:"note-save-error"});
  private conflict=h("section",{class:"note-conflict",hidden:true});
  private unbindKeys: () => void;
  private readonly warnUnsavedImages = (event: BeforeUnloadEvent) => {
    if (![...this.writingSessions.values()].some(session => session.images.hasPending)) return;
    event.preventDefault();
    event.returnValue = "";
  };

  constructor(root: HTMLElement, private client: Client, initialReference?: string, private focusChanged?: () => void, private navigate?: Navigate) {
    this.listButton.addEventListener("click", () => this.setGraphMode(false));
    this.graphButton.addEventListener("click", () => this.setGraphMode(true));
    this.filterHost.append(h("label", { class: "search-box" }, icon("search"), this.query), this.typeButton, this.privateButton);
    this.graphView = new KnowledgeGraphView(this.graphHost, this.client, reference => void this.open(reference));
    this.typeButton.addEventListener("click", () => this.pickType());
    this.privateButton.addEventListener("click", () => this.togglePrivate());
    this.query.addEventListener("input", debounce(() => {
      if (!this.includePrivate && this.query.value.trim()) observeAction(this.query, "search", "opened");
      void this.search();
    }, 220));
    this.detail.addEventListener("click", event => {
      const link = (event.target as Element).closest<HTMLElement>("[data-note]");
      if (link) { event.preventDefault(); void this.open(this.resolveReference(link.dataset.note!)); }
    });
    root.append(
      h("header", { class: "bar" }, h("h1", { class: "bar-title" }, t("Knowledge")),
        h("div", { class: "segmented", role: "group", "aria-label": t("Knowledge view") }, this.listButton, this.graphButton,
          this.navigate && h("button", { type: "button", onclick: () => this.navigate?.("inbox") }, t("Saved sources"))),
        h("span", { class: "bar-spacer" }),
        h("button", { type: "button", class: "btn btn-primary", onclick: () => this.intent("new") }, icon("plus"), t("New note")),
        h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => { void this.search(); if (this.selected) void this.open(this.selected, true); } }, icon("refresh"))),
      this.split);
    this.listPane.append(this.filterHost, this.results, this.related);
    this.split.append(this.listPane, this.graphHost, h("div", { class: "rail-host" }, this.detail, this.outline.element));
    this.renderFilters();
    this.showPlaceholder();
    this.unbindKeys = listKeys(this.results, id => void this.open(id));
    void this.search();
    if (initialReference) void this.open(initialReference);
  }

  get dirty():boolean{return !!this.creator?.dirty||!!this.saver?.dirty;}
  /** 使用解析后的稳定 ID：路径/citekey 打开、阅读态与编辑态共用这一来源。 */
  get focus(): ResourceRef | undefined {
    if (!this.displayed) return undefined;
    const note = this.saver?.base.document.note ?? this.displayed.note;
    const ref = refOf(note.id, note.title);
    if (ref?.module !== "knowledge") return undefined;
    return { ...ref, ...(this.saver ? { revision: this.saver.base.revision } : {}) };
  }
  canLeave():boolean{this.persist();if(!this.saver?.error)void this.saver?.save();return this.creator?.canLeave()??true;}
  async beforeLeave(): Promise<boolean> {
    this.persist();
    if (this.saver?.dirty && !this.saver.error) {
      const saving = this.saver.save();
      if (!this.writing?.images.hasPending && !this.writing?.imageSave) await saving;
    }
    return this.creator?.canLeave() ?? true;
  }
  private persist(saver=this.saver):void{
    if(!saver)return;
    const recovery=this.recoveries.get(saver);
    if(saver.dirty)recovery?.write({base:saver.base,title:saver.title,body:saver.body,pending:saver.pending});else recovery?.remove();
  }
  intent(name:string):void{if(name==="new")void this.startNew();}
  private async startNew():Promise<void>{
    if(!(await this.beforeLeave())||!this.active)return;
    this.clearWriter();this.selected=undefined;this.generation++;this.split.classList.add("has-detail");
    this.creator=new KnowledgeCreate(this.client,result=>{this.creator=undefined;this.query.value="";this.type="";this.renderFilters();void this.search();void this.read(result.id);},this.detail,context=>this.recommend(context),ref=>void this.open(ref),()=>{this.clearWriter();this.showPlaceholder();},()=>{this.split.classList.toggle("show-related");this.renderRelated();});
    this.creator.open();
  }
  private clearFocus(): void {
    const hadFocus = !!this.displayed;
    this.displayed = undefined;
    if (hadFocus) this.focusChanged?.();
  }
  private clearWriter():void{this.clearFocus();this.persist();this.titleResize?.disconnect();this.titleResize=undefined;this.outlineEntries=()=>[];this.outline.refresh();clearTimeout(this.saveTimer);clearTimeout(this.relatedTimer);this.relatedGeneration++;this.contextKey="";this.relatedTerms=[];this.linksRevision="";this.split.classList.remove("show-related");this.relatedHits=[];this.related.hidden=true;clear(this.related);this.editor?.destroy();this.editor=undefined;const session=this.writing;this.writing=undefined;this.saver=undefined;if(session)this.releaseWritingSession(session);this.creator?.dispose();this.creator=undefined;}
  dispose(): void {
    this.active = false;
    this.graphView?.dispose();
    this.clearWriter();
    for (const session of this.writingSessions.values()) session.images.dispose();
    this.writingSessions.clear();
    window.removeEventListener("beforeunload", this.warnUnsavedImages);
    this.outline.dispose();
    this.generation++;
    this.searchGeneration++;
    this.unbindKeys();
  }
  async open(reference: string, reload = false): Promise<void> {
    if (!reload && reference === this.selected && this.detail.querySelector(".reader")) return;
    if (!(await this.beforeLeave()) || !this.active) return;
    this.returnPoint = this.restorePoint = undefined;
    await this.read(reference);
  }
  resume(): void { this.editor?.refreshImageSettings(); }
  liveRefresh():void{if(!this.dirty)void this.search(true);}
  private setGraphMode(graph: boolean): void {
    this.graphMode = graph;
    this.graphHost.hidden = !graph;
    this.split.classList.toggle("is-graph-view", graph);
    this.listButton.setAttribute("aria-pressed", String(!graph)); this.graphButton.setAttribute("aria-pressed", String(graph));
    this.query.closest<HTMLElement>(".search-box")!.hidden = graph;
    if (graph) this.graphHost.prepend(this.filterHost); else { this.graphView?.cancel(); this.listPane.prepend(this.filterHost); }
    void this.search();
  }

  private renderFilters(): void {
    clear(this.typeButton, icon("down"), this.type ? TYPE_LABEL[this.type] ?? this.type : t("All types"));
    this.typeButton.classList.toggle("is-set", !!this.type);
    clear(this.privateButton, icon("lock"), this.includePrivate ? t("Incl. private") : t("Private"));
    this.privateButton.classList.toggle("is-set", this.includePrivate);
    this.privateButton.setAttribute("aria-pressed", String(this.includePrivate));
  }

  private pickType(): void {
    openMenu(this.typeButton, [
      { value: "", label: t("All types"), selected: !this.type },
      ...NOTE_TYPES.map(type => ({ value: type, label: TYPE_LABEL[type] ?? type, selected: this.type === type })),
    ], value => { this.type = value; this.renderFilters(); void this.search(); });
  }

  private async togglePrivate(): Promise<void> {
    if (!(await this.beforeLeave()) || !this.active) return;
    this.clearWriter();
    this.returnPoint = this.restorePoint = undefined;
    this.includePrivate = !this.includePrivate;
    this.renderFilters();
    // 关闭私密时：作废所有在途请求，清空列表与正文。
    this.generation++; this.searchGeneration++;
    clear(this.results); this.selected = undefined; this.showPlaceholder();
    void this.search();
  }

  private showPlaceholder(): void {
    this.split.classList.remove("has-detail");
    clear(this.detail, placeholder("knowledge"));
  }

  private async search(quiet = false): Promise<void> {
    if (this.graphMode) {
      this.searchGeneration++;
      await this.graphView?.load({ include_private: this.includePrivate, ...(this.type ? { type: this.type as (typeof NOTE_TYPES)[number] } : {}) }, quiet);
      return;
    }
    const generation = ++this.searchGeneration;
    const includePrivate = this.includePrivate;
    if (!this.results.childElementCount) clear(this.results, loading());
    try {
      const result = await this.client.search(this.query.value.trim(), { includePrivate, limit: 60, ...(this.type ? { type: this.type as (typeof NOTE_TYPES)[number] } : {}) });
      if (!this.active || generation !== this.searchGeneration || includePrivate !== this.includePrivate) return;
      const hits = result.hits;
      if (!hits.length) { clear(this.results, empty(this.query.value.trim() ? t("No matching notes.") : t("No notes yet."))); return; }
      const terms = matchTerms(result.query);
      clear(this.results, ...hits.map(hit => this.row(hit, terms)));
      markSelected(this.results, this.selected);
    } catch (error) {
      if (!quiet && this.active && generation === this.searchGeneration) clear(this.results, failure(t("Knowledge is unavailable: {0}", errorText(error)), () => this.search()));
    }
  }

  private row(hit: SearchResult["hits"][number], terms: string[]): HTMLElement {
    const id = hit.note.id ?? hit.note.path;
    const openResult = () => {
      if (!this.includePrivate) observeAction(this.results, "open-result", "opened");
      void this.open(id);
    };
    const row = h("div", { class: "row", "data-id": id, role: "button", tabindex: "0", onclick: openResult,
      onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter") openResult(); } },
      h("span", { class: "type-tag" }, TYPE_LABEL[hit.note.type] ?? hit.note.type),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, highlightedText(hit.note.title, terms)), hit.snippet && h("span", { class: "row-sub" }, highlightedText(hit.snippet, terms))));
    const deletable = editableId(hit.note);
    return deletable ? deletableRow(row, hit.note.title, () => void this.deleteNote(deletable)) : row;
  }

  private async read(reference: string): Promise<void> {
    this.clearWriter();
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
    this.displayed = note;
    this.focusChanged?.();
    this.currentPath = note.note.path;
    const fm = note.frontmatter;
    const material = note.note.type === "paper" || note.note.type === "source";
    const sourceUrl = typeof fm.url === "string" ? safeExternalUrl(fm.url) : undefined;
    const kindLabel = note.note.type === "source" && fm.kind === "video" ? t("Video") : note.note.type === "source" && fm.kind === "web" ? t("Web page") : TYPE_LABEL[note.note.type] ?? note.note.type;
    const attribution = [Array.isArray(fm.authors) ? fm.authors.filter(value => typeof value === "string").join(", ") : typeof fm.author === "string" ? fm.author : "", typeof fm.year === "number" ? String(fm.year) : typeof fm.site === "string" ? fm.site : ""].filter(Boolean).join(" · ");
    const body = h("div", { class: "markdown" });
    body.innerHTML = renderMarkdown(note.body, note.note.path.startsWith("life/") ? undefined : this.imageOrigins); // renderMarkdown 已转义全部原文，只生成受控标签
    hydrateAiEmbeds(body, this.client, { open: id => void this.open(id) });
    const ai = note.note.type === "ai-note";
    const model = ai && typeof fm.model === "string" ? fm.model : "";
    const byline = attribution ? h("span", {}, attribution) : undefined;
    const back = h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Back to list"), "data-pad-back": true, onclick: async () => {
      if (!(await this.beforeLeave())) return;
      this.clearWriter(); this.selected = undefined; markSelected(this.results, undefined); this.showPlaceholder();
    } }, icon("back"));
    clear(this.detail, h("article", { class: "reader object-detail" },
      h("header", { class: "object-header" },
        h("div", { class: "object-title", tabindex: "-1", "data-pad-selection": this.selected ?? note.note.id ?? note.note.path },
          back, h("h1", { class: "reader-title" }, note.note.title)),
        h("div", { class: "object-actions" },
          this.returnPoint && this.returnPoint.id !== note.note.id && h("button", { type: "button", class: "btn btn-small", onclick: () => void this.returnToWriting() }, icon("back"), t("Return to writing")),
          material && sourceUrl && h("a", { href: sourceUrl, target: "_blank", rel: "noopener noreferrer nofollow", class: "btn btn-primary btn-small" }, icon("external"), t("Open original link")),
          note.note.id && h("button", { type: "button", class: "icon-btn", title: t("Copy ID"), "aria-label": t("Copy ID"), onclick: () => void this.copyId(note.note.id!) }, icon("link")),
          h("button", { type: "button", class: "icon-btn", title: t("More"), "aria-label": t("More"), "aria-haspopup": "listbox", "aria-expanded": "false",
            onclick: (event: Event) => this.noteActions(event.currentTarget as HTMLButtonElement, note, material) }, icon("more")))),
      h("div", { class: "reader-properties" },
        h("div", { class: "reader-meta" },
          h("span", {}, ai ? (model ? t("Written by AI ({0})", model) : t("Written by AI")) : kindLabel),
          byline, note.note.citekey && h("span", {}, note.note.citekey)),
        note.note.type === "source" && this.glanceOrigin(note, byline)),
      h("div", { class: "reader-content" }, body),
      h("footer", { class: "reader-references" }, this.sources(fm.derived_from),
        h("div", { class: "backlinks" }, ...(links ? linkSections(links) : [])))));
    this.detail.scrollTop = 0;
    this.outlineEntries = () => renderedOutline(this.detail, body); this.outline.refresh();
    if(editableId(note.note))void this.enableEditing(note);
    else this.markReadOnly();
  }

  private noteActions(anchor: HTMLButtonElement, note: NoteDetail, material: boolean): void {
    const id = note.note.id;
    const items: Array<MenuItem & { run(): void }> = [
      { value: "graph", label: t("Graph"), icon: icon("graph"), run: () => this.openGraph(id ?? note.note.path, note.note.title) },
    ];
    if (material && this.navigate && id && !note.note.path.startsWith("life/"))
      items.push({ value: "task", label: t("Create task from source"), icon: icon("plus"),
        run: () => this.navigate?.("work", "tasks", sourceTaskIntent([{ module: "knowledge", id, label: note.note.title.slice(0, 200) }])) });
    if (material) items.push({ value: "original", label: t("View archived text"), icon: icon("file"), run: () => void this.showOriginal(note) });
    if (this.editor && matchMedia("(max-width: 860px)").matches)
      items.push({ value: "related", label: t("Related notes"), icon: icon("knowledge"), run: () => {
        this.split.classList.toggle("show-related"); this.renderRelated();
      } });
    openMenu(anchor, items, value => items.find(item => item.value === value)?.run());
  }
  /**
   * 桌面小助手存的资料（ADR 0066/0067，C1-5）：原文 frontmatter 的 `glance` 记着 App、窗口与截图文件；
   * 标出来源并附截图缩略图。没有原文或不是所见生成的资料时什么都不显示。
   */
  private glanceOrigin(note: NoteDetail, byline?: HTMLElement): HTMLElement {
    const box = h("div", { class: "material-glance", hidden: true });
    const generation = this.generation;
    void Promise.resolve().then(() => this.client.showOriginal(note.note.id ?? note.note.path)).then(original => {
      const glance = original.frontmatter.glance;
      if (!glance || !this.active || generation !== this.generation) return;
      const label = [...new Set([glance.app.name, glance.window].map(value => value?.trim()).filter(Boolean))].join(" · ");
      if (byline && byline.textContent === label) byline.hidden = true;
      box.hidden = false;
      append(box,
        glance.screenshot && glanceThumb(this.client, glance.id, glance.window || glance.app.name),
        h("div", { class: "material-glance-text" },
          h("span", {}, icon("monitor"), t("Desktop helper")),
          label && h("span", { class: "muted", title: label }, label)));
    }).catch(() => { /* 没有原文（手写资料）时不显示来源 */ });
    return box;
  }

  private markReadOnly(): void { this.detail.querySelector(".reader-meta")?.append(h("span", { class: "muted" }, t("Read only"))); }

  private async showOriginal(note: NoteDetail): Promise<void> {
    const body = h("div", { class: "inbox-original markdown" }, loading());
    const generation = this.generation;
    const dialog = openDialog(t("View archived text"), body, [], { wide: true, cancelLabel: t("Close") });
    try {
      const original = await this.client.showOriginal(note.note.id ?? note.note.path);
      if (!this.active || generation !== this.generation || !dialog.open) return;
      body.innerHTML = renderMarkdown(original.body);
    } catch (cause) {
      if (this.active && generation === this.generation && dialog.open) clear(body, failure(errorText(cause)));
    }
  }
  private async copyId(id: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) {
        toast(t("Couldn't copy ID. Check clipboard permissions and try again."), "error");
        return;
      }
      await navigator.clipboard.writeText(id);
      toast(t("ID copied"));
    } catch {
      toast(t("Couldn't copy ID. Check clipboard permissions and try again."), "error");
    }
  }
  /** 来源（derived_from，ADR 0051）：ID 经 Hub 查可见标题，URL 直接打开。 */
  private sources(value: unknown): HTMLElement | undefined {
    const items = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    if (!items.length) return undefined;
    const generation = this.generation, includePrivate = this.includePrivate;
    const rows = items.map(item => {
      const external = safeExternalUrl(item);
      if (external) return h("li", {}, h("a", { href: external, target: "_blank", rel: "noopener noreferrer nofollow" }, item));
      const label = h("a", { href: "#", class: "resource-link", "data-resource": item }, item);
      const row = h("li", {}, label);
      void this.client.resource(item, { includePrivate }).then(summary => {
        if (generation !== this.generation) return;
        if (summary.status === "visible") label.textContent = summary.title;
        else { label.classList.add("is-unavailable"); row.append(h("span", { class: "muted" }, ` · ${resourceStatusText(summary.status)}`)); }
      }, () => undefined);
      return row;
    });
    return h("section", { class: "note-sources" }, h("h3", {}, t("Sources")), h("ul", {}, ...rows));
  }
  /**
   * 关系图：以这篇笔记为中心，沿出链与反链画一层或两层（只读现有链接接口）。
   * 私密开关与列表一致；点节点关闭对话框并打开那篇笔记（会先保存当前编辑）。
   */
  private openGraph(reference: string, title: string): void {
    const includePrivate = this.includePrivate;
    const DEPTH_KEY = "lumio.web.note-graph-depth";
    let depth: 1 | 2 = (() => { try { return localStorage.getItem(DEPTH_KEY) === "1" ? 1 : 2; } catch { return 2; } })();
    const area = h("div", { class: "graph-frame graph-frame-net" }, loading());
    const info = h("p", { class: "graph-hint" });
    const one = h("button", { type: "button" }, t("Direct links")), two = h("button", { type: "button" }, t("Two steps"));
    const legend = h("div", { class: "graph-legend" }, ...["paper", "idea", "source", "experiment", "post", "asset"].map(type => h("span", { class: `lg lg-kind-${type}` }, TYPE_LABEL[type] ?? type)));
    const body = h("div", { class: "form-stack" }, h("div", { class: "graph-toolbar" }, h("div", { class: "segmented segmented-small", role: "group", "aria-label": t("Depth") }, one, two), info), area, legend);
    const dialog = openDialog(t("Graph: {0}", title), body, [], { wide: true });
    dialog.classList.add("dialog-graph");
    let generation = 0;
    const draw = async () => {
      one.setAttribute("aria-pressed", String(depth === 1)); two.setAttribute("aria-pressed", String(depth === 2));
      const current = ++generation;
      clear(area, loading()); info.textContent = "";
      try {
        const graph = await noteGraph(reference, depth, ref => this.client.links(ref, { includePrivate }));
        if (current !== generation || !dialog.open) return;
        if (graph.nodes.length < 2) { clear(area, h("p", { class: "muted graph-empty" }, t("No linked notes"))); return; }
        const svg = relationGraph(graph.nodes, graph.edges, id => { dialog.close(); void this.open(id); });
        svg.setAttribute("aria-label", t("Graph of {0} notes", graph.nodes.length));
        clear(area, svg);
        info.textContent = graph.truncated ? t("{0} notes · showing part of the graph · scroll to zoom, drag to move", graph.nodes.length) : t("{0} notes · scroll to zoom, drag to move", graph.nodes.length);
      } catch (error) { if (current === generation) clear(area, failure(errorText(error), () => void draw())); }
    };
    const choose = (next: 1 | 2) => { depth = next; try { localStorage.setItem(DEPTH_KEY, String(next)); } catch { /* 只在本次显示 */ } void draw(); };
    one.addEventListener("click", () => choose(1)); two.addEventListener("click", () => choose(2));
    void draw();
  }
  private releaseWritingSession(session: NoteWritingSession): void {
    const { saver, images, imageSave } = session;
    if (this.writing === session || images.hasPending || imageSave || saver.saving || (saver.dirty && !saver.error)) return;
    const id = saver.base.document.note.id!;
    if (this.writingSessions.get(id) !== session) return;
    images.dispose();
    this.writingSessions.delete(id);
  }

  private updateImageUnloadGuard(): void {
    if ([...this.writingSessions.values()].some(session => session.images.hasPending)) {
      window.addEventListener("beforeunload", this.warnUnsavedImages);
    } else {
      window.removeEventListener("beforeunload", this.warnUnsavedImages);
    }
  }

  private writingSession(id: string, doc: KnowledgeDocument): NoteWritingSession {
    const existing = this.writingSessions.get(id);
    if (existing) return existing;

    const saver = new NoteSave(doc, this.client, () => {
      this.persist(saver);
      if (this.active && this.writing === session) this.renderSave();
      else this.releaseWritingSession(session);
    });
    const recovery = this.store.claim(`note:${id}`);
    this.recoveries.set(saver, recovery);
    const draft = recovery.read<{ base: KnowledgeDocument; title: string; body: string; pending?: NoteSave["pending"] }>();
    if (draft?.base?.document?.note?.id === id && typeof draft.title === "string" && typeof draft.body === "string") {
      saver.base = draft.base;
      saver.title = draft.title;
      saver.body = draft.body;
      saver.pending = draft.pending;
    }
    const images = new NoteImageQueue(
      (file, signal) => this.client.uploadNoteImage(id, file, signal),
      () => saver.body,
      body => saver.change(saver.title, body),
      () => {
        const mounted = this.writing === session;
        if (saver.error || (mounted && this.editor?.view.composing)) return;
        if (mounted) clearTimeout(this.saveTimer);
        const saving = saver.save();
        session.imageSave = saving;
        void saving.finally(() => {
          if (session.imageSave === saving) session.imageSave = undefined;
          this.releaseWritingSession(session);
        });
      },
      () => {
        this.releaseWritingSession(session);
        this.updateImageUnloadGuard();
      },
    );
    const session: NoteWritingSession = { saver, images };
    this.writingSessions.set(id, session);
    return session;
  }

  private async enableEditing(note:NoteDetail):Promise<void>{
    const generation=this.generation;
    try{
      const doc=await this.client.knowledgeDocument(note.note.id!);if(!this.active||generation!==this.generation)return;
      const article=this.detail.querySelector("article")!;const content=article.querySelector(".reader-content")!;
      const oldBody=content.querySelector(".markdown")!;const oldTitle=article.querySelector("h1")!;
      const title = h("textarea", { class: "reader-title note-title", rows: 1, maxlength: 500, "aria-label": t("Title") });
      title.value = doc.document.note.title;
      oldTitle.replaceWith(title);
      const fitTitle = () => {
        title.style.height = "auto";
        title.style.height = `${title.scrollHeight}px`;
      };
      let width = title.clientWidth;
      this.titleResize = new ResizeObserver(() => {
        if (title.clientWidth === width) return;
        width = title.clientWidth;
        fitTitle();
      });
      this.titleResize.observe(title);
      this.conflict=h("section",{class:"note-conflict",hidden:true});this.saveError=h("div",{class:"note-save-error"});this.saveStatus=h("div",{class:"note-save-status",role:"status"});
      const session = this.writingSession(note.note.id!, doc);
      this.writing = session;
      const { saver } = session;
      this.saver = saver;
      title.value = saver.title;
      this.linksRevision=doc.revision;
      const context=()=>writingContext(title.value,this.editor?.value??doc.document.body,this.editor?.position??0);
      this.editor=new NoteEditor({value:saver.body, imageOrigins:this.imageOrigins, imageUpload:{
        settings:()=>this.client.imageHostingSettings(), queue: session.images,
      },change:(text,position,composing)=>{this.saver!.change(title.value,text);clearTimeout(this.saveTimer);if(!composing&&!this.saver!.error)this.saveTimer=setTimeout(()=>void this.saver?.save(),800);this.recommend(writingContext(title.value,text,position));},context:()=>this.recommend(context()),
        referenceContext:position=>writingContext(title.value,this.editor!.value,position),references:(query,position)=>this.client.noteReferences({source_id:note.note.id!,query,context:writingContext(title.value,this.editor!.value,position)}),open:ref=>void this.followReference(this.resolveReference(ref)),embed:(id,label,edit)=>aiNoteCard(this.client,id,label,{open:target=>void this.open(target),edit}),save:()=>{clearTimeout(this.saveTimer);if(!this.saver?.error)void this.saver?.save();},outlineChanged:()=>this.outline.refresh()});
      const titleChanged = (composing: boolean) => {
        if (!composing && /[\r\n]/.test(title.value)) title.value = title.value.replace(/[\r\n]+/g, " ");
        fitTitle();
        this.saver!.change(title.value, this.editor!.value);
        clearTimeout(this.saveTimer);
        if (!composing && !this.saver!.error) this.saveTimer = setTimeout(() => void this.saver?.save(), 800);
        this.recommend(context());
      };
      title.addEventListener("compositionstart",()=>clearTimeout(this.saveTimer));
      title.addEventListener("input",event=>titleChanged((event as InputEvent).isComposing));
      title.addEventListener("compositionend",()=>titleChanged(false));
      title.addEventListener("keydown", event => {
        if (event.isComposing) return;
        if (event.key === "Enter") event.preventDefault();
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (!this.saver?.error) void this.saver?.save();
        }
      });
      fitTitle();
      oldBody.replaceWith(this.editor.root);
      const editor=this.editor;this.outlineEntries=()=>editor.outlineEntries();this.outline.refresh();
      editor.root.before(h("div", { class: "reader-save" }, this.saveStatus, this.saveError, this.conflict));
      this.renderSave();this.recommend(context());if(saver.dirty)void saver.save();
      if (this.restorePoint?.id === note.note.id && this.restorePoint) {
        const position = Math.min(this.restorePoint.position, editor.value.length);
        this.restorePoint = undefined;
        editor.focus(position);
        observeAction(editor.root, "return-to-writing", "succeeded");
      }
    }catch{if(this.active&&generation===this.generation)this.markReadOnly();}
  }
  private async deleteNote(id: string): Promise<void> {
    const generation = this.generation;
    const saver = this.saver?.base.document.note.id === id ? this.saver : undefined;
    if (saver) {
      clearTimeout(this.saveTimer);
      if (saver.dirty && (saver.error || !(await saver.save()))) {
        toast(t("Save or resolve your changes before deleting this note."), "error");
        return;
      }
    }
    const visible = () => this.active && generation === this.generation && this.split.isConnected && !this.split.closest("[hidden]");
    try {
      const [doc, links] = await Promise.all([
        saver?.base ?? this.client.knowledgeDocument(id),
        this.client.links(id, { includePrivate: this.includePrivate }).catch(() => undefined),
      ]);
      if (!visible() || document.querySelector("dialog[open]")) return;
      if (saver?.dirty || saver !== (this.saver?.base.document.note.id === id ? this.saver : undefined)) return;
      const incoming = links?.incoming.length ?? 0;
      confirmDelete(this.client, {
        title: t("Delete this note?"), name: doc.document.note.title,
        consequences: [t("The file moves to the vault's .trash folder."), ...(incoming ? [t("{0} notes link to it; those links will show as missing until it is restored.", incoming)] : [])],
        run: async requestId => (await this.client.deleteNote(id, { request_id: requestId, expected_revision: doc.revision })).item,
        deleted: () => {
          this.writingSessions.get(id)?.images.dispose();
          this.writingSessions.delete(id);
          this.updateImageUnloadGuard();
          if (this.active && (this.selected === id || this.selected === doc.document.note.path)) {
            this.generation++;
            this.clearWriter(); this.selected = undefined; markSelected(this.results, undefined); this.showPlaceholder();
            if (!this.split.closest("[hidden]")) history.replaceState(null, "", "#knowledge");
          }
          this.store.remove(`note:${id}`);
          if (this.active) void this.search(true);
        },
        restored: item => {
          if (!this.active) return;
          void this.search(true);
          if (saver && !this.selected && !this.creator && !this.split.closest("[hidden]")) void this.open(item.id, true);
        },
      });
    } catch (cause) {
      if (visible()) toast(errorText(cause), "error");
    }
  }
  private renderSave():void{
    const saver=this.saver;if(!saver)return;
    this.saveStatus.textContent=saver.saving?t("Saving…"):saver.error?t("Draft saved on this device"):saver.dirty?t("Unsaved changes"):"";
    if(saver.dirty&&!this.store.persistent)this.saveStatus.textContent=t("Browser storage unavailable; keep this page open until saved.");
    if(!saver.saving&&!saver.error&&!saver.dirty&&saver.base.revision!==this.linksRevision){this.linksRevision=saver.base.revision;void this.refreshLinks(saver);void this.search();}
    clear(this.saveError);if(!saver.error)return;
    const conflict=(saver.error as {reason?:string}).reason==="revision_conflict";
    this.saveError.append(failure(conflict?t("The note changed elsewhere. Your draft is kept."):errorText(saver.error)),h("button",{type:"button",class:"btn btn-small",onclick:()=>conflict?void this.compareNote():void saver.save()},conflict?t("Compare saved version"):t("Retry same save")),
      h("button",{type:"button",class:"btn btn-small",onclick:()=>{const blob=new Blob([saver.body],{type:"text/markdown;charset=utf-8"}),url=URL.createObjectURL(blob),a=h("a",{href:url,download:"note-draft.md"});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}},t("Download draft")));
  }
  private async refreshLinks(saver:NoteSave):Promise<void>{
    try{const links=await this.client.links(saver.base.document.note.id!);if(this.saver!==saver)return;
      const footer=this.detail.querySelector<HTMLElement>(".backlinks");
      if(footer)clear(footer, ...linkSections(links));
    }catch{/* A saved document remains saved if the derived links cannot refresh. */}
  }
  private async compareNote():Promise<void>{
    const saver=this.saver;if(!saver)return;
    try{const reviewed=await saver.compare();if(this.saver!==saver)return;this.conflict.hidden=false;
      clear(this.conflict,h("h3",{},t("Latest saved version")),h("strong",{},reviewed.document.note.title),h("pre",{},reviewed.document.body),h("p",{},t("Merge any changes into your draft below, then resume saving.")),
       h("button",{type:"button",class:"btn",onclick:()=>{saver.rebase(reviewed);this.conflict.hidden=true;void saver.save();}},t("I have merged; resume saving")));
    }catch(cause){clear(this.conflict,failure(errorText(cause)));this.conflict.hidden=false;}
  }
  private recommend(context:KnowledgeContext):void{
    const key=JSON.stringify(context);if(this.contextKey===key)return;const firstContext=!this.contextKey;this.contextKey=key;
    // Reserve the bottom panel before results arrive, including empty results.
    if(firstContext)this.renderRelated();
    clearTimeout(this.relatedTimer);const generation=++this.relatedGeneration;const id=this.saver?.base.document.note.id;
    this.relatedTimer=setTimeout(async()=>{try{const result=await this.client.relatedNotes({...context,...(id?{exclude_id:id}:{})});if(!this.active||generation!==this.relatedGeneration)return;this.relatedHits=result.hits;this.relatedTerms=matchTerms(context);this.renderRelated();}catch{if(this.active&&generation===this.relatedGeneration){this.relatedHits=[];this.relatedTerms=[];this.renderRelated();}}},400);
  }
  private renderRelated():void{
    this.related.hidden=!this.contextKey&&!this.split.classList.contains("show-related");clear(this.related);if(this.related.hidden)return;
    this.related.append(h("div",{class:"related-heading"},h("strong",{},t("Related notes")),h("button",{type:"button",class:"btn btn-small mobile-only",onclick:()=>{this.split.classList.remove("show-related");this.renderRelated();}},t("Back to note"))));
    if(!this.relatedHits.length)this.related.append(h("p",{class:"field-hint"},t("No matching notes.")));
    for(const hit of this.relatedHits.slice(0,this.relatedExpanded?5:3))this.related.append(h("button",{type:"button",class:"related-row",title:hit.note.title,onclick:()=>{this.split.classList.remove("show-related");void this.open(hit.note.id??hit.note.path);}},h("span",{class:"row-title"},highlightedText(hit.note.title,this.relatedTerms)),h("span",{class:"related-snippet"},hit.snippet?highlightedText(hit.snippet,this.relatedTerms):t("Title match"))));
    if(this.relatedHits.length>3)this.related.append(h("button",{type:"button",class:"btn btn-quiet",onclick:()=>{this.relatedExpanded=!this.relatedExpanded;this.renderRelated();}},this.relatedExpanded?t("Show fewer"):t("Show all {0}",this.relatedHits.length)));

  }
}

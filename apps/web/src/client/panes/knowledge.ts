import { NoteEditor } from "../note-editor.ts";
import { drafts } from "../drafts.ts";
import { NoteSave } from "../note-save.ts";
import { writingContext } from "../note-text.ts";
import { matchTerms } from "../note-matches.ts";
import type { KnowledgeContext, KnowledgeDocument, KnowledgeRelatedResult } from "@lumio/schema";
import { KnowledgeCreate } from "./knowledge-create.ts";
/**
 * 知识（ADR 0034、0035）：新建、实时编辑、推荐与链接/反向链接。
 * 私密内容默认隐藏，需显式打开；关闭时清空已显示的详情并丢弃迟到的私密响应。
 * 旧版任务/项目/例行笔记默认不出现在「全部」里，可在类型菜单中单独查看。
 */
import { NOTE_TYPES, type NoteDetail, type LinksResult, type SearchResult } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { clear, debounce, empty, failure, h, icon, loading, openMenu, placeholder, highlightedText } from "../dom.ts";
import { listKeys, markSelected } from "../list-keys.ts";
import { renderMarkdown, safeExternalUrl } from "../utils/markdown.ts";
import { t, translated } from "../i18n.ts";
import { renderedOutline } from "../article-outline.ts";
import { SideRail, type RailEntry } from "../side-rail.ts";

const TYPE_LABEL: Record<string, string> = translated({ paper: "Paper", idea: "Idea", experiment: "Experiment", source: "Source", post: "Post", asset: "Asset", project: "Old project", task: "Old task", routine: "Old routine" });
const LEGACY = new Set(["project", "task", "routine"]);

export class KnowledgePane {
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
  private creator?: KnowledgeCreate;
  private editor?: NoteEditor;
  private saver?: NoteSave;
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
        h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => { void this.search(); if (this.selected) void this.open(this.selected, true); } }, icon("refresh"))),
      this.split);
    this.split.append(
      h("div", { class: "list-pane" },
        h("div", { class: "list-tools", role: "search" }, h("label", { class: "search-box" }, icon("search"), this.query), this.typeButton, this.privateButton),
        this.results, this.related),
      h("div", { class: "rail-host" }, this.detail, this.outline.element));
    this.renderFilters();
    this.showPlaceholder();
    this.unbindKeys = listKeys(this.results, id => void this.open(id));
    void this.search();
    if (initialReference) void this.open(initialReference);
  }

  get dirty():boolean{return !!this.creator?.dirty||!!this.saver?.dirty;}
  canLeave():boolean{this.persist();if(!this.saver?.error)void this.saver?.save();return this.creator?.canLeave()??true;}
  async beforeLeave():Promise<boolean>{this.persist();if(this.saver?.dirty&&!this.saver.error)await this.saver.save();return this.creator?.canLeave()??true;}
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
  private clearWriter():void{this.persist();this.outlineEntries=()=>[];this.outline.refresh();clearTimeout(this.saveTimer);clearTimeout(this.relatedTimer);this.relatedGeneration++;this.contextKey="";this.relatedTerms=[];this.linksRevision="";this.split.classList.remove("show-related");this.relatedHits=[];this.related.hidden=true;clear(this.related);this.editor?.destroy();this.editor=undefined;this.saver=undefined;this.creator?.dispose();this.creator=undefined;}
  dispose():void{this.clearWriter();this.outline.dispose();this.active=false;this.generation++;this.searchGeneration++;this.unbindKeys();}
  async open(reference: string, reload = false): Promise<void> {
    if (!reload && reference === this.selected && this.detail.querySelector(".reader")) return;
    if (!(await this.beforeLeave()) || !this.active) return;
    await this.read(reference);
  }
  liveRefresh():void{if(!this.dirty)void this.search(true);}

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

  private async togglePrivate(): Promise<void> {
    if (!(await this.beforeLeave()) || !this.active) return;
    this.clearWriter();
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

  private async search(quiet = false): Promise<void> {
    const generation = ++this.searchGeneration;
    const includePrivate = this.includePrivate;
    if (!this.results.childElementCount) clear(this.results, loading());
    try {
      const result = await this.client.search(this.query.value.trim(), { includePrivate, limit: 60, ...(this.type ? { type: this.type as (typeof NOTE_TYPES)[number] } : {}) });
      if (!this.active || generation !== this.searchGeneration || includePrivate !== this.includePrivate) return;
      const hits = this.type ? result.hits : result.hits.filter(hit => !LEGACY.has(hit.note.type));
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
    return h("div", { class: "row", "data-id": id, role: "button", tabindex: "0", onclick: () => void this.open(id),
      onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter") void this.open(id); } },
      h("span", { class: "type-tag" }, TYPE_LABEL[hit.note.type] ?? hit.note.type),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, highlightedText(hit.note.title, terms)), hit.snippet && h("span", { class: "row-sub" }, highlightedText(hit.snippet, terms))));
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
      h("div", { class: "detail-crumbs" }, h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Back to list"), onclick: async () => { if (!(await this.beforeLeave())) return; this.clearWriter(); this.selected = undefined; markSelected(this.results, undefined); this.showPlaceholder(); } }, icon("back"))),
      h("h1", { class: "reader-title" }, note.note.title),
      h("div", { class: "reader-meta" }, h("span", { class: "pill" }, kindLabel), attribution && h("span", {}, attribution), sourceUrl && h("a", { href: sourceUrl, target: "_blank", rel: "noopener noreferrer nofollow", class: "btn btn-small" }, icon("external"), t("Open source")), note.note.citekey && h("span", { class: "pill" }, note.note.citekey)),
      body,
      links && h("footer", { class: "backlinks" }, list(t("Links to"), links.outgoing), list(t("Linked from"), links.incoming))));
    this.detail.scrollTop = 0;
    this.outlineEntries = () => renderedOutline(this.detail, body); this.outline.refresh();
    if(note.note.id && ["paper","source","idea","experiment","post"].includes(note.note.type) && !note.note.path.startsWith("life/"))void this.enableEditing(note);
    else this.detail.querySelector("article")?.append(h("p",{class:"field-hint"},t("This note is read-only here. Check its metadata or edit it in your external editor.")));
  }
  private async enableEditing(note:NoteDetail):Promise<void>{
    const generation=this.generation;
    try{
      const doc=await this.client.knowledgeDocument(note.note.id!);if(!this.active||generation!==this.generation)return;
      const article=this.detail.querySelector("article")!;const oldBody=article.querySelector(".markdown")!;const oldTitle=article.querySelector("h1")!;
      const title=h("input",{class:"reader-title note-title",value:doc.document.note.title,maxlength:500,"aria-label":t("Title")});oldTitle.replaceWith(title);
      this.conflict=h("section",{class:"note-conflict",hidden:true});this.saveError=h("div",{class:"note-save-error"});this.saveStatus=h("div",{class:"note-save-status",role:"status"});
      const saver=new NoteSave(doc,this.client,()=>{this.persist(saver);if(this.active&&generation===this.generation&&this.saver===saver)this.renderSave();});this.saver=saver;
      const recovery=this.store.claim(`note:${note.note.id}`);this.recoveries.set(saver,recovery);
      const draft=recovery.read<{base:KnowledgeDocument;title:string;body:string;pending?:NoteSave["pending"]}>();
      if(draft&&draft.base?.document?.note?.id===note.note.id&&typeof draft.title==="string"&&typeof draft.body==="string"){
        saver.base=draft.base;saver.title=draft.title;saver.body=draft.body;saver.pending=draft.pending;title.value=saver.title;
      }
      this.linksRevision=doc.revision;
      const context=()=>writingContext(title.value,this.editor?.value??doc.document.body,this.editor?.position??0);
      this.editor=new NoteEditor({value:saver.body,change:(text,position,composing)=>{this.saver!.change(title.value,text);clearTimeout(this.saveTimer);if(!composing&&!this.saver!.error)this.saveTimer=setTimeout(()=>void this.saver?.save(),800);this.recommend(writingContext(title.value,text,position));},context:()=>this.recommend(context()),
        referenceContext:position=>writingContext(title.value,this.editor!.value,position),references:(query,position)=>this.client.noteReferences({source_id:note.note.id!,query,context:writingContext(title.value,this.editor!.value,position)}),open:ref=>void this.open(this.resolveReference(ref)),save:()=>{clearTimeout(this.saveTimer);if(!this.saver?.error)void this.saver?.save();},outlineChanged:()=>this.outline.refresh()});
      const titleChanged=(composing:boolean)=>{this.saver!.change(title.value,this.editor!.value);clearTimeout(this.saveTimer);if(!composing&&!this.saver!.error)this.saveTimer=setTimeout(()=>void this.saver?.save(),800);this.recommend(context());};
      title.addEventListener("compositionstart",()=>clearTimeout(this.saveTimer));
      title.addEventListener("input",event=>titleChanged((event as InputEvent).isComposing));
      title.addEventListener("compositionend",()=>titleChanged(false));
      title.addEventListener("keydown",event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="s"){event.preventDefault();if(!event.isComposing&&!this.saver?.error)void this.saver?.save();}});
      oldBody.replaceWith(this.editor.root);const editor=this.editor;this.outlineEntries=()=>editor.outlineEntries();this.outline.refresh();article.insertBefore(this.saveStatus,this.editor.root);article.insertBefore(this.saveError,this.editor.root);article.insertBefore(this.conflict,this.editor.root);
      this.saveStatus.before(h("button",{type:"button",class:"btn btn-small mobile-only",onclick:()=>{this.split.classList.toggle("show-related");this.renderRelated();}},t("Related notes")));
      this.renderSave();this.recommend(context());if(saver.dirty)void saver.save();
    }catch{if(this.active&&generation===this.generation)this.detail.querySelector("article")?.append(h("p",{class:"field-hint"},t("This note is read-only here. Check its metadata or edit it in your external editor.")));}
  }
  private renderSave():void{
    const saver=this.saver;if(!saver)return;
    this.saveStatus.textContent=saver.saving?t("Saving…"):saver.error?t("Draft saved on this device"):saver.dirty?t("Unsaved changes"):t("Saved");
    if(saver.dirty&&!this.store.persistent)this.saveStatus.textContent=t("Browser storage unavailable; keep this page open until saved.");
    if(!saver.saving&&!saver.error&&!saver.dirty&&saver.base.revision!==this.linksRevision){this.linksRevision=saver.base.revision;void this.refreshLinks(saver);void this.search();}
    clear(this.saveError);if(!saver.error)return;
    const conflict=(saver.error as {reason?:string}).reason==="revision_conflict";
    this.saveError.append(failure(conflict?t("The note changed elsewhere. Your draft is kept."):errorText(saver.error)),h("button",{type:"button",class:"btn btn-small",onclick:()=>conflict?void this.compareNote():void saver.save()},conflict?t("Compare saved version"):t("Retry same save")),
      h("button",{type:"button",class:"btn btn-small",onclick:()=>{const blob=new Blob([saver.body],{type:"text/markdown;charset=utf-8"}),url=URL.createObjectURL(blob),a=h("a",{href:url,download:"note-draft.md"});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}},t("Download draft")));
  }
  private async refreshLinks(saver:NoteSave):Promise<void>{
    try{const links=await this.client.links(saver.base.document.note.id!);if(this.saver!==saver)return;
      let footer=this.detail.querySelector<HTMLElement>(".backlinks");if(!footer){footer=h("footer",{class:"backlinks"});this.detail.querySelector("article")?.append(footer);}
      const sections = ([[t("Links to"), links.outgoing], [t("Linked from"), links.incoming]] as const).map(([title, items]) => {
        const rows = items.map(link => h("li", {}, link.note
          ? h("a", { href: "#", "data-note": link.note.id ?? link.note.path }, link.note.title)
          : h("span", { class: "muted" }, t("{0} (not found)", link.target))));
        return h("section", {}, h("h3", {}, t("{0} ({1})", title, items.length)),
          rows.length ? h("ul", {}, ...rows) : h("p", { class: "muted" }, t("None")));
      });
      clear(footer, ...sections);
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

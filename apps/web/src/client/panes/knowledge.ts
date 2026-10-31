/**
 * 知识（ADR 0026）：搜索、类型筛选、只读正文与链接/反向链接。私密内容默认隐藏，需显式勾选；
 * 取消勾选时清空已显示的详情。正文经 renderMarkdown 转义后渲染，内部链接在工作台内跳转。
 */
import { NOTE_TYPES, type NoteDetail, type LinksResult } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { clear, empty, failure, field, h, loading, select } from "../dom.ts";
import { renderMarkdown } from "../utils/markdown.ts";

const TYPE_LABEL: Record<string, string> = { paper: "论文", idea: "想法", project: "项目（旧）", task: "任务（旧）", routine: "例行（旧）", experiment: "实验", source: "资料", post: "发布", asset: "资产" };

export class KnowledgePane {
  private results = h("div", { class: "list" });
  private detail = h("article", { class: "reader", "aria-live": "polite" }, empty("选择一条笔记阅读"));
  private query = h("input", { type: "search", name: "q", placeholder: "标题、正文、作者、citekey" });
  private type = select("type", [["", "全部类型"], ...NOTE_TYPES.map((t) => [t, TYPE_LABEL[t] ?? t] as [string, string])]);
  private priv = h("input", { type: "checkbox", name: "private" });
  private generation = 0;
  private searchGeneration = 0;
  private active=true;
  private currentPath="";
  dispose():void{this.active=false;this.generation++;this.searchGeneration++;}

  constructor(root: HTMLElement, private client: Client, initialReference?:string) {
    const form = h("form", { class: "filters", role: "search" }, field("搜索", this.query), field("类型", this.type),
      h("label", { class: "check" }, this.priv, "包含私密笔记"), h("button", { type: "submit", class: "btn" }, "搜索"));
    form.addEventListener("submit", (e) => { e.preventDefault(); void this.search(); });
    this.priv.addEventListener("change", () => { this.generation++;this.searchGeneration++;clear(this.results); clear(this.detail, empty("选择一条笔记阅读")); void this.search(); });
    this.detail.addEventListener("click", (e) => {
      const link = (e.target as Element).closest<HTMLElement>("[data-note]");
      if (link) { e.preventDefault(); void this.open(this.resolveReference(link.dataset.note!)); }
    });
    root.append(h("header", { class: "pane-head" }, h("h1", {}, "知识")), form, h("div", { class: "split" }, this.results, this.detail));
    void this.search();if(initialReference)void this.open(initialReference);
  }

  private async search(): Promise<void> {
    const generation=++this.searchGeneration;const includePrivate=this.priv.checked;
    clear(this.results, loading());
    try {
      const result = await this.client.search(this.query.value.trim(), { includePrivate, limit: 50,
        ...(this.type.value ? { type: this.type.value as (typeof NOTE_TYPES)[number] } : {}) });
      if(!this.active||generation!==this.searchGeneration||includePrivate!==this.priv.checked)return;
      if (!result.hits.length) return clear(this.results, empty("没有找到笔记"));
      clear(this.results, ...result.hits.map((hit) => h("button", { type: "button", class: "row row-button", onclick: () => this.open(hit.note.id ?? hit.note.path) },
        h("span", { class: "tag" }, TYPE_LABEL[hit.note.type] ?? hit.note.type), h("span", { class: "row-main" }, h("strong", {}, hit.note.title), h("span", { class: "muted" }, hit.snippet)))));
    } catch (error) { if(this.active&&generation===this.searchGeneration)clear(this.results, failure(`知识库暂不可用：${errorText(error)}`, () => this.search())); }
  }

  private async open(reference: string): Promise<void> {
    const generation = ++this.generation;
    clear(this.detail, loading());
    try {
      const options = { includePrivate: this.priv.checked };
      const [note, links] = await Promise.all([this.client.show(reference, options), this.client.links(reference, options).catch(() => undefined)]);
      if (this.active&&generation === this.generation) this.render(note, links);
    } catch (error) { if (this.active&&generation === this.generation) clear(this.detail, failure(errorText(error))); }
  }

  private resolveReference(reference:string):string{
    if(!reference.endsWith(".md")||!reference.includes("/"))return reference;
    try{const base=new URL(this.currentPath,"https://vault.invalid/");return decodeURIComponent(new URL(reference,base).pathname.slice(1));}catch{return reference;}
  }
  private render(note: NoteDetail, links: LinksResult | undefined): void {
    this.currentPath=note.note.path;
    const body = h("div", { class: "markdown" });
    body.innerHTML = renderMarkdown(note.body); // renderMarkdown 已转义全部原文，只生成受控标签
    const linkList = (title: string, items: LinksResult["outgoing"]) => h("section", { class: "links" }, h("h3", {}, title),
      items.length ? h("ul", {}, ...items.map((l) => h("li", {}, l.note ? h("a", { href: "#", "data-note": l.note.id ?? l.note.path }, l.note.title) : h("span", { class: "muted" }, `${l.target}（未找到）`))))
        : h("p", { class: "muted" }, "无"));
    clear(this.detail, h("h2", {}, note.note.title), h("p", { class: "muted" }, `${TYPE_LABEL[note.note.type] ?? note.note.type} · ${note.note.path}`), body,
      links && linkList("链接到", links.outgoing), links && linkList("被链接", links.incoming));
  }
}

import { Compartment, EditorState, Prec, StateField, type Range } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { autocompletion, completionKeymap, selectedCompletion, closeCompletion, pickedCompletion, type Completion } from "@codemirror/autocomplete";
import type { KnowledgeReferencesResult, KnowledgeContext } from "@lumio/schema";
import { h, clear, highlightedText } from "./dom.ts";
import { matchTerms, matchRanges } from "./note-matches.ts";
import { t } from "./i18n.ts";
import { renderMarkdown, renderInline, renderMath, renderRichBlock } from "./utils/markdown.ts";
import { richBlocks, inlineMath, escapedAt } from "./utils/markdown-extra.ts";
import { footnotes, referenceTrigger, insertReference, protectedText } from "./note-text.ts";
import { chineseQuoteInput, chineseQuoteChange } from "./note-input.ts";
type Hit = KnowledgeReferencesResult["hits"][number];
type ReferenceCompletion = Completion & { hit: Hit; terms: string[] };
interface Options {
    value: string;
    change: (text: string, position: number, composing: boolean) => void;
    context: (position: number) => void;
    references?: (query: string, position: number) => Promise<KnowledgeReferencesResult>;
    referenceContext?: (position: number) => KnowledgeContext;
    open: (reference: string) => void;
    save?: () => void;
}
class InlineWidget extends WidgetType {
    constructor(private html: string, private activate: (view: EditorView, event: MouseEvent) => void, private className = "", private preview?: (anchor: HTMLElement) => void) { super(); }
    override eq(other: InlineWidget): boolean { return this.html === other.html && this.className === other.className && this.activate === other.activate; }
    toDOM(view: EditorView): HTMLElement { const el = h("span", { class: this.className }); el.innerHTML = this.html; el.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.activate(view, event); }); if (this.preview) {
        el.addEventListener("mouseenter", () => this.preview!(el));
        el.addEventListener("focusin", () => this.preview!(el));
    } return el; }
    override ignoreEvent(): boolean { return true; }
}
class HiddenDefinition extends WidgetType {
    toDOM(): HTMLElement { return h("div", { class: "note-definition-hidden", "aria-hidden": "true" }); }
    override get estimatedHeight(): number { return 0; }
}
class RichPreview extends WidgetType {
    constructor(private html: string, private block: boolean, private label: string, private edit: (event: MouseEvent | KeyboardEvent) => void, private preview?: (anchor: HTMLElement) => void) { super(); }
    toDOM(): HTMLElement {
        const element: HTMLElement = h(this.block ? "div" : "span", { class: "note-rich-preview markdown", tabindex: "0", "aria-label": this.label });
        element.innerHTML = this.html;
        element.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.edit(event); });
        element.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); this.edit(event); } });
        element.addEventListener("mouseover", event => { const link = (event.target as Element).closest<HTMLElement>("[data-note]"); if (link) this.preview?.(link); });
        element.addEventListener("focusin", event => { const link = (event.target as Element).closest<HTMLElement>("[data-note]"); if (link) this.preview?.(link); });
        return element;
    }
    override ignoreEvent(): boolean { return true; }
}
export class NoteEditor {
    readonly root = h("section", { class: "live-note" });
    readonly view: EditorView;
    private editor = h("div", { class: "live-note-surface" });
    private refs = h("section", { class: "note-references" });
    private card = h("aside", { class: "note-reference-card", hidden: true });
    private help = h("div", { class: "note-reference-help", hidden: true, role: "status" });
    private message = h("span", {});
    private lock = new Compartment();
    private active = true;
    private callbackMuted = false;
    private queryGeneration = 0;
    private targets = new Map<string, string>();
    private referenceAnchor?: HTMLElement;
    private hideCardTimer?: ReturnType<typeof setTimeout>;
    private hideCard = () => { clearTimeout(this.hideCardTimer); this.hideCardTimer = undefined; this.card.hidden = true; this.referenceAnchor = undefined; };
    private dismissCard = (event: Event) => {
        if (this.card.hidden) return;
        const target = event.target as Node;
        if (this.card.contains(target) || this.referenceAnchor?.contains(target)) { clearTimeout(this.hideCardTimer); this.hideCardTimer = undefined; return; }
        if (event.type === "pointerdown") this.hideCard();
        else if (!this.hideCardTimer && !this.card.contains(document.activeElement) && !this.referenceAnchor?.contains(document.activeElement)) this.hideCardTimer = setTimeout(this.hideCard, 180);
    };
    private cardKey = (event: KeyboardEvent) => { if (event.key === "Escape") this.hideCard(); };
    constructor(private options: Options) {
        this.root.append(this.editor, this.help, this.card, this.refs);
        document.addEventListener("pointermove", this.dismissCard);
        document.addEventListener("pointerdown", this.dismissCard);
        document.addEventListener("keydown", this.cardKey);
        window.addEventListener("resize", this.hideCard);
        const insert = h("button", { type: "button", class: "btn btn-small", onclick: () => this.applySelectedFootnote(), title: "Shift+Enter" }, t("Insert superscript reference"));
        insert.addEventListener("mousedown", event => event.preventDefault());
        this.help.append(this.message, insert);
        const field = StateField.define<DecorationSet>({ create: state => this.decorate(state), update: (value, tr) => tr.docChanged || tr.selection ? this.decorate(tr.state) : value, provide: f => EditorView.decorations.from(f) });
        this.view = new EditorView({ parent: this.editor, state: EditorState.create({ doc: options.value, extensions: [
                    this.lock.of(EditorState.readOnly.of(false)), EditorView.contentAttributes.of({ "aria-label": t("Note body"), spellcheck: "true" }),
                    EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name="lumio-style-nonce"]')?.content ?? ""),
                    history(), markdown(), chineseQuoteInput, EditorView.lineWrapping, field,
                    Prec.highest(keymap.of([{ key: "Mod-s", run: () => { if (this.view.composing)
                                return false; options.save?.(); return true; } }, { key: "Shift-Enter", run: () => this.applySelectedFootnote() }, ...completionKeymap.map(binding => ({ ...binding, run: binding.run ? ((view: EditorView) => view.composing ? false : binding.run!(view)) : undefined }))])),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    autocompletion({ interactionDelay: 0, override: [async (ctx) => {
                                const trigger = referenceTrigger(ctx.state.doc.toString(), ctx.pos);
                                if (!trigger || !options.references || !options.referenceContext || this.view?.composing)
                                    return null;
                                const generation = ++this.queryGeneration;
                                const terms = matchTerms(trigger.query.trim() || options.referenceContext(ctx.pos));
                                this.help.hidden = false;
                                this.message.textContent = trigger.query ? t("Searching: {0}", trigger.query) : t("Related to this paragraph");
                                try {
                                    const result = await options.references(trigger.query, ctx.pos);
                                    if (ctx.aborted || !this.active || generation !== this.queryGeneration)
                                        return null;
                                    for (const hit of result.hits) {
                                        const rendered = h("span", {});
                                        rendered.innerHTML = renderInline(hit.insert_text);
                                        const target = rendered.querySelector<HTMLElement>("[data-note]")?.dataset.note;
                                        if (target)
                                            this.targets.set(target, hit.note.id ?? hit.note.path);
                                    }
                                    this.message.textContent = result.hits.length ? (trigger.query ? t("Search: {0}", trigger.query) : t("Related to this paragraph")) : t("No matches. Type to search titles and content.");
                                    return { from: trigger.from, to: trigger.to, filter: false,
                                        getMatch: (completion: Completion) => matchRanges(completion.label, terms).flat(),
                                        options: result.hits.map(hit => ({ label: hit.note.title, detail: hit.note.type + (hit.insert_text.startsWith("[[") ? "" : " · " + t("Path reference")), info: hit.note.path, hit, terms,
                                            apply: (view: EditorView, completion: Completion) => this.apply(hit, false, completion),
                                        } as ReferenceCompletion)) };
                                }
                                catch {
                                    if (this.active && generation === this.queryGeneration)
                                        this.message.textContent = t("References unavailable. Keep writing and try again.");
                                    return null;
                                }
                            }], defaultKeymap: false, activateOnTypingDelay: 180, maxRenderedOptions: 10, icons: false, addToOptions: [{ position: 90, render: completion => {
                                const item = completion as ReferenceCompletion;
                                return h("span", { class: "note-completion-snippet" }, item.hit.snippet ? highlightedText(item.hit.snippet, item.terms) : t("Title match"));
                            } }] }),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged && !this.callbackMuted)
                            options.change(update.state.doc.toString(), update.state.selection.main.head, update.view.composing);
                        if (update.docChanged || update.selectionSet) {
                            options.context(update.state.selection.main.head);
                            this.help.hidden = !referenceTrigger(update.state.doc.toString(), update.state.selection.main.head);
                        }
                        if (update.docChanged)
                            queueMicrotask(() => { if (this.active)
                                this.renderReferences(); });
                    }), EditorView.domEventHandlers({ compositionstart: () => { options.change(this.value, this.position, true); return false; }, compositionend: () => { queueMicrotask(() => { if (this.active) {
                            const change = !this.view.state.readOnly && chineseQuoteChange(this.view.state.doc, this.position);
                            if (change) this.view.dispatch({ changes: change, userEvent: "input.type" });
                            options.change(this.value, this.position, false);
                        } }); return false; } }),
                ] }) });
        this.renderReferences();
    }
    get value(): string { return this.view.state.doc.toString(); }
    get position(): number { return this.view.state.selection.main.head; }
    setValue(text: string): void { if (text === this.value)
        return; this.callbackMuted = true; this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text }, selection: { anchor: 0 } }); this.callbackMuted = false; }
    setReadOnly(locked: boolean): void { this.view.dispatch({ effects: this.lock.reconfigure(EditorState.readOnly.of(locked)) }); }
    focus(position = this.position): void { this.view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position) }); this.view.focus(); }
    destroy(): void {
        this.active = false; this.queryGeneration++; this.hideCard(); this.view.destroy();
        document.removeEventListener("pointermove", this.dismissCard);
        document.removeEventListener("pointerdown", this.dismissCard);
        document.removeEventListener("keydown", this.cardKey);
        window.removeEventListener("resize", this.hideCard);
    }
    private applySelectedFootnote(): boolean { if (this.view.composing || this.view.state.readOnly)
        return false; const selected = selectedCompletion(this.view.state) as Completion & {
        hit?: Hit;
    } | null; if (!selected?.hit)
        return false; this.apply(selected.hit, true, selected); return true; }
    private apply(hit: Hit, asFootnote: boolean, completion: Completion): void {
        const trigger = referenceTrigger(this.value, this.position);
        if (!trigger || this.view.composing || this.view.state.readOnly)
            return;
        const result = insertReference(this.value, trigger, hit.insert_text, asFootnote);
        this.view.dispatch({ changes: result.changes, selection: { anchor: result.cursor }, annotations: pickedCompletion.of(completion), userEvent: "input.complete" });
        closeCompletion(this.view);
        this.view.focus();
    }
    private decorate(state: EditorState): DecorationSet {
        const text = state.doc.toString(), model = footnotes(text), ranges: Range<Decoration>[] = [], blocked = protectedText(text);
        const selected = (from: number, to: number) => state.selection.ranges.some(selection => selection.from <= to && selection.to >= from);
        const add = (from: number, to: number, deco: Decoration) => { if (to > from)
            ranges.push(deco.range(from, to)); };
        const isBlocked = (from: number) => blocked.some(r => from >= r.from && from < r.to);
        const blocks = richBlocks(text), formulas = inlineMath(text, blocks), previews: Array<{ from: number; to: number }> = [];
        const formulaRanges = [...formulas, ...blocks.filter(block => block.kind === "math")];
        const preview = (from: number, to: number, html: string, block: boolean, label: string) => {
            if (selected(from, to) || model.definitions.some(def => from >= def.from && from < def.to)) return;
            add(from, to, Decoration.replace({ block, widget: new RichPreview(html, block, label, event => {
                const target = (event.target as Element).closest<HTMLElement>("[data-note]");
                if (target) this.openReference(target.dataset.note!);
                else this.focus(from);
            }, anchor => this.showLink(anchor.outerHTML, from, anchor, true)) }));
            previews.push({ from, to });
        };
        for (const block of blocks) preview(block.from, block.to, renderRichBlock(block, text), true, t(block.kind === "table" ? "Edit table" : "Edit formula"));
        for (const formula of formulas) {
            const html = renderMath(formula.tex, formula.display);
            if (html) preview(formula.from, formula.to, html, false, t("Edit formula"));
        }
        const opaque = [...previews, ...formulaRanges];
        const inPreview = (from: number, to = from + 1) => previews.some(range => from < range.to && to > range.from);
        const inFormula = (from: number, to = from + 1) => formulaRanges.some(range => from < range.to && to > range.from);
        syntaxTree(state).iterate({ enter: node => {
                if (opaque.some(range => node.from >= range.from && node.to <= range.to)) return false;
                const name = node.name;
                if (/^ATXHeading[1-6]$/.test(name))
                    ranges.push(Decoration.line({ class: "note-heading note-h" + name.at(-1) }).range(state.doc.lineAt(node.from).from));
                if (name === "Blockquote")
                    ranges.push(Decoration.line({ class: "note-quote" }).range(state.doc.lineAt(node.from).from));
                if (name === "StrongEmphasis")
                    add(node.from, node.to, Decoration.mark({ class: "note-strong" }));
                if (name === "Emphasis")
                    add(node.from, node.to, Decoration.mark({ class: "note-emphasis" }));
                if (name === "InlineCode")
                    add(node.from, node.to, Decoration.mark({ class: "note-code" }));
                if (name === "FencedCode")
                    for (let line = state.doc.lineAt(node.from).number; line <= state.doc.lineAt(node.to).number; line++)
                        ranges.push(Decoration.line({ class: "note-code-block" }).range(state.doc.line(line).from));
                if (name === "ListMark" && !selected(node.node.parent?.from ?? node.from, node.node.parent?.to ?? node.to) && /^[-+*]$/.test(text.slice(node.from, node.to))) {
                    const from = node.from;
                    add(from, node.to, Decoration.replace({ widget: new InlineWidget("•", view => { view.dispatch({ selection: { anchor: from } }); view.focus(); }, "note-list-mark") }));
                }
                if (["HeaderMark", "EmphasisMark", "CodeMark", "QuoteMark"].includes(name) && !selected(node.node.parent?.from ?? node.from, node.node.parent?.to ?? node.to))
                    add(node.from, node.to, Decoration.replace({}));
            } });
        for (const m of text.matchAll(/\[\[[^\]\n]+\]\]|【【[^】\n]+】】|(?<!!)\[[^\]\n]+\]\([^\s)]+\)/g)) {
            if (escapedAt(text, m.index) || isBlocked(m.index) || inPreview(m.index) || inFormula(m.index, m.index + m[0].length) || selected(m.index, m.index + m[0].length) || model.definitions.some(d => m.index >= d.from && m.index < d.to))
                continue;
            const from = m.index;
            const html = renderInline(m[0]);
            add(from, from + m[0].length, Decoration.replace({ widget: new InlineWidget(html, (view, event) => {
                const target = (event.target as Element).closest<HTMLElement>("[data-note]");
                if (target) { this.hideCard(); this.openReference(target.dataset.note!); }
                else { view.dispatch({ selection: { anchor: from + 2 } }); view.focus(); }
            }, "note-inline-link", anchor => { if (anchor.querySelector("[data-note]")) this.showLink(html, from, anchor, true); }) }));
        }
        for (const ref of model.references) {
            if (inPreview(ref.from) || inFormula(ref.from) || selected(ref.from, ref.to))
                continue;
            const previous = model.references.find(r => r.to === ref.from);
            add(ref.from, ref.to, Decoration.replace({ widget: new InlineWidget(`${previous ? "," : ""}<sup><button type="button" aria-label="${t("Reference {0}", ref.number)}">${ref.number}</button></sup>`, (_view, event) => this.activateReference(ref.label, event.currentTarget as HTMLElement), "note-footnote-mark", anchor => this.showReference(ref.label, anchor)) }));
        }
        for (const def of model.definitions)
            if (!selected(def.from, def.to))
                add(def.from, def.to, Decoration.replace({ widget: new HiddenDefinition(), block: true }));
        return Decoration.set(ranges, true);
    }
    private activateReference(label: string, anchor: HTMLElement): void {
        const def = footnotes(this.value).definitions.find(d => d.label === label);
        const content = h("div", {}); content.innerHTML = def ? renderMarkdown(def.text) : "";
        const links = content.querySelectorAll<HTMLElement>("[data-note]");
        if (links.length === 1) { this.hideCard(); this.openReference(links[0]!.dataset.note!); }
        else this.showReference(label, anchor);
    }
    private showReference(label: string, anchor?: HTMLElement): void {
        clearTimeout(this.hideCardTimer); this.hideCardTimer = undefined;
        this.referenceAnchor = anchor;
        const model = footnotes(this.value), def = model.definitions.find(d => d.label === label);
        this.card.hidden = false;
        const content = h("div", { class: "markdown" });
        content.innerHTML = def ? renderMarkdown(def.text) : "";
        clear(this.card, h("strong", {}, t("Reference")), def ? content : h("p", {}, t("Missing footnote definition: {0}", label)), def && h("button", { type: "button", class: "btn btn-small", onclick: () => { this.hideCard(); this.focus(def.from + 1); } }, t("Edit footnote")), h("button", { type: "button", class: "btn btn-small", onclick: this.hideCard }, t("Close")));
        this.bindLinks(content);
        this.card.setAttribute("role", "dialog"); this.card.setAttribute("aria-label", t("Reference"));
        const rect = (anchor ?? this.view.dom).getBoundingClientRect();
        this.card.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - this.card.offsetWidth - 12))}px`;
        this.card.style.top = `${Math.max(12, rect.bottom + 8 + this.card.offsetHeight > window.innerHeight - 12 ? rect.top - this.card.offsetHeight - 8 : rect.bottom + 8)}px`;
    }
    private showLink(source: string, from: number, anchor: HTMLElement, rendered = false): void {
        clearTimeout(this.hideCardTimer); this.hideCardTimer = undefined; this.referenceAnchor = anchor;
        const content = h("div", {class:"markdown"}); content.innerHTML = rendered ? source : renderInline(source);
        this.card.hidden = false;
        clear(this.card, h("strong", {}, t("Reference")), content,
            h("button", {type:"button",class:"btn btn-small",onclick:()=>{this.hideCard();this.focus(from+2);}}, t("Edit reference")),
            h("button", {type:"button",class:"btn btn-small",onclick:this.hideCard}, t("Close")));
        this.bindLinks(content); this.card.setAttribute("role","dialog"); this.card.setAttribute("aria-label",t("Reference"));
        const rect=anchor.getBoundingClientRect();
        this.card.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-this.card.offsetWidth-12))}px`;
        this.card.style.top=`${Math.max(12,rect.bottom+8+this.card.offsetHeight>window.innerHeight-12?rect.top-this.card.offsetHeight-8:rect.bottom+8)}px`;
    }
    private openReference(reference: string): void { this.options.open(this.targets.get(reference) ?? reference); }
    private bindLinks(el: HTMLElement): void { el.addEventListener("click", event => { const link = (event.target as Element).closest<HTMLElement>("[data-note]"); if (link) {
        event.preventDefault();
        event.stopPropagation();
        this.openReference(link.dataset.note!);
    } }); }
    private renderReferences(): void {
        const model = footnotes(this.value), labels = [...new Set(model.references.map(r => r.label))];
        this.refs.hidden = !labels.length && !model.issues.length;
        clear(this.refs);
        if (this.refs.hidden)
            return;
        this.refs.append(h("h3", {}, t("References")));
        for (const label of labels) {
            const ref = model.references.find(r => r.label === label)!, def = model.definitions.find(d => d.label === label), content = h("div", { class: "markdown" });
            content.innerHTML = def ? renderMarkdown(def.text) : "";
            this.bindLinks(content);
            const row = h("div", { class: "note-reference-row" }, h("button", { type: "button", class: "btn btn-small", onclick: event => this.showReference(label, event.currentTarget as HTMLElement) }, String(ref.number)), def ? content : h("span", {}, t("Missing footnote definition: {0}", label)));
            model.references.filter(r => r.label === label).forEach((r, i) => row.append(h("button", { type: "button", class: "btn btn-quiet", onclick: () => this.focus(r.from), "aria-label": t("Back to reference {0}", i + 1) }, "↩")));
            this.refs.append(row);
        }
        if (model.issues.length)
            this.refs.append(h("p", { class: "field-hint" }, t("Check footnotes (missing, duplicate or unused): {0}", model.issues.join(", "))));
        for (const def of model.definitions.filter(d => !labels.includes(d.label)))
            this.refs.append(h("div", { class: "note-unused-reference" }, h("span", {}, def.label), h("button", { type: "button", class: "btn btn-small", onclick: () => this.showReference(def.label) }, t("Edit footnote")), h("button", { type: "button", class: "btn btn-small", onclick: () => { if (this.view.state.readOnly || !confirm(t("Remove this unused footnote and its text?")))
                    return; this.view.dispatch({ changes: { from: def.from, to: def.to, insert: "" }, userEvent: "delete" }); } }, t("Remove unused footnote"))));
    }
}

/** Four-type authoring dialog, based on Claude's draft; only this view owns its draft and save attempt. */
import type { KnowledgeCreateResult, KnowledgeNoteKind } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { clear, failure, field, h, icon, loading, openDialog, select, toast } from "../dom.ts";
import { newRequestId } from "../commands.ts";
import { lang, t } from "../i18n.ts";
import { renderMarkdown } from "../utils/markdown.ts";
import { NoteDraft, importEmptyFields, type NoteFields } from "../knowledge-draft.ts";

export class KnowledgeCreate {
  private dialog?: HTMLDialogElement;
  private state = new NoteDraft();
  private kind: KnowledgeNoteKind = "paper";
  private generation = 0;
  private importing = false;
  private ready = false;
  private form = h("form", { class: "form-stack knowledge-form", id: newRequestId("note-form") });
  private fields = h("div", { class: "form-stack" });
  private typeCards = h("div", { class: "note-types", role: "group", "aria-label": t("Note type") });
  private error = h("div", { role: "alert" });
  private importNotice = h("div", { role: "status" });
  private body = h("textarea", { name: "body", rows: 14, class: "note-body", "aria-label": t("Note body"), placeholder: t("Write your notes in Markdown…") });
  private preview = h("div", { class: "markdown note-preview", hidden: true });
  private writeButton = h("button", { type: "button", class: "btn btn-small", "aria-pressed": "true", onclick: () => this.previewMode(false) }, t("Write"));
  private previewButton = h("button", { type: "button", class: "btn btn-small", "aria-pressed": "false", onclick: () => this.previewMode(true) }, t("Preview"));
  private save = h("button", { type: "submit", form: this.form.id, class: "btn btn-primary", disabled: true }, t("Create note"));
  constructor(private client: Client, private onSaved: (result: KnowledgeCreateResult) => void) {}

  open(): void {
    if (this.dialog?.open) return;
    if (this.dialog && this.state.pending) { document.body.append(this.dialog); this.dialog.showModal(); return; }
    this.form.append(this.typeCards, this.fields,
      h("section", { class: "form-stack" }, h("div", { class: "note-body-bar" }, h("strong", {}, t("Note body")), this.writeButton, this.previewButton), this.body, this.preview),
      h("p", { class: "field-hint" }, t("Write the full note here before saving. Editing saved notes will come in a later update.")), this.error);
    this.dialog = openDialog(t("New note"), this.form, [this.save], { wide: true });
    this.dialog.classList.add("knowledge-dialog");
    // Capture first: do not let the shared dialog close while a save is in flight.
    this.dialog.addEventListener("cancel", event => { if (this.state.saving) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    this.dialog.addEventListener("click", event => { if (this.state.saving && (event.target === this.dialog || (event.target as Element).closest(".dialog-head button,.dialog-foot button:not([type=submit])"))) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    this.dialog.addEventListener("close", () => { this.generation++; });
    this.form.addEventListener("invalid", event => { (event.target as Element).closest("details")?.setAttribute("open", ""); }, true);
    this.form.addEventListener("input", event => {
      if ((event.target as HTMLInputElement).name === "authors") {
        const family = this.form.querySelector<HTMLInputElement>("input[name=firstAuthorFamily]"); if (family) family.value = "";
      }
      this.state.changed = true; this.capture();
    });
    this.form.addEventListener("submit", event => { event.preventDefault(); void this.submit(); });
    this.renderFields(); this.renderTypes();
    void this.loadTemplates();
  }
  dispose(): void { this.generation++; this.dialog?.close(); this.dialog?.remove(); }
  get hasPending(): boolean { return !!this.state.pending; }
  get dirty(): boolean { return !!this.dialog?.open && (this.state.changed || !!this.state.pending || this.state.saving); }
  canLeave(): boolean { return !this.state.saving && (!this.dirty || confirm(t("You have unsaved changes. Close anyway?"))); }
  private async loadTemplates(): Promise<void> {
    const generation = this.generation;
    clear(this.error, loading(t("Preparing note templates…")));
    this.controls(true);
    try {
      const templates = await Promise.all((["paper", "video", "web", "idea"] as const).map(kind => this.client.knowledgeTemplate({ kind, locale: lang() })));
      if (!this.dialog?.open || generation !== this.generation) return;
      for (const template of templates) this.state.set(template.kind, { body: template.body });
      this.ready = true; this.renderFields(); this.body.value = this.state.fields.get(this.kind)!.body!;
      clear(this.error); this.controls(false);
    } catch (cause) {
      if (!this.dialog?.open || generation !== this.generation) return;
      clear(this.error, failure(errorText(cause), () => void this.loadTemplates()));
      // Saving stays disabled until the Hub confirms that knowledge authoring is available.
    }
  }
  private capture(): NoteFields {
    const values: NoteFields = {};
    for (const control of this.form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[name]")) values[control.name] = control.value;
    this.state.set(this.kind, values); return values;
  }
  private renderTypes(): void {
    const types: Array<[KnowledgeNoteKind, string, string]> = [["paper", t("Paper"), "knowledge"], ["video", t("Video"), "play"], ["web", t("Web page"), "globe"], ["idea", t("Idea"), "memory"]];
    clear(this.typeCards, ...types.map(([kind, label, glyph]) => h("button", { type: "button", class: "note-type", "aria-pressed": String(kind === this.kind), onclick: () => this.switchType(kind) }, icon(glyph), label)));
  }
  private switchType(kind: KnowledgeNoteKind): void {
    if (kind === this.kind || !this.ready || this.state.pending || this.state.saving) return;
    this.capture(); this.generation++; this.importing = false; this.kind = kind;
    this.renderTypes(); this.renderFields(); this.body.value = this.state.fields.get(kind)?.body ?? "";
    this.previewMode(false); clear(this.error); this.controls(false);
  }
  private renderFields(): void {
    const draft = this.state.fields.get(this.kind) ?? {};
    const input = (name: string, type = "text", required = false) => h("input", { type, name, required, value: draft[name] ?? "", autocomplete: "off", ...(name === "title" ? { maxlength: 500 } : {}), ...(type === "number" ? { min: 1000, max: 9999, step: 1 } : {}) });
    const status = () => field(t("Reading status"), select("status", [["to-read", t("To read")], ["reading", t("Reading")], ["read", t("Read")]], draft.status ?? "to-read"));
    const title = field(t("Title"), input("title", "text", true));
    const tags = field(t("Tags"), input("tags"), t("Separate tags with commas."));
    if (this.kind === "paper") {
      const source = input("paper_input"); source.placeholder = t("arXiv ID, DOI or paper link");
      const importButton = h("button", { type: "button", class: "btn", "data-import": true, onclick: () => void this.importPaper() }, icon("download"), t("Import metadata"));
      const bibtex = h("textarea", { name: "bibtex", rows: 4 }); bibtex.value = draft.bibtex ?? "";
      clear(this.importNotice);
      clear(this.fields, input("firstAuthorFamily", "hidden"),
        field(t("Import a paper"), h("div", { class: "note-import" }, source, importButton), t("Import fills empty fields only. You can also enter everything manually.")), this.importNotice,
        title, field(t("Authors"), input("authors", "text", true), t("Separate author names with commas.")), field(t("Year"), input("year", "number", true)),
        h("details", { class: "note-optional" }, h("summary", {}, t("Optional fields")), h("div", { class: "form-stack" },
          tags, status(), field(t("Venue"), input("venue")), field(t("DOI"), input("doi")), field(t("arXiv ID"), input("arxiv")),
          field(t("Source URL"), input("url", "url")), field(t("BibTeX"), bibtex, t("Appended to the note with its generated citation key.")))));
    } else if (this.kind === "idea") clear(this.fields, title, tags);
    else clear(this.fields, title, field(this.kind === "video" ? t("Video link") : t("Page link"), input("url", "url"), t("Optional; you can add it later in your editor.")),
      h("details", { class: "note-optional" }, h("summary", {}, t("Optional fields")), h("div", { class: "form-stack" },
        field(t("Author or creator"), input("author")), field(t("Site or platform"), input("site")), tags, status())));
  }
  private previewMode(show: boolean): void {
    this.body.hidden = show; this.preview.hidden = !show;
    this.writeButton.setAttribute("aria-pressed", String(!show)); this.previewButton.setAttribute("aria-pressed", String(show));
    if (show) this.preview.innerHTML = renderMarkdown(this.body.value);
  }
  private controls(lock: boolean): void {
    for (const control of this.form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>("input,textarea,select,button")) {
      if (control instanceof HTMLTextAreaElement) { control.readOnly = lock; control.disabled = false; }
      else control.disabled = lock;
    }
    this.writeButton.disabled = false; this.previewButton.disabled = false;
    this.save.disabled = !this.ready || this.state.saving || this.importing;
    this.save.textContent = this.state.saving ? t("Saving…") : this.state.pending ? t("Retry same save") : t("Create note");
    this.body.readOnly = lock;
  }
  private async importPaper(): Promise<void> {
    if (this.importing || this.state.pending) return;
    const input = this.capture().paper_input?.trim(); if (!input) { clear(this.importNotice, failure(t("Enter an arXiv ID, DOI or paper link first."))); return; }
    const generation = this.generation;
    this.importing = true; this.save.disabled = true;
    const button = this.fields.querySelector<HTMLButtonElement>("[data-import]")!; button.disabled = true;
    clear(this.importNotice, loading(t("Importing paper metadata…")));
    try {
      const metadata = await this.client.resolvePaper({ input });
      if (!this.dialog?.open || generation !== this.generation || this.kind !== "paper") return;
      if (this.capture().paper_input?.trim() !== input) { clear(this.importNotice, failure(t("The paper input changed. Import again to use the new source."))); return; }
      this.state.set("paper", importEmptyFields(this.capture(), metadata)); this.state.changed = true; this.dialog.dataset.dirty = "true";
      this.renderFields(); clear(this.importNotice, h("p", { class: "muted" }, t("Metadata imported. Check the fields before saving.")));
    } catch (cause) {
      if (this.dialog?.open && generation === this.generation) clear(this.importNotice, failure(t("{0} You can continue by filling the fields manually.", errorText(cause))));
    } finally { if (generation === this.generation) { this.importing = false; button.disabled = false; this.controls(false); } }
  }
  private async submit(): Promise<void> {
    if (!this.ready || this.state.saving || this.importing) return;
    if (!this.state.pending && !this.form.reportValidity()) return;
    let request;
    try { request = this.state.begin(this.kind, this.capture(), newRequestId("note")); }
    catch { clear(this.error, failure(t("Check the title, authors, year and links before saving."))); return; }
    const generation = this.generation;
    this.dialog!.dataset.dirty = "true"; this.controls(true); clear(this.error);
    try {
      const result = await this.client.createNote(request);
      if (!this.dialog?.open || generation !== this.generation) return;
      this.state.saving = false; this.state.pending = undefined; this.state.changed = false; this.dialog.dataset.dirty = "false";
      this.dispose(); toast(t("Note created")); this.onSaved(result);
    } catch (cause) {
      if (!this.dialog?.open || generation !== this.generation) return;
      this.state.failed(cause); this.controls(!!this.state.pending);
      clear(this.error, failure(errorText(cause)), this.state.pending ? h("div", { class: "form-stack" },
        h("p", { class: "muted" }, t("Your draft is kept. Retry the same save to check whether it succeeded; this will not create a second note.")),
        h("button", { type: "button", class: "btn btn-quiet", onclick: () => {
          if (!confirm(t("Check whether the earlier note exists first. Start a separate save with this draft?"))) return;
          this.state.pending = undefined; this.controls(false); clear(this.error);
          this.fields.querySelector<HTMLInputElement>("input[name=title]")?.focus();
        } }, t("Continue as a new save"))) : null);
    }
  }
}

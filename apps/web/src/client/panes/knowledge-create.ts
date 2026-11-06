import type { KnowledgeCreateResult, KnowledgeNoteKind, KnowledgeContext } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { clear, failure, field, h, icon, loading, select, toast } from "../dom.ts";
import { newRequestId } from "../commands.ts";
import { lang, t } from "../i18n.ts";
import { drafts } from "../drafts.ts";
import { NoteDraft, importEmptyFields, type NoteFields } from "../knowledge-draft.ts";
import { NoteEditor } from "../note-editor.ts";
import { writingContext } from "../note-text.ts";
export class KnowledgeCreate {
 private store=drafts();
 private state=new NoteDraft();private kind:KnowledgeNoteKind="idea";private generation=0;private importing=false;private ready=false;private opened=false;
 private form=h("form",{class:"form-stack knowledge-form",id:newRequestId("note-form")});
 private fields=h("div",{class:"form-stack"});private typeCards=h("div",{class:"note-types",role:"group","aria-label":t("Note type")});
 private error=h("div",{role:"alert"});private importNotice=h("div",{role:"status"});private editor?:NoteEditor;
 private save=h("button",{type:"submit",form:this.form.id,class:"btn btn-primary",disabled:true},t("Create note"));
 constructor(private client:Client,private onSaved:(result:KnowledgeCreateResult)=>void,private host:HTMLElement,private contextChanged:(context:KnowledgeContext)=>void,private openNote:(ref:string)=>void,private cancel:()=>void,private showRelated:()=>void){}
 open():void{
  if(this.opened)return;this.opened=true;
  const draft=this.store.read<{kind:KnowledgeNoteKind;fields:Array<[KnowledgeNoteKind,NoteFields]>;pending?:NoteDraft["pending"]}>("knowledge:new");
  if(draft&&["idea","paper","video","web"].includes(draft.kind)&&Array.isArray(draft.fields)){this.kind=draft.kind;for(const [kind,fields] of draft.fields)this.state.set(kind,fields);this.state.pending=draft.pending;this.state.changed=true;}
  this.editor=new NoteEditor({value:this.state.fields.get(this.kind)?.body??"",change:(body)=>{this.state.changed=true;this.capture(body);this.context();},context:()=>this.context(),referenceContext:position=>writingContext(this.title(),this.editor!.value,position),references:(query,position)=>this.client.noteReferences({source_kind:this.kind,query,context:writingContext(this.title(),this.editor!.value,position)}),open:this.openNote,save:()=>void this.submit()});
  this.form.append(this.typeCards,this.fields,h("button",{type:"button",class:"btn btn-small mobile-only",onclick:this.showRelated},t("Related notes")),this.editor.root,this.error,h("div",{class:"note-create-actions"},h("button",{type:"button",class:"btn",onclick:()=>{if(this.canLeave())this.cancel();}},t("Close")),this.save));
  clear(this.host,h("article",{class:"reader note-author"},h("h1",{},t("New note")),this.form));
  this.form.addEventListener("invalid",event=>(event.target as Element).closest("details")?.setAttribute("open",""),true);
  this.form.addEventListener("input",event=>{if((event.target as HTMLInputElement).name==="authors"){const f=this.form.querySelector<HTMLInputElement>("[name=firstAuthorFamily]");if(f)f.value="";}this.state.changed=true;this.capture();this.context();});
  this.form.addEventListener("submit",event=>{event.preventDefault();void this.submit();});this.renderFields();this.renderTypes();void this.loadTemplates();
 }
 dispose():void{this.persist();this.opened=false;this.generation++;this.editor?.destroy();}
 get hasPending():boolean{return !!this.state.pending;}
 get dirty():boolean{return this.opened&&(this.state.changed||!!this.state.pending||this.state.saving);}
 canLeave():boolean{this.capture();return true;}
 private persist():void{if(this.state.changed||this.state.pending)this.store.write("knowledge:new",{kind:this.kind,fields:[...this.state.fields],pending:this.state.pending});}
 private title():string{return this.fields.querySelector<HTMLInputElement>("[name=title]")?.value??"";}
 private context():void{if(this.editor)this.contextChanged(writingContext(this.title(),this.editor.value,this.editor.position));}
 private async loadTemplates():Promise<void>{
  const generation=this.generation;clear(this.error,loading(t("Preparing note templates…")));this.controls(true);
  try{const templates=await Promise.all((["paper","video","web","idea"] as const).map(kind=>this.client.knowledgeTemplate({kind,locale:lang()})));if(!this.opened||generation!==this.generation)return;
   for(const template of templates)if(!this.state.fields.has(template.kind))this.state.set(template.kind,{body:template.body});this.ready=true;this.renderFields();this.editor!.setValue(this.state.fields.get(this.kind)!.body!);clear(this.error);this.controls(!!this.state.pending);this.context();
  }catch(cause){if(this.opened&&generation===this.generation)clear(this.error,failure(errorText(cause),()=>void this.loadTemplates()));}
 }
 private capture(body=this.editor?.value??""):NoteFields{const values:NoteFields={body};for(const control of this.fields.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>("[name]"))values[control.name]=control.value;this.state.set(this.kind,values);this.persist();return values;}
 private renderTypes():void{const types:Array<[KnowledgeNoteKind,string,string]>=[["idea",t("Idea"),"memory"],["paper",t("Paper"),"knowledge"],["video",t("Video"),"play"],["web",t("Web page"),"globe"]];clear(this.typeCards,...types.map(([kind,label,glyph])=>h("button",{type:"button",class:"note-type","aria-pressed":String(kind===this.kind),onclick:()=>this.switchType(kind)},icon(glyph),label)));}
 private switchType(kind:KnowledgeNoteKind):void{if(kind===this.kind||!this.ready||this.state.pending||this.state.saving)return;this.capture();this.generation++;this.importing=false;this.kind=kind;this.persist();this.renderTypes();this.renderFields();this.editor!.setValue(this.state.fields.get(kind)?.body??"");clear(this.error);this.controls(false);this.context();}
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
  private async importPaper(): Promise<void> {
    if (this.importing || this.state.pending) return;
    const input = this.capture().paper_input?.trim(); if (!input) { clear(this.importNotice, failure(t("Enter an arXiv ID, DOI or paper link first."))); return; }
    const generation = this.generation;
    this.importing = true; this.save.disabled = true;
    const button = this.fields.querySelector<HTMLButtonElement>("[data-import]")!; button.disabled = true;
    clear(this.importNotice, loading(t("Importing paper metadata…")));
    try {
      const metadata = await this.client.resolvePaper({ input });
      if (!this.opened || generation !== this.generation || this.kind !== "paper") return;
      if (this.capture().paper_input?.trim() !== input) { clear(this.importNotice, failure(t("The paper input changed. Import again to use the new source."))); return; }
      this.state.set("paper", importEmptyFields(this.capture(), metadata)); this.state.changed = true;
      this.renderFields(); this.context(); clear(this.importNotice, h("p", { class: "muted" }, t("Metadata imported. Check the fields before saving.")));
    } catch (cause) {
      if (this.opened && generation === this.generation) clear(this.importNotice, failure(t("{0} You can continue by filling the fields manually.", errorText(cause))));
    } finally { if (generation === this.generation) { this.importing = false; button.disabled = false; this.controls(false); } }
  }

 private controls(lock:boolean):void{for(const control of this.form.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement>("input,textarea,select,button"))control.disabled=lock;this.editor?.setReadOnly(lock);this.save.disabled=!this.ready||this.state.saving||this.importing;this.save.textContent=this.state.saving?t("Saving…"):this.state.pending?t("Retry same save"):t("Create note");}
 private async submit():Promise<void>{
  if(!this.ready||this.state.saving||this.importing)return;if(!this.state.pending&&!this.form.reportValidity())return;
  let request;try{request=this.state.begin(this.kind,this.capture(),newRequestId("note"));}catch{clear(this.error,failure(t("Check the title, authors, year and links before saving.")));return;}
  const generation=this.generation;this.persist();this.controls(true);clear(this.error);
  try{const result=await this.client.createNote(request);if(!this.opened||generation!==this.generation)return;this.state.saving=false;this.state.pending=undefined;this.state.changed=false;this.store.remove("knowledge:new");this.dispose();toast(t("Note created"));this.onSaved(result);}
  catch(cause){if(!this.opened||generation!==this.generation)return;this.state.failed(cause);this.persist();this.controls(!!this.state.pending);clear(this.error,failure(errorText(cause)),this.state.pending?h("div",{},h("p",{class:"muted"},t("Your draft is kept. Retry the same save to check whether it succeeded; this will not create a second note.")),h("button",{type:"button",class:"btn",onclick:()=>{if(!confirm(t("Check whether the earlier note exists first. Start a separate save with this draft?")))return;this.state.pending=undefined;this.controls(false);clear(this.error);}},t("Continue as a new save"))):null);}
 }
}

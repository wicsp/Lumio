import type { KnowledgeReferencesResult } from "@lumio/schema";
import type { Client } from "./api.ts";
import { h, clear, highlightedText } from "./dom.ts";
import { matchTerms } from "./note-matches.ts";
import { referenceTrigger, writingContext, insertReference, portableReference } from "./note-text.ts";
import { t } from "./i18n.ts";

/** Plain composers keep their send semantics; completion consumes Enter before the form does. */
export function referenceInput(input: HTMLTextAreaElement, client: Client, title: () => string = () => ""): () => void {
  const panel = h("div", {class:"reference-suggestions",role:"listbox",hidden:true,id:`refs-${crypto.randomUUID()}`});
  document.body.append(panel);
  input.setAttribute("aria-autocomplete","list"); input.setAttribute("aria-controls",panel.id); input.setAttribute("aria-expanded","false");
  let hits: KnowledgeReferencesResult["hits"] = [], selected = 0, generation = 0, composing = false, active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => { generation++;clearTimeout(timer);panel.hidden=true;input.setAttribute("aria-expanded","false");input.removeAttribute("aria-activedescendant"); };
  const choose = (index: number) => {
    const trigger=referenceTrigger(input.value,input.selectionStart),hit=hits[index];if(!trigger||!hit||composing||input.selectionStart!==input.selectionEnd){hide();return;}
    const edit=insertReference(input.value,trigger,portableReference(hit.note),false);
    const change=edit.changes[0]!;input.setRangeText(change.insert,change.from,change.to??change.from,"end");input.setSelectionRange(edit.cursor,edit.cursor);
    hide();input.dispatchEvent(new Event("input",{bubbles:true}));input.focus();
  };
  const mark = () => { [...panel.querySelectorAll<HTMLElement>("[role=option]")].forEach((el,index)=>el.setAttribute("aria-selected",String(index===selected)));const row=panel.querySelector<HTMLElement>('[aria-selected="true"]');if(row){input.setAttribute("aria-activedescendant",row.id);row.scrollIntoView({block:"nearest"});} };
  const refresh = () => {
    hide(); if(!active||composing||input.selectionStart!==input.selectionEnd)return;
    const trigger=referenceTrigger(input.value,input.selectionStart);if(!trigger)return;
    const context=writingContext(title(),input.value,input.selectionStart),version=generation;
    timer=setTimeout(async()=>{
      try {
        const result=await client.noteReferences({source_kind:"idea",query:trigger.query,context});
        if(!active||version!==generation||document.activeElement!==input)return;
        hits=result.hits;selected=0;const terms=matchTerms(trigger.query||context);
        clear(panel,...hits.map((hit,index)=>{const row=h("button",{type:"button",role:"option",id:`${panel.id}-${index}`,class:"reference-option",tabindex:"-1"},h("strong",{},highlightedText(hit.note.title,terms)),h("small",{},highlightedText(hit.snippet??"",terms)));row.addEventListener("mousedown",event=>event.preventDefault());row.addEventListener("click",()=>choose(index));return row;}));
        if(!hits.length)panel.append(h("p",{class:"field-hint"},t("No matches. Type to search titles and content.")));
        panel.hidden=false;input.setAttribute("aria-expanded","true");
        const rect=input.getBoundingClientRect();panel.style.width=`${Math.min(Math.max(rect.width,280),window.innerWidth-24)}px`;panel.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-panel.offsetWidth-12))}px`;panel.style.top=`${Math.max(12,rect.bottom+panel.offsetHeight+8>window.innerHeight?rect.top-panel.offsetHeight-8:rect.bottom+8)}px`;mark();
      } catch { if(version===generation)hide(); }
    },160);
  };
  const key = (event:KeyboardEvent) => {
    if(composing||event.isComposing||panel.hidden)return;
    if(event.key==="Escape"){event.preventDefault();event.stopImmediatePropagation();hide();return;}
    if(!hits.length)return;
    if(["ArrowDown","ArrowUp","Enter","Tab"].includes(event.key)){
      event.preventDefault();event.stopImmediatePropagation();
      if(event.key==="ArrowDown"||event.key==="ArrowUp"){selected=(selected+(event.key==="ArrowDown"?1:-1)+hits.length)%hits.length;mark();}
      else choose(selected);
    }
  };
  const moved=(event:KeyboardEvent)=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key))refresh();};
  const start=()=>{composing=true;hide();},end=()=>{composing=false;refresh();},blur=()=>{setTimeout(()=>{if(document.activeElement!==input)hide();},120);};
  input.addEventListener("input",refresh);input.addEventListener("click",refresh);input.addEventListener("keydown",key,true);input.addEventListener("keyup",moved);input.addEventListener("compositionstart",start);input.addEventListener("compositionend",end);input.addEventListener("blur",blur);
  return ()=>{active=false;hide();panel.remove();input.removeEventListener("input",refresh);input.removeEventListener("click",refresh);input.removeEventListener("keydown",key,true);input.removeEventListener("keyup",moved);input.removeEventListener("compositionstart",start);input.removeEventListener("compositionend",end);input.removeEventListener("blur",blur);};
}

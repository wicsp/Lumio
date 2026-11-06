import type { Client } from "./api.ts";
import { h, clear } from "./dom.ts";
import { t } from "./i18n.ts";
/** Reader surfaces (threads, reports, AI messages) use the same internal note links. */
export function referenceLinks(root: HTMLElement, client: Client, open: (reference:string)=>void): ()=>void {
  const card=h("aside",{class:"note-reference-card",hidden:true,role:"dialog","aria-label":t("Reference")});document.body.append(card);
  let anchor:HTMLElement|undefined,generation=0,timer:ReturnType<typeof setTimeout>|undefined;
  const hide=()=>{clearTimeout(timer);generation++;anchor=undefined;card.hidden=true;};
  const target=(event:Event)=>(event.target as Element).closest<HTMLElement>("[data-note]");
  const click=(event:MouseEvent)=>{if(event.defaultPrevented)return;const link=target(event);if(!link)return;event.preventDefault();hide();open(link.dataset.note!);};
  const show=async(event:Event)=>{
    const link=target(event);if(!link||link.closest(".live-note")||link===anchor)return;
    clearTimeout(timer);anchor=link;const version=++generation;const reference=link.dataset.note!;
    const body=h("p",{class:"reference-excerpt"},t("Loading…"));
    clear(card,h("strong",{},link.textContent??t("Reference")),body,h("button",{type:"button",class:"btn btn-small",onclick:()=>{hide();open(reference);}},t("Open note")));
    card.hidden=false;const rect=link.getBoundingClientRect();card.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-card.offsetWidth-12))}px`;card.style.top=`${Math.max(12,Math.min(rect.bottom+8,window.innerHeight-card.offsetHeight-12))}px`;
    try{const note=await client.show(reference);if(version===generation)body.textContent=note.body.slice(0,260);}catch{if(version===generation)body.textContent=t("No matching notes.");}
  };
  const leave=(event:Event)=>{const el=event.target as Node;if(card.hidden||anchor?.contains(el)||card.contains(el)){clearTimeout(timer);timer=undefined;return;}timer??=setTimeout(hide,180);};
  root.addEventListener("click",click);root.addEventListener("mouseover",show);root.addEventListener("focusin",show);document.addEventListener("pointermove",leave);document.addEventListener("pointerdown",leave);
  return ()=>{hide();card.remove();root.removeEventListener("click",click);root.removeEventListener("mouseover",show);root.removeEventListener("focusin",show);document.removeEventListener("pointermove",leave);document.removeEventListener("pointerdown",leave);};
}

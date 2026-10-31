import type { Session } from "../api.ts";
import { h, icon } from "../dom.ts";
import { OverviewPane } from "../panes/overview.ts";
import { KnowledgePane } from "../panes/knowledge.ts";
import { WorkPane } from "../panes/work.ts";
import { ExecutionPane } from "../panes/execution.ts";
import { AssistantPane } from "../panes/assistant.ts";
import { ApprovalsPane } from "../panes/approvals.ts";
type Section="overview"|"knowledge"|"work"|"execution"|"assistant"|"approvals";
const SECTIONS:Array<[Section,string,string]>=[["overview","我的工作台","overview"],["knowledge","知识库","knowledge"],["work","项目与任务","work"],["execution","执行","execution"],["assistant","AI 助手","assistant"],["approvals","提议与审批","approvals"]];
export class WorkbenchView {
  private content=h("main",{class:"content",id:"content",tabindex:"-1"});
  private nav=new Map<Section,HTMLButtonElement>();
  private pane?:{canLeave?():boolean;dispose?():void};
  private currentHash="";
  private breadcrumb=h("span",{class:"breadcrumb-current"},"我的工作台");
  private readonly onRoute=()=>{if(!this.canLeave()){history.pushState(null,"",this.currentHash||"#overview");return;}const route=this.readRoute();this.show(route.section,route.id);};
  private readonly onKey=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"){event.preventDefault();this.go("knowledge");this.content.querySelector<HTMLInputElement>("input[name=q]")?.focus();}};
  private readonly onUnload=(event:BeforeUnloadEvent)=>{if((this.pane&&"dirty" in this.pane&&this.pane.dirty)||document.querySelector("dialog[data-dirty=true]")){event.preventDefault();event.returnValue="";}};
  constructor(root:HTMLElement,private session:Session,_humans:string[],private logout:()=>void){
    const nav=h("nav",{class:"nav","aria-label":"主导航"});
    for(const [key,label,name] of SECTIONS){const button=h("button",{type:"button",class:`nav-item ${key==="approvals"?"nav-utility":""}`,onclick:()=>this.go(key)},icon(name),h("span",{},label));this.nav.set(key,button);nav.append(button);}
    const search=h("button",{type:"button",class:"workspace-search",onclick:()=>{this.go("knowledge");this.content.querySelector<HTMLInputElement>("input[name=q]")?.focus();}},icon("search"),h("span",{},"搜索知识…"),h("kbd",{},"⌘ K"));
    root.append(h("a",{class:"skip-link",href:"#content",onclick:(event:Event)=>{event.preventDefault();this.content.focus();}},"跳到内容"),h("div",{class:"shell"},
      h("aside",{class:"sidebar"},h("div",{class:"brand"},h("span",{class:"brand-mark"},icon("brand")),h("span",{},"lumio",h("span",{class:"brand-dot"},"."))),h("div",{class:"workspace-label"},"个人空间"),nav,
        h("div",{class:"sidebar-foot"},h("div",{class:"connection-state"},h("span",{class:"online-dot"}),"工作台已连接"),h("div",{class:"profile-row"},h("span",{class:"avatar"},"L"),h("div",{class:"row-main"},h("strong",{},"个人工作台"),h("span",{class:"muted"},"连接你的知识与行动"))),h("button",{type:"button",class:"btn btn-ghost logout",onclick:()=>{if(this.canLeave())this.logout();}},icon("logout"),"退出连接"))),
      h("div",{class:"workspace"},h("header",{class:"workspace-bar"},h("div",{class:"breadcrumb"},icon("workspace"),h("span",{},"个人空间"),h("span",{class:"breadcrumb-slash"},"/"),this.breadcrumb),h("div",{class:"workspace-tools"},search,h("button",{type:"button",class:"btn btn-ghost mobile-logout","aria-label":"退出连接",onclick:()=>{if(this.canLeave())this.logout();}},icon("logout")))),this.content)));
    window.addEventListener("hashchange",this.onRoute);window.addEventListener("keydown",this.onKey);window.addEventListener("beforeunload",this.onUnload);
    const route=this.readRoute();this.show(route.section,route.id);
  }
  private readRoute():{section:Section;id?:string}{
    const [section,raw]=location.hash.slice(1).split(/\/(.*)/s);const known=SECTIONS.find(([key])=>key===section)?.[0]??"overview";
    try{return{section:known,...(raw?{id:decodeURIComponent(raw)}:{})};}catch{return{section:known};}
  }
  private go(section:Section,id?:string):void{if(!this.canLeave())return;const hash=`#${section}${id?`/${encodeURIComponent(id)}`:""}`;history.pushState(null,"",hash);this.show(section,id);}
  private show(section:Section,id?:string):void{
    this.pane?.dispose?.();window.scrollTo({top:0,left:0});document.querySelectorAll<HTMLDialogElement>("dialog").forEach(dialog=>{dialog.close();dialog.remove();});
    this.currentHash=`#${section}${id?`/${encodeURIComponent(id)}`:""}`;
    this.breadcrumb.textContent=SECTIONS.find(([key])=>key===section)?.[1]??"我的工作台";
    for(const [key,button]of this.nav)button.setAttribute("aria-current",key===section?"page":"false");
    const target=h("div",{class:`pane pane-${section}`});this.content.replaceChildren(target);const client=this.session.client;
    if(section==="overview")this.pane=new OverviewPane(target,client,(destination,reference)=>this.go(destination,reference));
    else if(section==="knowledge")this.pane=new KnowledgePane(target,client,id);
    else if(section==="work")this.pane=new WorkPane(target,client,id);
    else if(section==="execution")this.pane=new ExecutionPane(target,client,id);
    else if(section==="assistant")this.pane=new AssistantPane(target,client);
    else this.pane=new ApprovalsPane(target,client);
  }
  canLeave():boolean{if(document.querySelector("dialog[data-dirty=true]")&&!confirm("有尚未保存的表单，离开会丢弃修改。确定继续吗？"))return false;return this.pane?.canLeave?.()??true;}
  dispose():void{this.pane?.dispose?.();window.removeEventListener("hashchange",this.onRoute);window.removeEventListener("keydown",this.onKey);window.removeEventListener("beforeunload",this.onUnload);}
}

import type { WorkProject, WorkTask, WorkTaskDetail } from "@lumio/schema";
import { TASK_STATUSES, PROJECT_STATUSES } from "@lumio/schema";
import { errorText, isConflict, type Client } from "../api.ts";
import { newRequestId, taskCreateCommand, projectCreateCommand, engineTargets, dispatchCommand, formatTime } from "../commands.ts";
import { clear, empty, failure, field, h, icon, loading, openDialog, select } from "../dom.ts";
import { renderMarkdown } from "../utils/markdown.ts";
import { WorkEditor, type EditableWork } from "./work-editor.ts";

import { TASK_LABELS, PROJECT_LABELS } from "../labels.ts";

export class WorkPane {
  private list=h("div",{class:"list work-list"});
  private detail=h("section",{class:"reader work-detail"},empty("选择一项工作，查看详情与进展"));
  private query=h("input",{type:"search",name:"work-search",placeholder:"搜索任务标题或正文"});
  private status=select("work-status",[["","全部状态"],...TASK_STATUSES.map(s=>[s,TASK_LABELS[s]!] as [string,string])]);
  private project=select("work-project",[["","全部项目"]]);
  private mode:"tasks"|"projects"="tasks";
  private projects:WorkProject[]=[];
  private editor?:WorkEditor;
  private listGeneration=0;
  private detailGeneration=0;
  private active=true;
  constructor(private root:HTMLElement,private client:Client,initialId?:string){
    const tasks=h("button",{type:"button",class:"btn btn-small","aria-pressed":"true",onclick:()=>this.switchMode("tasks")},"任务");
    const projects=h("button",{type:"button",class:"btn btn-small","aria-pressed":"false",onclick:()=>this.switchMode("projects")},"项目");
    const tabs=h("div",{class:"tabs","aria-label":"工作视图"},tasks,projects);
    const filters=h("form",{class:"filters work-filters"},field("搜索",this.query),field("状态",this.status),field("项目",this.project),h("button",{type:"submit",class:"btn"},"筛选"));
    filters.addEventListener("submit",e=>{e.preventDefault();void this.load();});
    const create=h("button",{type:"button",class:"btn btn-primary",onclick:()=>this.create()},"＋ 新建");
    root.append(h("header",{class:"pane-head"},h("div",{class:"heading-group"},h("p",{class:"eyebrow"},"WORK"),h("h1",{},"项目与任务")),tabs,
      h("button",{type:"button",class:"btn btn-ghost","aria-label":"刷新工作列表",onclick:()=>this.load()},icon("refresh")),create),filters,h("div",{class:"split work-split"},this.list,this.detail));
    this.switchMode=(mode)=>{
      if(mode===this.mode||!this.canLeave())return;this.detailGeneration++;this.editor?.dispose();this.editor=undefined;this.mode=mode;
      tasks.setAttribute("aria-pressed",String(mode==="tasks"));projects.setAttribute("aria-pressed",String(mode==="projects"));
      this.status.replaceChildren(...[["","全部状态"],...(mode==="tasks"?TASK_STATUSES:PROJECT_STATUSES).map(s=>[s,(mode==="tasks"?TASK_LABELS:PROJECT_LABELS)[s]!])].map(([value,label])=>h("option",{value:value!},label!)));
      (this.project.closest("label") as HTMLElement).hidden=mode==="projects";this.query.placeholder=mode==="tasks"?"搜索任务标题或正文":"搜索项目标题";
      clear(this.detail,empty("选择一项工作，查看详情与进展"));void this.load();
    };
    void this.load().then(()=>{if(initialId&&this.active){if(initialId.startsWith("prj_"))this.switchMode("projects");void this.open(initialId);}});
  }
  private switchMode(_mode:"tasks"|"projects"):void{}
  dispose():void{this.active=false;this.listGeneration++;this.detailGeneration++;this.editor?.dispose();}
  get dirty():boolean{return this.editor?.dirty??false;}
  canLeave():boolean{return this.editor?.canLeave()??true;}
  private async load():Promise<void>{
    const generation=++this.listGeneration;clear(this.list,loading());
    try{
      const projects=await this.client.workProjects();if(generation!==this.listGeneration||!this.active)return;
      this.projects=projects;const selected=this.project.value;
      this.project.replaceChildren(h("option",{value:""},"全部项目"),...projects.map(p=>h("option",{value:p.id},p.title)));this.project.value=selected;
      if(this.mode==="projects"){
        const visible=projects.filter(p=>(!this.status.value||p.status===this.status.value)&&p.title.toLowerCase().includes(this.query.value.trim().toLowerCase()));
        clear(this.list,...visible.map(p=>this.row(p)),!visible.length&&empty("还没有匹配的项目。新建一个项目，整理下一阶段的目标。"));return;
      }
      const tasks=await this.client.workTasks({status:this.status.value||undefined,project:this.project.value||undefined,query:this.query.value.trim()||undefined});
      if(generation!==this.listGeneration||!this.active)return;
      clear(this.list,...tasks.map(t=>this.row(t)),!tasks.length&&empty("没有匹配的任务。可以新建一项工作，或调整筛选条件。"));
    }catch(error){if(generation===this.listGeneration&&this.active)clear(this.list,failure(errorText(error),()=>this.load()));}
  }
  private row(item:WorkProject|WorkTask):HTMLElement{
    const labels=item.type==="task"?TASK_LABELS:PROJECT_LABELS;
    return h("button",{type:"button",class:`row row-button work-row status-${item.status}`,onclick:()=>this.open(item.id)},
      h("span",{class:`status-mark status-${item.status}`,"aria-hidden":"true"}),h("span",{class:"row-main"},h("strong",{},item.title),
        h("span",{class:"muted"},item.type==="task"?`${item.assignee==="human"?"由我负责":item.assignee}${item.project?` · ${this.projects.find(p=>p.id===item.project)?.title??"关联项目"}`:""}`:item.goal??"尚未填写项目目标")),h("span",{class:`badge status-${item.status}`},labels[item.status]??item.status));
  }
  private async open(id:string):Promise<void>{
    if(!this.canLeave())return;this.editor?.dispose();this.editor=undefined;clear(this.detail,loading());
    const generation=++this.detailGeneration;
    try{
      const object=id.startsWith("task_")?await this.client.workTask(id):await this.client.workProject(id);
      if(!this.active||generation!==this.detailGeneration)return;
      clear(this.detail);this.editor=new WorkEditor(this.detail,this.client,object,this.projects,()=>this.load(),()=>this.open(id));
    }catch(error){if(this.active&&generation===this.detailGeneration)clear(this.detail,failure(errorText(error)));}
  }
  private create():void{
    const mode=this.mode;
    const title=h("input",{name:"title",required:true,placeholder:mode==="tasks"?"下一步要完成什么？":"这个项目叫什么？"});
    const description=h("textarea",{name:"description",rows:"7",placeholder:"补充背景、目标或完成标准，支持 Markdown"});
    const goal=h("input",{name:"goal",placeholder:"这个阶段想获得什么结果？"});
    const project=select("project",[["","不关联项目"],...this.projects.map(p=>[p.id,p.title] as [string,string])],this.project.value);
    const error=h("div",{class:"form-message",role:"alert"});const formId=`create-${newRequestId()}`;
    const form=h("form",{id:formId,class:"form-stack"},field(mode==="tasks"?"任务标题":"项目名称",title),mode==="tasks"?field("所属项目",project):field("项目目标",goal),field("说明",description),error);
    const save=h("button",{type:"submit",form:formId,class:"btn btn-primary"},mode==="tasks"?"创建任务":"创建项目");
    const dialog=openDialog(mode==="tasks"?"新建任务":"新建项目",form,[save]);
    let pending=false,prior="",requestId=newRequestId();
    form.addEventListener("submit",async e=>{
      e.preventDefault();if(pending)return;pending=true;save.disabled=true;clear(error);
      const key=JSON.stringify([title.value,description.value,project.value,goal.value]);if(prior&&key!==prior)requestId=newRequestId();prior=key;
      try{
        const request=mode==="tasks"?taskCreateCommand({title:title.value,description:description.value,project:project.value||undefined},requestId):projectCreateCommand({title:title.value,description:description.value,goal:goal.value},requestId);
        const result=await this.client.workCommand(request);if(!this.active)return;dialog.close();
        if(result.kind==="task"||result.kind==="project"){await this.load();await this.open(result.kind==="task"?result.task.id:result.project.id);}
      }catch(cause){clear(error,failure(`${errorText(cause)}。内容已保留；连接中断时请先刷新核对是否已创建。`));}
      finally{pending=false;save.disabled=false;}
    });title.focus();
  }
}

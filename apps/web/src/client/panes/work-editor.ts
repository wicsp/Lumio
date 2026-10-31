import { PROJECT_STATUSES, TASK_STATUSES, type WorkProject, type WorkTask, type WorkTaskDetail, type WorkCommandRequest } from "@lumio/schema";
import { errorText, isConflict, type Client } from "../api.ts";
import { commentCommand, dispatchCommand, engineTargets, formatTime, newRequestId, projectFieldsCommand, taskFieldsCommand } from "../commands.ts";
import { clear, empty, failure, field, h, openDialog, select } from "../dom.ts";
import { JOB_LABELS, PROJECT_LABELS, TASK_LABELS } from "../labels.ts";
import { renderMarkdown } from "../utils/markdown.ts";
export type EditableWork=WorkTask|WorkProject;

export class WorkEditor {
  private record:EditableWork;
  private baseDescription:string;
  private description=h("textarea",{name:"edit-description",rows:"10",placeholder:"写下背景、方法或完成标准，支持 Markdown"});
  private title=h("input",{name:"edit-title",required:true});
  private status:HTMLSelectElement;
  private assignee=h("input",{name:"assignee",placeholder:"human 或 pi@设备名"});
  private project:HTMLSelectElement;
  private workdir=h("input",{name:"workdir",placeholder:"~（执行器主目录）"});
  private model=h("input",{name:"task-model",placeholder:"使用执行引擎的默认模型"});
  private timeout=h("input",{name:"timeout",type:"number",min:"1",step:"1",placeholder:"120"});
  private goal=h("input",{name:"project-goal"});
  private heading=h("h2");
  private note=h("div",{class:"form-message",role:"alert"});
  private busy=false;
  private commentDraft?:HTMLTextAreaElement;
  private active=true;
  private structuralBase="";
  private buttons:HTMLButtonElement[]=[];
  constructor(private root:HTMLElement,private client:Client,input:WorkProject|WorkTaskDetail,projects:WorkProject[],private changed:()=>void,private reload:()=>void){
    this.record="task" in input?input.task:input;this.baseDescription=this.record.description;this.description.value=this.baseDescription;
    const isTask=this.record.type==="task",labels=isTask?TASK_LABELS:PROJECT_LABELS;
    this.status=select("edit-status",(isTask?TASK_STATUSES:PROJECT_STATUSES).map(s=>[s,labels[s]!] as [string,string]),this.record.status);
    this.project=select("edit-project",[["","不关联项目"],...projects.map(p=>[p.id,p.title] as [string,string])],this.record.type==="task"?this.record.project:undefined);
    this.title.value=this.record.title;this.heading.textContent=this.record.title;
    if(this.record.type==="task"){this.assignee.value=this.record.assignee;this.workdir.value=this.record.workdir??"";this.model.value=this.record.model??"";this.timeout.value=this.record.timeout_minutes?.toString()??"";}
    else this.goal.value=this.record.goal??"";
    const saveFields=this.button("保存属性",()=>{});saveFields.type="submit";
    const form=h("form",{class:"form-stack properties"},h("div",{class:"field-row"},field(isTask?"任务标题":"项目名称",this.title),field("状态",this.status)),
      ...(isTask?[h("div",{class:"field-row"},field("负责人",this.assignee,"修改负责人不会自动派活"),field("所属项目",this.project)),
        h("details",{class:"advanced"},h("summary",{},"执行设置"),h("div",{class:"form-stack"},field("工作目录",this.workdir),h("div",{class:"field-row"},field("模型",this.model),field("最长运行时间（分钟）",this.timeout))))]:[field("项目目标",this.goal)]),saveFields);
    form.addEventListener("submit",e=>{e.preventDefault();void this.saveFields();});
    const saveBody=this.button("保存正文",()=>{});saveBody.type="submit";
    const bodyForm=h("form",{class:"form-stack body-editor"},h("h3",{},"正文"),field("说明（Markdown）",this.description),saveBody);
    bodyForm.addEventListener("submit",e=>{e.preventDefault();void this.saveDescription();});
    const preview=h("div",{class:"markdown description-preview"});preview.innerHTML=renderMarkdown(this.baseDescription||"尚未填写说明。");
    const previewBox=h("details",{},h("summary",{},"阅读已保存的正文"),preview);
    root.append(h("div",{class:"detail-heading"},h("p",{class:"eyebrow"},isTask?"TASK":"PROJECT"),this.heading,h("p",{class:"muted"},`更新于 ${formatTime(this.record.updated)}`)),this.note,form,bodyForm,previewBox);
    this.structuralBase=this.fieldsKey();
    if("task" in input){
      const dispatch=this.button("派出 / 继续",()=>this.dispatch());dispatch.classList.add("btn-primary");root.append(h("section",{class:"detail-section"},h("h3",{},"执行与进展"),h("p",{class:"muted"},"保存修改后，再明确选择执行器派出这一轮。运行成功不会自动完成任务。"),dispatch,
        input.executions.length?h("ul",{class:"execution-list"},...input.executions.map(run=>h("li",{},h("strong",{},`第 ${run.round} 轮`),h("span",{class:"muted"},`${run.applied?"进展已记录":"等待结果"} · ${formatTime(run.created)}`),h("code",{},run.job)))):empty("还没有派出过执行。")));
      this.comments(input);
      if(input.task.dependencies.length||input.task.parent)root.append(h("section",{class:"detail-section"},h("h3",{},"任务关系"),h("p",{class:"muted"},[input.task.parent?`父任务：${input.task.parent}`:"",input.task.dependencies.length?`前置任务：${input.task.dependencies.join("、")}`:""].filter(Boolean).join("\n"))));
      if(input.task.references.length)root.append(h("section",{class:"detail-section"},h("h3",{},"关联资料"),h("ul",{},...input.task.references.map(ref=>h("li",{},ref.label??ref.id)))));
    }
  }
  dispose():void{this.active=false;}
  private fieldsKey():string{return JSON.stringify([this.title.value,this.status.value,this.assignee.value,this.project.value,this.workdir.value,this.model.value,this.timeout.value,this.goal.value]);}
  get dirty():boolean{return this.description.value!==this.baseDescription||this.fieldsKey()!==this.structuralBase||!!this.commentDraft?.value.trim();}
  canLeave():boolean {if(this.busy)return false;return !this.dirty||confirm("有尚未保存的修改，离开会丢弃这些修改。确定离开吗？");}
  private button(text:string,action:()=>void|Promise<void>):HTMLButtonElement{
    const button=h("button",{type:"button",class:"btn",onclick:()=>void action()},text);this.buttons.push(button);return button;
  }
  private setBusy(value:boolean):void{this.busy=value;for(const button of this.buttons)button.disabled=value;}
  private showFailure(cause:unknown):void{
    const text=isConflict(cause)?"内容已有新版本。你的修改仍保留在输入框中，请先保留草稿，再决定是否载入新版本。":`${errorText(cause)}。修改仍保留；连接中断时请先核对是否保存成功。`;
    clear(this.note,failure(text),h("div",{class:"button-row"},h("button",{type:"button",class:"btn btn-small",onclick:()=>this.exportDraft()},"下载草稿"),h("button",{type:"button",class:"btn btn-small",onclick:()=>{if(confirm("载入最新内容会放弃当前未保存修改，确定继续吗？")){this.structuralBase=this.fieldsKey();this.baseDescription=this.description.value;if(this.commentDraft)this.commentDraft.value="";this.reload();}}},"载入最新内容")));
  }
  private exportDraft():void{
    const blob=new Blob([`# ${this.title.value}\n\n${this.description.value}\n\n---\n状态：${this.status.value}\n负责人：${this.assignee.value}\n项目：${this.project.value}\n项目目标：${this.goal.value}\n工作目录：${this.workdir.value}\n模型：${this.model.value}\n最长时间：${this.timeout.value}\n\n未提交讨论：\n${this.commentDraft?.value??""}`],{type:"text/markdown;charset=utf-8"});
    const url=URL.createObjectURL(blob),anchor=h("a",{href:url,download:`lumio-draft-${this.record.id}.md`});anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  private async saveFields():Promise<void>{
    if(this.busy)return;let request:WorkCommandRequest|undefined;
    if(this.record.type==="task"){
      request=taskFieldsCommand(this.record,{title:this.title.value,status:this.status.value as WorkTask["status"],assignee:this.assignee.value.trim(),project:this.project.value});
      const patch:Record<string,unknown>=request?.operation.op==="work.task.update"?{...request.operation.args.patch}:{};
      for(const [key,value,old] of [["workdir",this.workdir.value.trim()||null,this.record.workdir??null],["model",this.model.value.trim()||null,this.record.model??null],["timeout_minutes",this.timeout.value?Number(this.timeout.value):null,this.record.timeout_minutes??null]] as const)if(value!==old)patch[key]=value;
      if(Object.keys(patch).length)request={request_id:request?.request_id??newRequestId(),operation:{op:"work.task.update",args:{task:this.record.id,expected_revision:this.record.revision,patch}}} as WorkCommandRequest;
    }else{
      request=projectFieldsCommand(this.record,{title:this.title.value,status:this.status.value as WorkProject["status"]});
      const patch:Record<string,unknown>=request?.operation.op==="work.project.update"?{...request.operation.args.patch}:{};
      if((this.goal.value.trim()||null)!==(this.record.goal??null))patch.goal=this.goal.value.trim()||null;
      if(Object.keys(patch).length)request={request_id:request?.request_id??newRequestId(),operation:{op:"work.project.update",args:{project:this.record.id,expected_revision:this.record.revision,patch}}} as WorkCommandRequest;
    }
    if(!request)return;const savedFields=this.fieldsKey();this.setBusy(true);clear(this.note);
    try{const result=await this.client.workCommand(request);if(result.kind!=="task"&&result.kind!=="project")throw new Error();
      this.record=result.kind==="task"?result.task:result.project;this.heading.textContent=this.record.title;this.structuralBase=savedFields;clear(this.note,h("p",{class:"success",role:"status"},"属性已保存"));this.changed();
    }catch(error){this.showFailure(error);}finally{this.setBusy(false);}
  }
  private async saveDescription():Promise<void>{
    if(this.busy||this.description.value===this.baseDescription)return;this.setBusy(true);clear(this.note);const description=this.description.value;
    const request={request_id:newRequestId(),operation:{op:this.record.type==="task"?"work.task.update":"work.project.update",args:{[this.record.type]:this.record.id,expected_revision:this.record.revision,patch:{description}}}} as WorkCommandRequest;
    try{const result=await this.client.workCommand(request);if(result.kind!=="task"&&result.kind!=="project")throw new Error();this.record=result.kind==="task"?result.task:result.project;this.baseDescription=description;
      this.root.querySelector(".description-preview")!.innerHTML=renderMarkdown(description);clear(this.note,h("p",{class:"success",role:"status"},"正文已保存"));this.changed();
    }catch(error){this.showFailure(error);}finally{this.setBusy(false);}
  }
  private comments(input:WorkTaskDetail):void{
    const messages=h("div",{class:"discussion"},...input.comments.map(comment=>{const body=h("div",{class:"markdown"});body.innerHTML=renderMarkdown(comment.body);return h("article",{},h("p",{class:"muted"},formatTime(comment.created)),body);}));
    const text=h("textarea",{name:"comment",rows:"3",required:true,placeholder:"补充想法、反馈或下一轮要回答的问题"}),error=h("div",{role:"alert"});
    this.commentDraft=text;
    const submit=this.button("添加讨论",()=>{});submit.type="submit";const form=h("form",{class:"form-stack"},field("补充讨论",text),submit,error);
    let requestId=newRequestId(),previous="";
    form.addEventListener("submit",async e=>{e.preventDefault();if(this.busy||!text.value.trim())return;this.setBusy(true);clear(error);if(previous&&previous!==text.value)requestId=newRequestId();previous=text.value;
      try{const result=await this.client.workCommand(commentCommand(input.task.id,text.value,requestId));if(result.kind!=="comment")throw new Error();const body=h("div",{class:"markdown"});body.innerHTML=renderMarkdown(result.comment.body);messages.append(h("article",{},h("p",{class:"muted"},formatTime(result.comment.created)),body));text.value="";requestId=newRequestId();previous="";}
      catch(cause){clear(error,failure(`${errorText(cause)}。输入已保留，请先核对是否已添加。`));}finally{this.setBusy(false);}});
    this.root.append(h("section",{class:"detail-section"},h("h3",{},"讨论"),messages,form));
  }
  private async dispatch():Promise<void>{
    if(this.record.type!=="task"||this.busy)return;if(this.dirty){clear(this.note,failure("请先保存修改或提交讨论，再派出这一轮。"));return;}
    this.setBusy(true);
    try{
      const targets=engineTargets(await this.client.runtimes());if(!this.active||!this.root.isConnected)return;
      const target=select("dispatch-target",[["","请选择执行器和引擎"],...targets.map(t=>[t.target,t.label] as [string,string])]);target.required=true;
      const formId=`dispatch-${newRequestId()}`,error=h("div",{role:"alert"}),form=h("form",{id:formId,class:"form-stack"},h("p",{},`将派出「${this.record.title}」当前已保存的内容。`),field("执行目标",target),h("p",{class:"muted"},`目录：${this.record.workdir??"~（执行器主目录）"} · 最长 ${this.record.timeout_minutes??120} 分钟`),!targets.length&&empty("尚未登记执行引擎，请先连接执行器。"),error);
      const submit=h("button",{type:"submit",form:formId,class:"btn btn-primary",disabled:!targets.length},"确认派出"),dialog=openDialog("派出新的一轮",form,[submit]);
      let pending=false,requestId=newRequestId(),previousTarget="";const task=this.record;
      form.addEventListener("submit",async e=>{e.preventDefault();if(pending)return;if(previousTarget&&previousTarget!==target.value)requestId=newRequestId();previousTarget=target.value;pending=true;submit.disabled=true;
        try{await this.client.workCommand(dispatchCommand(task,target.value,requestId));dialog.close();if(this.active){this.structuralBase=this.fieldsKey();this.baseDescription=this.description.value;this.changed();this.reload();}}
        catch(cause){clear(error,failure(`${errorText(cause)}。请先查看执行记录，确认是否已派出。`));submit.disabled=false;pending=false;}});
    }catch(cause){if(this.active)this.showFailure(cause);}finally{this.setBusy(false);}
  }
}

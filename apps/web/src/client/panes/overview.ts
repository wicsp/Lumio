import type { Job, SearchResult, WorkProject, WorkTask } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { formatTime } from "../commands.ts";
import { clear, empty, failure, h, icon, loading } from "../dom.ts";
import { JOB_LABELS, TASK_LABELS } from "../labels.ts";
export type Destination="work"|"knowledge"|"execution"|"assistant"|"approvals";

export class OverviewPane {
  private root=h("div",{class:"dashboard"});
  private generation=0;
  private active=true;
  constructor(owner:HTMLElement,private client:Client,private navigate:(section:Destination,id?:string)=>void=()=>{}){
    const date=new Intl.DateTimeFormat("zh-CN",{month:"long",day:"numeric",weekday:"long"}).format(new Date());
    owner.append(h("header",{class:"pane-head dashboard-heading"},h("div",{class:"heading-group"},h("p",{class:"eyebrow"},date),h("h1",{},"我的工作台"),h("p",{class:"page-subtitle"},"连接知识，推进重要的事。")),
      h("button",{type:"button",class:"btn btn-ghost","aria-label":"刷新总览",onclick:()=>this.load()},icon("refresh"))),this.root);void this.load();
  }
  dispose():void{this.active=false;this.generation++;}
  private stat(title:string,value:number|undefined,detail:string,section:Destination,iconName:string):HTMLElement{
    return h("button",{type:"button",class:"metric",onclick:()=>this.navigate(section)},h("div",{class:"metric-top"},h("span",{},title),icon(iconName)),h("strong",{class:"metric-value"},value===undefined?"—":value),h("span",{class:"metric-detail"},detail));
  }
  private panel(title:string,section:Destination,body:HTMLElement,label="查看全部"):HTMLElement{
    return h("section",{class:"dashboard-panel"},h("header",{},h("h2",{},title),h("button",{type:"button",class:"text-button",onclick:()=>this.navigate(section)},label," →")),body);
  }
  private async load():Promise<void>{
    const generation=++this.generation;clear(this.root,loading("正在整理你的工作台…"));
    const [tasks,projects,jobs,approvals,notes]=await Promise.allSettled([this.client.workTasks(),this.client.workProjects(),this.client.jobs(),this.client.proposals("pending"),this.client.search("",{type:"paper",limit:4})]);
    if(!this.active||generation!==this.generation)return;
    const taskData=tasks.status==="fulfilled"?tasks.value:undefined,projectData=projects.status==="fulfilled"?projects.value:undefined,jobData=jobs.status==="fulfilled"?jobs.value:undefined;
    const open=taskData?.filter(task=>!["done","cancelled"].includes(task.status));
    const stats=h("div",{class:"metrics"},
      this.stat("未完成任务",open?.length,taskData?`${taskData.filter(task=>task.status==="active").length} 项进行中 · ${taskData.filter(task=>task.status==="waiting").length} 项等待中`:"任务暂不可用","work","work"),
      this.stat("进行中项目",projectData?.filter(project=>project.status==="active").length,projectData?`共 ${projectData.length} 个项目`:"项目暂不可用","work","knowledge"),
      this.stat("正在执行",jobData?.filter(job=>["queued","assigned","running"].includes(job.status)).length,jobData?`${jobData.filter(job=>job.status==="failed").length} 次失败运行待核对`:"执行暂不可用","execution","execution"),
      this.stat("等待你的决定",approvals.status==="fulfilled"?approvals.value.length:undefined,approvals.status==="fulfilled"?(approvals.value.length?"有申请等待你确认":"暂时没有待审批的申请"):"审批暂不可用","approvals","approvals"));
    const tasksBody=h("div",{class:"dashboard-task-list"});
    if(tasks.status==="rejected")tasksBody.append(failure(errorText(tasks.reason)));
    else{
      const rank:Record<string,number>={active:0,todo:1,waiting:2,paused:3};
      const selected=open!.slice().sort((a,b)=>(rank[a.status]??4)-(rank[b.status]??4)).slice(0,5);
      tasksBody.append(...selected.map(task=>h("button",{type:"button",class:"dashboard-task",onclick:()=>this.navigate("work",task.id)},h("span",{class:`status-mark status-${task.status}`,"aria-hidden":"true"}),
        h("span",{class:"row-main"},h("strong",{},task.title),h("span",{class:"muted"},projectData?.find(project=>project.id===task.project)?.title??"独立任务")),h("span",{class:`badge status-${task.status}`},TASK_LABELS[task.status]))),...(!selected.length?[empty("把一件值得推进的事，放进任务里。")]:[]));
    }
    const projectsBody=h("div",{class:"dashboard-projects"});
    if(projects.status==="rejected")projectsBody.append(failure(errorText(projects.reason)));
    else projectsBody.append(...projects.value.filter(project=>project.status!=="done").slice(0,3).map(project=>{
      const related=taskData?.filter(task=>task.project===project.id&&task.status!=="cancelled"),done=related?.filter(task=>task.status==="done").length;
      return h("button",{type:"button",class:"project-summary",onclick:()=>this.navigate("work",project.id)},h("strong",{},project.title),h("p",{class:"muted"},project.goal??"明确目标，让每一步都有所指向。"),
        related&&related.length>0?h("div",{class:"project-progress"},h("progress",{value:done??0,max:related.length,"aria-label":`${project.title}任务完成进度`}),h("span",{class:"muted"},`${done} / ${related.length} 项已完成`)):h("span",{class:"muted"},taskData?"尚未添加任务":"任务数据暂不可用"));
    }),...(!projects.value.length?[empty("用项目承接一个长期目标。")]:[]));
    const notesBody=h("div",{class:"dashboard-notes"});
    if(notes.status==="rejected")notesBody.append(failure(`知识库暂不可用：${errorText(notes.reason)}`));
    else notesBody.append(...notes.value.hits.map(hit=>h("button",{type:"button",class:"reading-item",onclick:()=>this.navigate("knowledge",hit.note.id??hit.note.path)},h("span",{class:"paper-symbol","aria-hidden":"true"},icon("knowledge")),h("span",{class:"row-main"},h("strong",{},hit.note.title),h("span",{class:"muted"},hit.snippet||hit.note.citekey||"打开笔记阅读")))));
    const runs=h("div",{class:"dashboard-runs"});
    if(jobs.status==="rejected")runs.append(failure(errorText(jobs.reason)));
    else runs.append(...jobs.value.slice().reverse().slice(0,3).map(job=>h("button",{type:"button",class:"run-summary",onclick:()=>this.navigate("execution",job.spec.id)},h("span",{class:`status-mark status-${job.status}`,"aria-hidden":"true"}),
      h("span",{class:"row-main"},h("strong",{},taskData?.find(task=>task.id===job.spec.source?.task)?.title??(job.spec.run.kind==="agent"?`${job.spec.run.engine} 运行`:"独立运行")),h("span",{class:"muted"},formatTime(job.spec.created))),h("span",{class:`badge status-${job.status}`},JOB_LABELS[job.status]))),...(!jobs.value.length?[empty("执行记录会在派出工作后显示。")]:[]));
    const assistant=h("section",{class:"assistant-invitation"},h("span",{class:"assistant-symbol"},icon("assistant")),h("p",{class:"eyebrow"},"LUMIO ASSISTANT"),h("h2",{},"一起，把问题想清楚"),h("p",{},"梳理零散的线索，为下一步找到一个清晰的起点。"),h("button",{type:"button",class:"btn btn-primary",onclick:()=>this.navigate("assistant")},"打开助手",h("span",{"aria-hidden":"true"},"↗")));
    clear(this.root,stats,h("div",{class:"dashboard-columns"},h("div",{class:"dashboard-main"},this.panel("接下来要做","work",tasksBody),this.panel("项目进展","work",projectsBody),this.panel("运行动态","execution",runs)),h("aside",{class:"dashboard-aside"},this.panel("知识书架","knowledge",notesBody,"打开知识库"),assistant)));
  }
}

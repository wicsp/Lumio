import { JOB_STATUSES, type Job, type StoredArtifact, type ExecutionRoutineInfo } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { formatTime, safeFileName, verifyArtifact, routineStatusCommand } from "../commands.ts";
import { clear, empty, failure, field, h, icon, loading, openDialog, select } from "../dom.ts";
import { JOB_LABELS } from "../labels.ts";
import { renderMarkdown } from "../utils/markdown.ts";
import { editRoutine } from "./routine-editor.ts";

export class ExecutionPane {
  private list=h("div",{class:"list"});
  private detail=h("section",{class:"reader"},empty("选择一次运行，查看结果与产物"));
  private mode:"jobs"|"routines"|"devices"="jobs";
  private status=select("job-status",[["","全部执行状态"],...JOB_STATUSES.map(s=>[s,JOB_LABELS[s]!] as [string,string])]);
  private listGeneration=0;
  private detailGeneration=0;
  private active=true;
  private timer:ReturnType<typeof setInterval>;
  private job?:string;
  private currentJob?:Job;
  private cancellationRequested=new Set<string>();
  constructor(private root:HTMLElement,private client:Client,initialJob?:string){
    const tabs=h("div",{class:"tabs","aria-label":"执行视图"});
    const create=h("button",{type:"button",class:"btn btn-primary",hidden:true,onclick:()=>editRoutine(this.root,this.client,()=>this.load())},"＋ 新建例行任务");
    for(const [mode,label] of [["jobs","运行记录"],["routines","例行任务"],["devices","设备"]] as const){
      const button=h("button",{type:"button",class:"btn btn-small","aria-pressed":String(mode===this.mode),onclick:()=>{
        this.mode=mode;this.job=undefined;this.detailGeneration++;this.status.closest("label")!.toggleAttribute("hidden",mode!=="jobs");create.hidden=mode!=="routines";
        tabs.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",String(b===button)));clear(this.detail,empty(mode==="jobs"?"选择一次运行，查看结果与产物":""));void this.load();
      }},label);tabs.append(button);
    }
    this.status.addEventListener("change",()=>void this.load());
    root.append(h("header",{class:"pane-head"},h("div",{class:"heading-group"},h("p",{class:"eyebrow"},"EXECUTION"),h("h1",{},"执行")),tabs,
      h("button",{type:"button",class:"btn btn-ghost","aria-label":"刷新执行记录",onclick:()=>this.refresh()},icon("refresh")),create),
      h("div",{class:"execution-filter"},field("运行状态",this.status)),h("div",{class:"split execution-split"},this.list,this.detail));
    void this.load();if(initialJob)void this.openJob(initialJob);
    this.timer=setInterval(()=>{if(document.visibilityState==="visible"&&this.mode==="jobs"){void this.load(true);if(this.currentJob&&["queued","assigned","running"].includes(this.currentJob.status)&&this.job)void this.pollJob(this.job);}},5000);
  }
  dispose():void{this.active=false;this.listGeneration++;this.detailGeneration++;clearInterval(this.timer);}
  private async pollJob(id:string):Promise<void>{
    try{const job=await this.client.job(id);if(this.active&&this.job===id&&this.currentJob&&job.status!==this.currentJob.status)void this.openJob(id,true);}catch{/* The next refresh can recover; do not erase a reading pane on transient poll failure. */}
  }
  private refresh():void{void this.load();if(this.job)void this.openJob(this.job);}
  private async load(quiet=false):Promise<void>{
    const generation=++this.listGeneration;if(!quiet)clear(this.list,loading());
    try{
      if(this.mode==="jobs"){
        const jobs=await this.client.jobs((this.status.value||undefined) as Job["status"]|undefined);if(!this.active||generation!==this.listGeneration)return;
        clear(this.list,...jobs.slice().reverse().map(job=>h("button",{type:"button",class:"row row-button",onclick:()=>this.openJob(job.spec.id)},
          h("span",{class:`status-mark status-${job.status}`,"aria-hidden":"true"}),h("span",{class:"row-main"},h("strong",{},job.spec.source?.task?`任务 · 第 ${job.spec.source.round} 轮`:job.spec.source?.routine?"例行任务运行":job.spec.run.kind==="agent"?`${job.spec.run.engine} 运行`:job.spec.run.argv.join(" ")),h("span",{class:"muted"},formatTime(job.spec.created))),h("span",{class:`badge status-${job.status}`},JOB_LABELS[job.status]))),!jobs.length&&empty("还没有运行记录。可以从任务详情明确派出一轮。"));
      }else if(this.mode==="routines"){
        const routines=await this.client.executionRoutines();if(!this.active||generation!==this.listGeneration)return;
        clear(this.list,...routines.map(r=>this.routineRow(r)),!routines.length&&empty("还没有例行任务。创建一个计划，让重复工作按时推进。"));
      }else{
        const runtimes=await this.client.runtimes();if(!this.active||generation!==this.listGeneration)return;
        clear(this.list,...runtimes.map(runtime=>h("article",{class:"device-card"},h("div",{class:"row"},h("strong",{},runtime.registration.name),h("span",{class:`badge ${runtime.online?"status-active":"status-paused"}`},runtime.online?"在线":"离线")),
          h("p",{class:"muted"},`最近连接 ${formatTime(runtime.last_seen)} · 同时运行 ${runtime.registration.max_concurrent} 项`),h("ul",{},...runtime.registration.engines.map(engine=>h("li",{},`${engine.name} · ${engine.version} · ${engine.sandbox==="os"?"系统隔离":"未启用系统隔离"}`))),
          runtime.registration.tags.length>0&&h("p",{class:"muted"},runtime.registration.tags.join(" · ")))),!runtimes.length&&empty("尚未连接执行器。在已配置的终端使用 lumio runtime add 添加设备。"));
      }
    }catch(cause){if(this.active&&generation===this.listGeneration)clear(this.list,failure(errorText(cause),()=>this.load()));}
  }
  private routineRow(info:ExecutionRoutineInfo):HTMLElement{
    const routine=info.routine;
    return h("article",{class:"routine-row"},h("div",{class:"row"},h("div",{class:"row-main"},h("strong",{},routine.title),h("span",{class:"muted"},`${routine.schedule} · ${routine.timezone}`)),h("span",{class:`badge status-${routine.status}`},routine.status==="active"?"已启用":"已暂停")),
      h("p",{class:"muted"},info.problem??(info.next?`下次 ${formatTime(info.next,routine.timezone)}`:"暂无下一次运行")),
      h("div",{class:"button-row"},h("button",{type:"button",class:"btn btn-small",onclick:()=>editRoutine(this.root,this.client,()=>this.load(),routine)},"编辑"),
        h("button",{type:"button",class:"btn btn-small",onclick:async(event:Event)=>{const button=event.currentTarget as HTMLButtonElement;button.disabled=true;try{await this.client.executionCommand(routineStatusCommand(routine,routine.status==="active"?"paused":"active"));void this.load();}catch(cause){openDialog("计划尚未更新",failure(`${errorText(cause)}。请刷新计划后核对。`),[]);}finally{button.disabled=false;}}},routine.status==="active"?"暂停":"启用"),
        info.last&&h("button",{type:"button",class:"btn btn-small",onclick:()=>this.openJob(info.last!.job)},"查看上次结果")));
  }
  private async openJob(id:string,quiet=false):Promise<void>{
    const generation=++this.detailGeneration;this.job=id;if(!quiet)clear(this.detail,loading());
    try{
      const job=await this.client.job(id);if(!this.active||generation!==this.detailGeneration)return;this.currentJob=job;
      const report=h("div",{class:"markdown"});report.innerHTML=renderMarkdown(job.result?.report??"");
      const artifacts=h("div",{class:"artifact-list"}),includePrivate=h("input",{type:"checkbox",name:"private-artifacts"});let artifactGeneration=0;
      const readArtifacts=async()=>{const request=++artifactGeneration;clear(artifacts,loading("正在查找产物…"));const privateScope=includePrivate.checked;
        try{const files=await this.client.jobArtifacts(id,{includePrivate:privateScope});if(!this.active||generation!==this.detailGeneration||request!==artifactGeneration||privateScope!==includePrivate.checked)return;
          clear(artifacts,...files.map(file=>this.artifactRow(file,()=>privateScope===includePrivate.checked&&generation===this.detailGeneration,privateScope)),!files.length&&empty("暂无已归档产物。执行结果与文件归档可能分别到达。"));
        }catch(cause){if(this.active&&generation===this.detailGeneration&&request===artifactGeneration)clear(artifacts,failure(errorText(cause)));}};
      includePrivate.addEventListener("change",()=>{artifactGeneration++;clear(artifacts);void readArtifacts();});
      const metadata:Array<[string,string]>=[["运行编号",job.spec.id],["状态",JOB_LABELS[job.status]!],["工作目录",job.spec.workdir],["创建时间",formatTime(job.spec.created)],["最长运行时间",`${Math.round(job.spec.timeout_seconds/60)} 分钟`]];
      if(job.result?.finished)metadata.push(["结束时间",formatTime(job.result.finished)]);if(job.result?.exit_code!==undefined)metadata.push(["退出码",String(job.result.exit_code)]);
      clear(this.detail,h("p",{class:"eyebrow"},"RUN"),h("h2",{},JOB_LABELS[job.status]!),h("dl",{class:"detail-list"},...metadata.flatMap(([key,value])=>[h("dt",{},key),h("dd",{},value)])),
        job.status==="unknown"&&failure("这次运行的结果无法确认。请先核查设备和产物，不会自动重跑。"),job.result?.error&&failure(job.result.error),
        this.cancellationRequested.has(id)&&["queued","assigned","running"].includes(job.status)&&h("p",{class:"success",role:"status"},"取消请求已提交，正在等待设备确认。"),
        job.result?.question&&h("section",{class:"question-box"},h("h3",{},"等待你的回答"),h("p",{},job.result.question)),
        job.spec.run.kind==="command"&&h("pre",{},job.spec.run.argv.map(arg=>JSON.stringify(arg)).join(" ")),report,
        ["queued","assigned","running"].includes(job.status)&&h("button",{type:"button",class:"btn btn-danger",disabled:this.cancellationRequested.has(id),onclick:()=>this.cancel(job)},"取消这轮执行"),
        h("section",{class:"detail-section"},h("h3",{},"文件与日志"),h("label",{class:"check"},includePrivate,"包含私密产物"),artifacts));
      void readArtifacts();
    }catch(cause){if(this.active&&generation===this.detailGeneration)clear(this.detail,failure(errorText(cause)));}
  }
  private artifactRow(file:StoredArtifact,current:()=>boolean,includePrivate:boolean):HTMLElement{
    const status=h("span",{class:"muted"},`${file.status==="ready"?"已归档":"交付中"} · ${(file.size/1024).toFixed(1)} KB`),message=h("span",{role:"status",class:"muted"});
    const button=h("button",{type:"button",class:"btn btn-small",disabled:file.status!=="ready",onclick:async()=>{
      button.disabled=true;message.textContent="正在下载并校验…";
      try{
        const response=await this.client.artifactContent(file.id,{includePrivate}),bytes=await response.arrayBuffer();
        if(!this.active||!current())return;
        if(!await verifyArtifact(bytes,file))throw new Error("FILE_INTEGRITY");
        if(!this.active||!current())return;
        const url=URL.createObjectURL(new Blob([bytes],{type:file.media_type}));const name=safeFileName(file.key);
        const anchor=h("a",{href:url,download:name});anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message.textContent="已校验并开始保存";
      }catch(cause){message.textContent=cause instanceof Error&&cause.message==="FILE_INTEGRITY"?"文件校验未通过，已停止保存":errorText(cause);}finally{button.disabled=false;}
    }},"下载");
    return h("article",{class:"artifact-row"},h("div",{class:"row-main"},h("strong",{},file.media_type.includes("jsonl")?"运行过程记录":file.media_type==="text/plain"?"运行日志":file.key),status),button,message);
  }
  private cancel(job:Job):void{
    const error=h("div",{role:"alert"}),button=h("button",{type:"button",class:"btn btn-danger",onclick:async()=>{button.disabled=true;try{await this.client.cancelJob(job.spec.id);this.cancellationRequested.add(job.spec.id);dialog.close();this.refresh();}catch(cause){clear(error,failure(`${errorText(cause)}。请先刷新核对当前状态。`));button.disabled=false;}}},"确认取消");
    const dialog=openDialog("取消这轮执行",h("div",{},h("p",{},"取消请求会交给负责这轮工作的设备，停止执行可能需要片刻。"),h("code",{},job.spec.id),error),[button]);
  }
}

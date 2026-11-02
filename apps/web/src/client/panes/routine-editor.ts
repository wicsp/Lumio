import type { ExecutionRoutine } from "@lumio/schema";
import { errorText, isConflict, type Client } from "../api.ts";
import { engineTargets, newRequestId, routineCreateCommand, routineUpdateCommand, type RoutineDraft } from "../commands.ts";
import { clear, empty, failure, field, h, loading, openDialog, select } from "../dom.ts";

export async function editRoutine(owner:HTMLElement,client:Client,changed:()=>void,routine?:ExecutionRoutine):Promise<void>{
  const wait=h("div",{},loading("正在读取执行器能力…"));const dialog=openDialog(routine?"编辑例行任务":"新建例行任务",wait,[]);
  try{
    const targets=engineTargets(await client.runtimes());if(!owner.isConnected){dialog.close();return;}
    if(routine&&!targets.some(target=>target.target===routine.assignee))targets.push({target:routine.assignee,label:`${routine.assignee}（当前计划目标）`,online:false});
    const title=h("input",{name:"routine-title",required:true}),description=h("textarea",{name:"routine-description",rows:"7"}),schedule=h("input",{name:"schedule",required:true,placeholder:"0 9 * * 1"});
    const timezone=h("input",{name:"timezone",required:true}),target=select("routine-target",[["","请选择执行器和引擎"],...targets.map(item=>[item.target,item.label] as [string,string])],routine?.assignee);target.required=true;
    const context=select("routine-context",[["none","每次独立执行"],["previous","带上上次结果摘要"]],routine?.context??"none");
    const workdir=h("input",{name:"routine-workdir",placeholder:"~（执行器主目录）"}),timeout=h("input",{name:"routine-timeout",type:"number",min:"1",step:"1",placeholder:"120"});
    const status=select("routine-status",[["paused","暂停，保存后先不运行"],["active","启用，保存后按计划运行"]],routine?.status??"paused");
    title.value=routine?.title??"";description.value=routine?.description??"";schedule.value=routine?.schedule??"0 9 * * 1";timezone.value=routine?.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone;
    workdir.value=routine?.workdir??"";timeout.value=routine?.timeout_minutes?.toString()??"";
    const message=h("div",{role:"alert"}),formId=`routine-${newRequestId()}`;
    const form=h("form",{id:formId,class:"form-stack"},field("名称",title),field("每次要做的事（Markdown）",description),field("执行目标",target),
      h("div",{class:"field-row"},field("计划",schedule,"5 段 cron：分、时、日、月、星期；例如每周一 09:00 为 0 9 * * 1"),field("时区",timezone)),field("状态",status),field("上下文",context),field("工作目录",workdir),field("最长运行时间（分钟）",timeout),
      !targets.length&&empty("请先连接一个登记了执行引擎的设备。"),message);
    const save=h("button",{type:"submit",form:formId,class:"btn btn-primary",disabled:!targets.length},"保存计划");
    clear(wait,form);dialog.querySelector(".dialog-foot")!.append(save);
    let pending=false,requestId=newRequestId(),previous="";
    form.addEventListener("submit",async event=>{
      event.preventDefault();if(pending)return;
      const draft:RoutineDraft={title:title.value,description:description.value,schedule:schedule.value,timezone:timezone.value,assignee:target.value,context:context.value as RoutineDraft["context"],workdir:workdir.value,timeout_minutes:timeout.value};
      const key=JSON.stringify([draft,status.value]);if(previous&&previous!==key)requestId=newRequestId();previous=key;
      let request=routine?routineUpdateCommand(routine,draft,requestId):routineCreateCommand(draft,requestId);
      if(routine){if(!request&&status.value===routine.status){dialog.close();return;}request??={request_id:requestId,operation:{op:"execution.routine.update",args:{routine:routine.id,expected_revision:routine.revision,patch:{status:status.value as ExecutionRoutine["status"]}}}};
        if(request.operation.op==="execution.routine.update"&&status.value!==routine.status)request.operation.args.patch.status=status.value as ExecutionRoutine["status"];
      }else if(request?.operation.op==="execution.routine.create")request.operation.args.status=status.value as ExecutionRoutine["status"];
      if(!request)return;pending=true;save.disabled=true;clear(message);
      try{await client.executionCommand(request);dialog.close();if(owner.isConnected)changed();}
      catch(cause){clear(message,failure(isConflict(cause)?"计划已有新版本。你的修改仍在这里，请先复制保存，再关闭窗口刷新核对。":`${errorText(cause)}。输入已保留；连接中断时先刷新核对是否已保存。`));}
      finally{pending=false;save.disabled=false;}
    });title.focus();
  }catch(cause){clear(wait,failure(errorText(cause)));}
}

import type { ExecutionRoutine } from "@lumio/schema";
import { errorText, isConflict, type Client } from "../api.ts";
import { engineTargets, newRequestId, routineCreateCommand, routineUpdateCommand, type RoutineDraft } from "../commands.ts";
import { clear, empty, failure, field, h, loading, openDialog, select } from "../dom.ts";
import { t } from "../i18n.ts";

export async function editRoutine(owner:HTMLElement,client:Client,changed:()=>void,routine?:ExecutionRoutine):Promise<void>{
  const wait=h("div",{},loading(t("Reading runtime capabilities…")));const dialog=openDialog(routine?t("Edit routine"):t("New routine"),wait,[]);
  try{
    const targets=engineTargets(await client.runtimes());if(!owner.isConnected){dialog.close();return;}
    if(routine&&!targets.some(target=>target.target===routine.assignee))targets.push({target:routine.assignee,label:t("{0} (current target)", routine.assignee),online:false});
    const title=h("input",{name:"routine-title",required:true}),description=h("textarea",{name:"routine-description",rows:"7"}),schedule=h("input",{name:"schedule",required:true,placeholder:"0 9 * * 1"});
    const timezone=h("input",{name:"timezone",required:true}),target=select("routine-target",[["",t("Choose a runtime and engine")],...targets.map(item=>[item.target,item.label] as [string,string])],routine?.assignee);target.required=true;
    const context=select("routine-context",[["none",t("Run independently each time")],["previous",t("Include a summary of the last result")]],routine?.context??"none");
    const workdir=h("input",{name:"routine-workdir",placeholder:t("~ (runtime's home directory)")}),timeout=h("input",{name:"routine-timeout",type:"number",min:"1",step:"1",placeholder:"120"});
    const status=select("routine-status",[["paused",t("Paused — don't run after saving")],["active",t("Enabled — run on schedule after saving")]],routine?.status??"paused");
    title.value=routine?.title??"";description.value=routine?.description??"";schedule.value=routine?.schedule??"0 9 * * 1";timezone.value=routine?.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone;
    workdir.value=routine?.workdir??"";timeout.value=routine?.timeout_minutes?.toString()??"";
    const message=h("div",{role:"alert"}),formId=`routine-${newRequestId()}`;
    const form=h("form",{id:formId,class:"form-stack"},field(t("Name"),title),field(t("What to do each time (Markdown)"),description),field(t("Target"),target),
      h("div",{class:"field-row"},field(t("Schedule"),schedule,t("5-field cron: minute, hour, day, month, weekday. Mondays at 09:00 is 0 9 * * 1")),field(t("Time zone"),timezone)),field(t("Status"),status),field(t("Context"),context),field(t("Working directory"),workdir),field(t("Time limit (minutes)"),timeout),
      !targets.length&&empty(t("Connect a device with a registered engine first.")),message);
    const save=h("button",{type:"submit",form:formId,class:"btn btn-primary",disabled:!targets.length},t("Save routine"));
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
      catch(cause){clear(message,failure(isConflict(cause)?t("This routine has a newer version. Your changes are still here — copy them, then close and refresh."):t("{0} Your input is kept; if the connection dropped, refresh to check whether it was saved.", errorText(cause))));}
      finally{pending=false;save.disabled=false;}
    });title.focus();
  }catch(cause){clear(wait,failure(errorText(cause)));}
}

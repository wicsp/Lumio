import type { AssistantConversation, AssistantConversationDetail, AssistantMemory, AssistantChatRequest } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { formatTime, newRequestId } from "../commands.ts";
import { clear, empty, failure, field, h, icon, loading, openDialog } from "../dom.ts";
import { renderMarkdown } from "../utils/markdown.ts";
const TURN_LABEL:Record<string,string>={running:"仍在处理",done:"已完成",failed:"未完成",unknown:"结果不明，请先核查",cancelled:"已取消"};

export class AssistantPane {
  private conversations=h("div",{class:"conversation-list"});
  private messages=h("div",{class:"chat-messages",role:"log","aria-label":"对话消息"});
  private body=h("section",{class:"chat-main"});
  private text=h("textarea",{name:"chat-message",rows:"3",required:true,placeholder:"写下问题，或一起梳理下一步…"});
  private model=h("input",{name:"chat-model",placeholder:"使用 Hub 已配置的模型"});
  private send=h("button",{type:"submit",class:"btn btn-primary"},"发送");
  private stop=h("button",{type:"button",class:"btn",hidden:true,onclick:()=>this.controller?.abort()},"停止接收");
  private notice=h("div",{class:"chat-notice",role:"status"});
  private chat:hType;
  private memory:hType;
  private current?:string;
  private controller?:AbortController;
  private sending=false;
  private serverRunning=false;
  private composer:HTMLFormElement;
  private active=true;
  private generation=0;
  private mode:"chat"|"memory"="chat";
  private uncertain?:AssistantChatRequest;
  constructor(private root:HTMLElement,private client:Client){
    this.chat=h("button",{type:"button",class:"btn btn-small","aria-pressed":"true",onclick:()=>this.switchMode("chat")},"对话");
    this.memory=h("button",{type:"button",class:"btn btn-small","aria-pressed":"false",onclick:()=>this.switchMode("memory")},"显式记忆");
    const form=h("form",{class:"chat-composer"},field("你的消息",this.text),h("details",{},h("summary",{},"本轮模型"),field("模型名称",this.model,"只切换当前服务支持的模型，不改变服务地址或权限")),h("div",{class:"composer-actions"},h("span",{class:"muted"},"Enter 发送 · Shift + Enter 换行"),this.stop,this.send));
    this.composer=form;
    form.addEventListener("submit",event=>{event.preventDefault();void this.submit();});
    this.text.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing){event.preventDefault();form.requestSubmit();}});
    this.body.append(this.notice,this.messages,form);
    root.append(h("header",{class:"pane-head"},h("div",{class:"heading-group"},h("p",{class:"eyebrow"},"ASSISTANT"),h("h1",{},"AI 助手")),h("div",{class:"tabs"},this.chat,this.memory),
      h("button",{type:"button",class:"btn btn-ghost","aria-label":"刷新对话",onclick:()=>this.refresh()},icon("refresh"))),
      h("div",{class:"assistant-layout"},h("aside",{class:"conversation-sidebar"},h("button",{type:"button",class:"btn new-conversation",onclick:()=>this.newConversation()},"＋ 新对话"),this.conversations),this.body));
    this.showWelcome();void this.loadConversations();
  }
  dispose():void{this.active=false;this.generation++;this.controller?.abort();}
  get dirty():boolean{return this.mode==="chat"?!!this.text.value.trim():!!this.messages.querySelector<HTMLTextAreaElement>("textarea[name=memory-content]")?.value.trim();}
  canLeave():boolean{return this.sending?confirm("助手仍在处理。离开会停止本页接收，之后可查看已保存的对话。确定离开吗？"):!this.dirty||confirm("有尚未提交的草稿，离开会丢弃它。确定继续吗？");}
  private setBusy(busy:boolean):void{
    this.sending=busy;this.send.disabled=busy||this.serverRunning;this.text.disabled=busy;this.stop.hidden=!busy;this.chat.disabled=busy;this.memory.disabled=busy;
    this.root.querySelectorAll<HTMLButtonElement>(".conversation-sidebar button").forEach(button=>button.disabled=busy);
  }
  private showWelcome():void{clear(this.messages,h("div",{class:"chat-welcome"},icon("assistant"),h("h2",{},"把想法，整理成下一步"),h("p",{},"讨论问题、梳理思路，或为研究做一份清晰的计划。"),h("p",{class:"muted"},"助手使用已配置的模型。业务工具和私密访问不会因聊天而自动开放。")));}
  private newConversation():void{if(this.sending)return;if(this.mode!=="chat")this.switchMode("chat");if(this.mode!=="chat")return;this.generation++;this.serverRunning=false;this.setBusy(false);this.current=undefined;this.uncertain=undefined;clear(this.notice);this.showWelcome();this.text.focus();}
  private switchMode(mode:"chat"|"memory"):void{
    if(this.sending||mode===this.mode)return;if(this.mode==="memory"&&this.dirty&&!confirm("有尚未保存的记忆草稿，切换会丢弃它。确定继续吗？"))return;this.mode=mode;this.chat.setAttribute("aria-pressed",String(mode==="chat"));this.memory.setAttribute("aria-pressed",String(mode==="memory"));this.generation++;
    if(mode==="memory"){this.composer.hidden=true;this.notice.hidden=true;void this.loadMemories();}
    else{this.composer.hidden=false;this.notice.hidden=false;if(this.current)void this.open(this.current);else this.showWelcome();}
  }
  private async loadConversations(openFirst=false):Promise<AssistantConversation[]>{
    try{
      const conversations=(await this.client.conversations()).slice().sort((a,b)=>b.updated.localeCompare(a.updated));if(!this.active)return [];
      clear(this.conversations,...conversations.map(conversation=>h("button",{type:"button",class:`conversation-item ${conversation.id===this.current?"selected":""}`,disabled:this.sending,onclick:()=>this.open(conversation.id)},h("strong",{},conversation.title),h("span",{class:"muted"},formatTime(conversation.updated)))),!conversations.length&&empty("还没有对话"));
      if(openFirst&&conversations[0]&&this.mode==="chat")void this.open(conversations[0].id);return conversations;
    }catch(cause){if(this.active)clear(this.conversations,failure(errorText(cause),()=>this.loadConversations()));return [];}
  }
  private async open(id:string):Promise<void>{
    if(this.sending)return;if(this.mode!=="chat")this.switchMode("chat");if(this.mode!=="chat")return;const generation=++this.generation;this.current=id;clear(this.messages,loading());clear(this.notice);
    try{const detail=await this.client.conversation(id);if(!this.active||generation!==this.generation||this.mode!=="chat")return;this.renderDetail(detail);void this.loadConversations();}
    catch(cause){if(this.active&&generation===this.generation)clear(this.messages,failure(errorText(cause)));}
  }
  private renderDetail(detail:AssistantConversationDetail):void{
    this.current=detail.conversation.id;
    clear(this.messages,...detail.messages.map(message=>{
      const content=h("div",{class:"markdown"});content.innerHTML=renderMarkdown(message.content);
      return h("article",{class:`chat-message role-${message.role}`},h("div",{class:"message-label"},message.role==="user"?"你":message.role==="assistant"?"Lumio 助手":"工具结果"),content);
    }));
    const turn=detail.turns.at(-1);this.serverRunning=turn?.status==="running";this.setBusy(this.sending);if(turn&&turn.status!=="done")clear(this.notice,failure(`${TURN_LABEL[turn.status]}${turn.error?`：${turn.error}`:""}`));
    else clear(this.notice);
  }
  private async refresh():Promise<void>{if(this.sending)return;if(this.mode==="memory"){if(this.dirty&&!confirm("刷新会丢弃尚未保存的记忆草稿，确定继续吗？"))return;await this.loadMemories();}else{await this.loadConversations();if(this.current)await this.open(this.current);}}
  private async submit():Promise<void>{
    if(this.sending||this.serverRunning||!this.text.value.trim())return;
    const input={conversation:this.current,message:this.text.value.trim(),...(this.model.value.trim()?{model:this.model.value.trim()}:{})};
    const previous=this.uncertain;const same=previous&&previous.message===input.message&&previous.conversation===input.conversation&&previous.model===input.model;
    const request:AssistantChatRequest={...input,request_id:same?previous.request_id:newRequestId("chat")};this.uncertain=request;
    this.setBusy(true);this.controller=new AbortController();clear(this.notice);this.text.value="";
    if(!this.current)clear(this.messages);
    const user=h("article",{class:"chat-message role-user"},h("div",{class:"message-label"},"你"),h("p",{},request.message));
    const content=h("div",{class:"stream-text"}),tools=h("div",{class:"tool-status",role:"status"}),assistant=h("article",{class:"chat-message role-assistant"},h("div",{class:"message-label"},"Lumio 助手"),content,tools);
    this.messages.append(user,assistant);let complete=false;
    try{
      for await(const event of this.client.assistantEvents(request,this.controller.signal)){
        if(!this.active)return;
        if(event.type==="token")content.textContent=(content.textContent??"")+event.delta;
        else if(event.type==="tool")tools.textContent=`${event.tool.name} · ${event.tool.status==="succeeded"?"已完成":event.tool.status==="unknown"?"结果不明":event.tool.status==="failed"?"未完成":"处理中"}`;
        else if(event.type==="result"){complete=true;this.current=event.messages[0]?.conversation??this.current;}
        else clear(this.notice,failure(event.error));
        this.messages.scrollTop=this.messages.scrollHeight;
      }
    }catch(cause){if(this.active)clear(this.notice,failure(this.controller.signal.aborted?"已停止接收，正在核对已保存的记录…":`${errorText(cause)}。正在核对已保存的记录…`));}
    finally{
      if(this.active){await this.inspect(request,complete);this.setBusy(false);this.controller=undefined;void this.loadConversations();this.text.focus();}
    }
  }
  private async inspect(request:AssistantChatRequest,complete:boolean):Promise<void>{
    try{
      let detail:AssistantConversationDetail|undefined;
      if(this.current)detail=await this.client.conversation(this.current);
      else{
        const conversations=await this.client.conversations();
        for(const conversation of conversations.slice().sort((a,b)=>b.updated.localeCompare(a.updated))){
          const candidate=await this.client.conversation(conversation.id);if(candidate.turns.some(turn=>turn.request_id===request.request_id)){detail=candidate;break;}
          if(!this.active)return;
        }
      }
      if(!this.active)return;
      if(detail&&detail.turns.some(turn=>turn.request_id===request.request_id)){
        this.renderDetail(detail);const turn=detail.turns.find(value=>value.request_id===request.request_id)!;
        if(turn.status==="running")clear(this.notice,failure("服务端仍在处理，可稍后刷新查看。没有重新提交这次请求。"));
        else this.uncertain=undefined;
      }else if(!complete){this.text.value=request.message;clear(this.notice,failure("尚未找到保存记录。草稿已保留，请先核对对话列表后再决定是否发送。"));}
    }catch{if(this.active){this.text.value=request.message;clear(this.notice,failure("暂时无法核对保存记录。草稿已保留，请先恢复连接并查看历史，不会自动重发。"));}}
  }
  private async loadMemories():Promise<void>{
    if(!this.active||this.mode!=="memory")return;
    const generation=++this.generation;clear(this.messages,loading());
    try{
      const memories=await this.client.memories();if(!this.active||generation!==this.generation||this.mode!=="memory")return;
      const text=h("textarea",{name:"memory-content",rows:"3",required:true,placeholder:"例如：先给结论，再解释理由；使用中文。"}),message=h("div",{role:"alert"});
      const save=h("button",{type:"submit",class:"btn btn-primary"},"保存这条记忆"),form=h("form",{class:"form-stack"},field("你明确希望助手记住的偏好或事实",text),save,message);let requestId=newRequestId("memory"),previous="";
      form.addEventListener("submit",async event=>{event.preventDefault();if(save.disabled||!text.value.trim())return;save.disabled=true;
        if(previous&&previous!==text.value)requestId=newRequestId("memory");previous=text.value;
        try{await this.client.memoryCommand({request_id:requestId,operation:{op:"assistant.memory.remember",args:{content:text.value}}});if(this.active)void this.loadMemories();}
        catch(cause){clear(message,failure(`${errorText(cause)}。输入已保留，请先核对列表。`));}finally{save.disabled=false;}});
      clear(this.messages,h("div",{class:"memory-page"},h("h2",{},"只记住你明确保存的内容"),h("p",{class:"muted"},"不会从对话自动提取。遗忘会停止后续使用，已有对话与历史记录仍独立保留。"),form,
        h("div",{class:"memory-list"},...memories.map(memory=>h("article",{class:"memory-item"},h("p",{},memory.content),h("span",{class:"muted"},formatTime(memory.created)),h("button",{type:"button",class:"btn btn-small",onclick:()=>this.forget(memory)},"遗忘"))),!memories.length&&empty("还没有显式记忆。"))));
    }catch(cause){if(this.active&&generation===this.generation)clear(this.messages,failure(errorText(cause),()=>this.loadMemories()));}
  }
  private forget(memory:AssistantMemory):void{
    const message=h("div",{role:"alert"}),button=h("button",{type:"button",class:"btn btn-danger",onclick:async()=>{button.disabled=true;try{await this.client.memoryCommand({request_id:newRequestId("forget"),operation:{op:"assistant.memory.forget",args:{memory:memory.id}}});dialog.close();if(this.active)void this.loadMemories();}catch(cause){clear(message,failure(errorText(cause)));button.disabled=false;}}},"确认遗忘");
    const dialog=openDialog("遗忘这条记忆",h("div",{},h("p",{},memory.content),message),[button]);
  }
}
type hType=HTMLButtonElement;

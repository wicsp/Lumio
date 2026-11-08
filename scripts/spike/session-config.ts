/** Verify per-thread MCP/config isolation without changing global Codex settings. */
import {mkdtemp,mkdir,copyFile,chmod,rm,writeFile} from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import {join,isAbsolute} from "node:path";
import {CodexRpc,shape,type Wire} from "./rpc.ts";
const outAt=process.argv.indexOf("--out"); const out=outAt<0?undefined:process.argv[outAt+1];
if(out&&!isAbsolute(out))throw new Error("--out must be absolute");
if(!process.argv.includes("--use-local-codex-login"))throw new Error("Explicit local-login opt-in required");
const root=await mkdtemp(join(tmpdir(),"lumio-session-config-"));await chmod(root,0o700);const home=join(root,"codex"),cwd=join(root,"workspace");for(const p of [home,cwd])await mkdir(p,{mode:0o700});
await copyFile(join(process.env.CODEX_HOME??join(homedir(),".codex"),"auth.json"),join(home,"auth.json"));await chmod(join(home,"auth.json"),0o600);
const fixture=new URL("./fixtures/mcp-server.ts",import.meta.url).pathname;
let rpc=new CodexRpc(home,cwd);const checks:Wire={};
const show=(name:string,value:unknown)=>{checks[name]=value;console.log(JSON.stringify({check:name,result:value}));};
const mcp=(id:string)=>({[id]:{command:process.execPath,args:[fixture,id],enabled:true,startup_timeout_sec:10}});
const start=async(id:string,network:boolean)=>rpc.request("thread/start",{cwd,sandbox:"workspace-write",approvalPolicy:"on-request",approvalsReviewer:"user",model:"gpt-6.1-sol",developerInstructions:`Synthetic configuration probe. Never delegate. Do not read files or run shell commands. The developer codeword is V0_DEV_${id}.`,config:{"features.apps":false,"apps._default.enabled":false,mcp_servers:mcp(id),"sandbox_workspace_write.network_access":network,"sandbox_workspace_write.exclude_slash_tmp":true,"sandbox_workspace_write.exclude_tmpdir_env_var":true}});
try{
 rpc.requestHandler=async m=>{
  show("elicitation_shape",shape(m.params));
  if(m.method==="mcpServer/elicitation/request" && m.params?.serverName==="alpha")return {action:"accept",content:{}};
  return m.method==="mcpServer/elicitation/request"?{action:"decline"}:{decision:"decline"};
 };
 await rpc.initialize();const a=await start("alpha",false);const b=await start("beta",true);
 show("thread_alpha_settings",{model:a.model,sandbox:a.sandbox,approval:a.approvalPolicy});show("thread_beta_settings",{model:b.model,sandbox:b.sandbox,approval:b.approvalPolicy});
 for(const [id,t]of [["alpha",a],["beta",b]] as const){const m=await rpc.request("mcpServerStatus/list",{threadId:t.thread.id,limit:100});show(id+"_mcp_inventory",m.data?.map((x:Wire)=>({name:x.name,authStatus:x.authStatus,tools:x.tools?Object.keys(x.tools):[]})));}
 const plain=await rpc.request("thread/start",{cwd,sandbox:"workspace-write",approvalPolicy:"on-request",config:{"features.apps":false,"apps._default.enabled":false}});const p=await rpc.request("mcpServerStatus/list",{threadId:plain.thread.id,limit:100});show("plain_thread_mcp_inventory",p.data?.map((x:Wire)=>({name:x.name,tools:x.tools?Object.keys(x.tools):[]})));
 const done=await rpc.turn(a.thread.id,"Call the synthetic echo tool once. Then reply only the developer codeword. Do not use shell or other tools.",{effort:"low"});show("mcp_tool_round",{status:done.params?.turn?.status,itemTypes:[...new Set(rpc.events.map(e=>e.params?.item?.type).filter(Boolean))],mcpCalls:rpc.events.filter(e=>e.method==="item/completed"&&e.params?.item?.type==="mcpToolCall").map(e=>({server:e.params.item.server,tool:e.params.item.tool,status:e.params.item.status})),developerCodeReturned:rpc.events.some(e=>e.method==="item/completed"&&e.params?.item?.type==="agentMessage"&&String(e.params.item.text).includes("V0_DEV_alpha"))});
 const resumed=await rpc.request("thread/resume",{threadId:a.thread.id,excludeTurns:true});show("resume_without_explicit_policy",{approval:resumed.approvalPolicy,sandbox:resumed.sandbox,effort:resumed.reasoningEffort});
 show("events",[...new Set(rpc.methods)]);
 await rpc.stop("SIGKILL");rpc=new CodexRpc(home,cwd);await rpc.initialize();
 const fresh=await rpc.request("thread/resume",{threadId:a.thread.id,excludeTurns:true});
 const inventory=await rpc.request("mcpServerStatus/list",{threadId:a.thread.id,limit:100});
 show("fresh_process_resume",{sandbox:fresh.sandbox,servers:inventory.data?.map((x:Wire)=>x.name)});
 const loadedOverride=await rpc.request("thread/resume",{threadId:a.thread.id,excludeTurns:true,sandbox:"workspace-write",approvalPolicy:"on-request",approvalsReviewer:"user",config:{"features.apps":false,"apps._default.enabled":false,mcp_servers:mcp("alpha"),"sandbox_workspace_write.network_access":false,"sandbox_workspace_write.exclude_slash_tmp":true,"sandbox_workspace_write.exclude_tmpdir_env_var":true}});
 const loadedMcp=await rpc.request("mcpServerStatus/list",{threadId:a.thread.id,limit:100});
 show("repeat_resume_loaded_thread_with_overrides",{sandbox:loadedOverride.sandbox,servers:loadedMcp.data?.map((x:Wire)=>x.name)});
 await rpc.stop("SIGKILL");rpc=new CodexRpc(home,cwd);await rpc.initialize();
 const fixed=await rpc.request("thread/resume",{threadId:a.thread.id,excludeTurns:true,cwd,sandbox:"workspace-write",approvalPolicy:"on-request",approvalsReviewer:"user",developerInstructions:"Synthetic configuration probe. Never delegate.",config:{"features.apps":false,"apps._default.enabled":false,mcp_servers:mcp("alpha"),"sandbox_workspace_write.network_access":false,"sandbox_workspace_write.exclude_slash_tmp":true,"sandbox_workspace_write.exclude_tmpdir_env_var":true}});
 const fixedMcp=await rpc.request("mcpServerStatus/list",{threadId:a.thread.id,limit:100});
 show("fresh_process_resume_with_explicit_config",{sandbox:fixed.sandbox,servers:fixedMcp.data?.map((x:Wire)=>x.name)});

}catch(e){process.exitCode=1;show("failure",e instanceof Error?e.message:"unknown");}
finally{await rpc.stop();await rm(join(home,"auth.json"),{force:true});if(out)await writeFile(out,JSON.stringify({date:new Date().toISOString(),root,checks},null,2)+"\n",{mode:0o600});}

/**
 * bun scripts/spike/codex-session.ts --use-local-codex-login --out /absolute/evidence.json
 * Synthetic live probe. Copies auth only into a private temporary CODEX_HOME;
 * never logs auth, provider error bodies, user account data, or reasoning text.
 */
import { mkdtemp, mkdir, copyFile, chmod, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { CodexRpc, shape, type Wire } from "./rpc.ts";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i=argv.indexOf(name); return i<0 ? undefined : argv[i+1]; };
const output = arg("--out");
if (output && !isAbsolute(output)) throw new Error("--out must be absolute");
if (!argv.includes("--use-local-codex-login")) throw new Error("Explicit --use-local-codex-login is required for this live subscription probe");
const root = await mkdtemp(join(tmpdir(),"lumio-codex-session-spike-"));
await chmod(root,0o700);
const home=join(root,"codex"), workspace=join(root,"workspace"), outside=join(root,"outside");
for(const dir of [home,workspace,outside]) await mkdir(dir,{mode:0o700});
await copyFile(join(process.env.CODEX_HOME ?? join(homedir(),".codex"),"auth.json"),join(home,"auth.json"));
await chmod(join(home,"auth.json"),0o600);
// Deliberately conflicting lower-precedence settings, only inside this probe.
await writeFile(join(home,"config.toml"),'approval_policy = "never"\nsandbox_mode = "read-only"\n[features]\napps = false\n');
const evidence: Wire={date:new Date().toISOString(),root,version:"",checks:{},trace:[],observedMethods:[],itemTypes:[],approval:[],usage:[],errors:[]};
const configBefore=await Bun.file(join(homedir(),".codex/config.toml")).arrayBuffer().then(b=>Bun.hash(new Uint8Array(b)).toString()).catch(()=>"absent");
let rpc: CodexRpc | undefined;
const exists=async(path:string)=>!!await stat(path).catch(()=>undefined);
const record=(name:string,value:unknown)=>{evidence.checks[name]=value;console.log(JSON.stringify({check:name,result:value}));};
function safeState(reply:Wire):Wire{return {model:reply.model,reasoningEffort:reply.reasoningEffort,approvalPolicy:reply.approvalPolicy,approvalsReviewer:reply.approvalsReviewer,sandbox:reply.sandbox,threadStatus:reply.thread?.status};}
const all:CodexRpc[]=[];
async function connect():Promise<CodexRpc>{const client=new CodexRpc(home,workspace);all.push(client);await client.initialize();return client;}
async function start(client:CodexRpc,extra:Wire={}):Promise<Wire>{return client.request("thread/start",{cwd:workspace,approvalPolicy:"on-request",approvalsReviewer:"user",sandbox:"workspace-write",model:"gpt-6.1-sol",config:{"sandbox_workspace_write.network_access":false,"sandbox_workspace_write.exclude_slash_tmp":true,"sandbox_workspace_write.exclude_tmpdir_env_var":true},developerInstructions:"You are running a synthetic Lumio transport verification. Follow only the current synthetic test. Do not read any unrelated files, credentials, or real project. Never delegate. No tools unless explicitly requested. Keep all prose short.",...extra});}
function doneState(e:Wire):Wire{return {status:e.params?.turn?.status,error:e.params?.turn?.error ? shape(e.params.turn.error):null};}
async function waitFile(path:string,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await exists(path))return;await Bun.sleep(50);}throw new Error("synthetic marker not observed");}
try{
 const version= Bun.spawnSync(["codex","--version"],{env:{...process.env,CODEX_HOME:home},stdout:"pipe",stderr:"pipe"});evidence.version=version.stdout.toString().trim();
 rpc=await connect();
 const account=await rpc.request("account/read",{refreshToken:false});record("account",{type:account.account?.type,requiresOpenaiAuth:account.requiresOpenaiAuth});
 const models=await rpc.request("model/list",{limit:100});record("models",models.data.map((m:Wire)=>({id:m.id,model:m.model,defaultEffort:m.defaultReasoningEffort,efforts:m.supportedReasoningEfforts?.map((v:Wire)=>v.reasoningEffort)})));
 const first=await start(rpc);const threadId=first.thread.id as string;record("create_and_precedence",safeState(first));
 record("round_one",doneState(await rpc.turn(threadId,"Remember the synthetic codeword V0_TULIP. Reply only ACK.",{model:"gpt-6.1-sol",effort:"low",summary:"concise"})));
 record("round_two_model_switch",doneState(await rpc.turn(threadId,"What is the synthetic codeword? Reply only that codeword. No tools.",{model:"gpt-6.1-terra",effort:"medium"})));
 const read=await rpc.request("thread/read",{threadId,includeTurns:false});record("read",{found:read.thread?.id===threadId,status:read.thread?.status});
 const history=await rpc.request("thread/turns/list",{threadId,limit:100,sortDirection:"asc",itemsView:"full"});record("history",{turns:history.data?.length,statuses:history.data?.map((t:Wire)=>t.status),retainedCodeword:JSON.stringify(history).includes("V0_TULIP"),secondTurnAssistantCodewordConfirmed:history.data?.some((t:Wire)=>t.items?.some((i:Wire)=>i.type==="agentMessage"&&String(i.text).trim()==="V0_TULIP"))});
 const settingsEvents=rpc.events.filter(e=>e.method==="thread/settings/updated");record("settings_events",settingsEvents.map(e=>e.params));
 const marker=join(outside,"approval-marker.txt");
 rpc.requestHandler=async message=>{
  if(message.method!=="item/commandExecution/requestApproval")return {decision:"decline"};
  const p=message.params as Wire;const command=String(p.command??"");
  const expected=`printf V0_APPROVED > ${marker}`;
  const safe=command===expected || (command.endsWith(` -lc '${expected}'`) && /^\/[A-Za-z0-9_./-]+ -lc /.test(command));
  evidence.approval.push({method:message.method,paramKeys:Object.keys(p),command,decision:safe?"accept":"decline",requestShape:shape(p)});
  if(safe){const began=Date.now();console.log(JSON.stringify({stage:"approval_wait_started",holdMs:65000}));await Bun.sleep(65000);evidence.approval.at(-1).heldMs=Date.now()-began;}
  console.log(JSON.stringify({stage:"approval_answer",safe}));return {decision:safe?"accept":"decline"};
 };
 record("approval_round",doneState(await rpc.turn(threadId,`Run exactly this command using exec_command with sandbox_permissions=require_escalated and a short justification: printf V0_APPROVED > ${marker}\nRequest approval even if you believe it can run without it. Do not use any alternative command or tool. After success reply only DONE.`,{model:"gpt-6.1-sol",effort:"low"})));
 record("approval_marker",{written:await exists(marker),correct:(await readFile(marker,"utf8").catch(()=>""))==="V0_APPROVED"});
 rpc.requestHandler=async()=>({decision:"decline"});
 const sleepStart=join(workspace,"interrupt-started.txt"),sleepEnd=join(workspace,"interrupt-finished.txt");
 const after=rpc.events.length;
 const running=await rpc.request("turn/start",{threadId,input:[{type:"text",text:`Use exec_command once to execute: printf STARTED > ${sleepStart}; sleep 30; printf FINISHED > ${sleepEnd}\nRun inside the sandbox without requesting escalation. Do not run other commands.`}],effort:"low"});
 await waitFile(sleepStart);record("interrupt_ack",await rpc.request("turn/interrupt",{threadId,turnId:running.turn.id}));
 const interrupted=await rpc.wait(e=>e.method==="turn/completed" && e.params?.turn?.id===running.turn.id,after,20000);record("interrupted_round",{...doneState(interrupted),startedMarker:await exists(sleepStart),finishedMarker:await exists(sleepEnd)});
 const compactAt=rpc.events.length;record("compact_ack",await rpc.request("thread/compact/start",{threadId}));
 await rpc.wait(e=>(e.method==="item/completed" && e.params?.item?.type==="contextCompaction")||e.method==="thread/compacted",compactAt,60000);record("compact_completed",true);
 record("resume_same_process",safeState(await rpc.request("thread/resume",{threadId,excludeTurns:true,approvalPolicy:"on-request",approvalsReviewer:"user",sandbox:"workspace-write"})));
 record("post_interrupt_round",doneState(await rpc.turn(threadId,"Reply only RECOVERED. Do not use tools.",{effort:"low"})));
 // A second independent thread in the same process; both must remain addressable.
 const second=await start(rpc);const secondId=second.thread.id as string;
 const parallel=await Promise.all([rpc.turn(threadId,"Reply only A. No tools.",{effort:"low"}),rpc.turn(secondId,"Reply only B. No tools.",{effort:"low"})]);record("two_threads_parallel",parallel.map(doneState));
 record("two_thread_identity",{distinct:threadId!==secondId,firstReadable:(await rpc.request("thread/read",{threadId})).thread?.id===threadId,secondReadable:(await rpc.request("thread/read",{threadId:secondId})).thread?.id===secondId});
 await rpc.stop("SIGKILL");rpc=await connect();
 record("resume_after_process_kill",safeState(await rpc.request("thread/resume",{threadId,excludeTurns:true,approvalPolicy:"on-request",approvalsReviewer:"user",sandbox:"workspace-write"})));
 record("round_after_process_kill",doneState(await rpc.turn(threadId,"Reply only PROCESS_RECOVERED. No tools.",{effort:"low"})));
 // Kill while a real synthetic command has visibly started, then inspect persisted history.
 const crashStart=join(workspace,"crash-started.txt"),crashEnd=join(workspace,"crash-finished.txt");
 const crash=await rpc.request("turn/start",{threadId,input:[{type:"text",text:`Use exec_command once to execute: printf STARTED > ${crashStart}; sleep 15; printf FINISHED > ${crashEnd}\nRun inside the sandbox without escalation. Do not run other commands.`}],effort:"low"});
 await waitFile(crashStart);record("crash_before_kill",{startedMarker:true,finishedMarker:await exists(crashEnd)});
 await rpc.stop("SIGKILL");rpc=await connect();
 await rpc.request("thread/resume",{threadId,excludeTurns:true,approvalPolicy:"on-request",approvalsReviewer:"user",sandbox:"workspace-write"});
 const recovered=await rpc.request("thread/turns/list",{threadId,limit:100,sortDirection:"desc",itemsView:"full"});
 const last=recovered.data?.find((t:Wire)=>t.id===crash.turn.id);record("crash_recovery",{turnStatus:last?.status,items:last?.items?.map((i:Wire)=>({type:i.type,status:i.status,exitCode:i.exitCode})),startedMarker:await exists(crashStart),finishedMarker:await exists(crashEnd)});
 await Bun.sleep(16000);record("crash_marker_after_original_command_deadline",{finishedMarker:await exists(crashEnd)});
 record("resume_without_replay",doneState(await rpc.turn(threadId,"Do not repeat any prior command. Reply only NO_REPLAY.",{effort:"low"})));
}catch(error){process.exitCode=1;const message=error instanceof Error ? error.message : "unknown";evidence.errors.push(message);console.log(JSON.stringify({stage:"probe_error",message}));}
finally{
 for(const c of all){evidence.trace.push(...c.events.map(e=>({method:e.method,itemType:e.params?.item?.type,turnStatus:e.params?.turn?.status})));evidence.usage.push(...c.events.filter(e=>e.method==="thread/tokenUsage/updated").map(e=>e.params?.tokenUsage));}
 evidence.observedMethods=[...new Set(all.flatMap(c=>c.methods))];evidence.itemTypes=[...new Set(evidence.trace.map((v:Wire)=>v.itemType).filter(Boolean))];
 for(const c of all)await c.stop();
 evidence.globalConfigUnchanged=configBefore===await Bun.file(join(homedir(),".codex/config.toml")).arrayBuffer().then(b=>Bun.hash(new Uint8Array(b)).toString()).catch(()=>"absent");
 // Keep only synthetic session state; credentials are always removed.
 await rm(join(home,"auth.json"),{force:true});
 if(output)await writeFile(output,JSON.stringify(evidence,null,2)+"\n",{mode:0o600});
 console.log(JSON.stringify({stage:"finished",root,output,errors:evidence.errors,observedMethods:evidence.observedMethods,itemTypes:evidence.itemTypes,usageEvents:evidence.usage.length,globalConfigUnchanged:evidence.globalConfigUnchanged}));
}

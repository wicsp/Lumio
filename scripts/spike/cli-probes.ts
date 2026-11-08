/** V0-0 synthetic CLI probes. Credentials only enter child environments. */
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,copyFile,chmod,readFile,writeFile,rm,readdir} from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import {join,isAbsolute} from "node:path";
import {shape} from "./rpc.ts";
const args=process.argv.slice(2);const oi=args.indexOf("--out");const out=oi<0?undefined:args[oi+1];if(out&&!isAbsolute(out))throw new Error("--out must be absolute");
if(!args.includes("--use-local-credentials"))throw new Error("Explicit --use-local-credentials is required");
const root=await mkdtemp(join(tmpdir(),"lumio-cli-spike-"));await chmod(root,0o700);
for(const d of ["codex","claude","pi","workspace"])await mkdir(join(root,d),{mode:0o700});
const home=join(root,"codex"),cwd=join(root,"workspace");
await copyFile(join(process.env.CODEX_HOME??join(homedir(),".codex"),"auth.json"),join(home,"auth.json"));await chmod(join(home,"auth.json"),0o600);
const auth=JSON.parse(await readFile(join(homedir(),".pi/agent/auth.json"),"utf8"));const key=process.env.DEEPSEEK_API_KEY??auth.deepseek?.key;
const evidence:any={date:new Date().toISOString(),root,checks:{}};
const record=(name:string,v:unknown)=>{evidence.checks[name]=v;console.log(JSON.stringify({check:name,result:v}));};
async function run(command:string,argv:string[],extra:NodeJS.ProcessEnv={},timeout=120000,rpcState=false){
 const env:NodeJS.ProcessEnv={...process.env,CODEX_HOME:home,CLAUDE_CONFIG_DIR:join(root,"claude"),PI_CODING_AGENT_DIR:join(root,"pi"),PI_TELEMETRY:"0",PI_OFFLINE:"1",...extra};
 for(const k of ["OPENAI_API_KEY","OPENAI_API_BASE","OPENAI_BASE_URL","CODEX_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN"])delete env[k];
 const child=spawn(command,argv,{cwd,env,stdio:["pipe","pipe","pipe"],shell:false});let stdout="",stderr="";
 child.stdout.on("data",c=>{if(stdout.length<5000000)stdout+=String(c);if(rpcState)for(const line of stdout.split("\n")){try{if(JSON.parse(line).command==="get_state")child.kill("SIGTERM");}catch{}}});child.stderr.on("data",c=>{if(stderr.length<200000)stderr+=String(c)});
 if(rpcState)child.stdin.write(JSON.stringify({id:"spike-state",type:"get_state"})+"\n");else child.stdin.end();
 const timer=setTimeout(()=>child.kill("SIGTERM"),timeout);const code=await new Promise<number|null>(r=>child.once("exit",r));clearTimeout(timer);
 const events:any[]=[];for(const line of stdout.split("\n")){try{events.push(JSON.parse(line))}catch{}}
 return {code,events,stderrBytes:stderr.length,timeout:code===null};
}
async function files(path:string):Promise<string[]>{const out:string[]=[];for(const d of await readdir(path,{withFileTypes:true}).catch(()=>[])){const p=join(path,d.name);if(d.isDirectory())out.push(...await files(p));else out.push(p);}return out;}
try{
 const first=await run("codex",["exec","--skip-git-repo-check","--sandbox","read-only","-m","gpt-6.1-sol","-c",'model_reasoning_effort="low"',"--json","Remember V0_EXEC. Reply only ACK. Do not use tools."]);
 const id=first.events.find(e=>e.type==="thread.started")?.thread_id;
 record("codex_exec",{code:first.code,methods:first.events.map(e=>e.type),usage:first.events.find(e=>e.type==="turn.completed")?.usage,threadCreated:!!id});
 if(id){const resumed=await run("codex",["exec","resume",id,"--skip-git-repo-check","-c",'sandbox_mode="read-only"',"-m","gpt-6.1-terra","-c",'model_reasoning_effort="medium"',"--json","Reply only the synthetic codeword. No tools."]);record("codex_exec_resume",{code:resumed.code,methods:resumed.events.map(e=>e.type),usage:resumed.events.find(e=>e.type==="turn.completed")?.usage,codewordReturned:JSON.stringify(resumed.events).includes("V0_EXEC")});}
 const contexts:any[]=[];for(const p of await files(join(home,"sessions"))){if(!p.endsWith(".jsonl"))continue;for(const line of (await readFile(p,"utf8")).split("\n")){try{const e=JSON.parse(line);if(e.type==="turn_context")contexts.push({model:e.payload.model,effort:e.payload.effort,reasoning_effort:e.payload.reasoning_effort,approval_policy:e.payload.approval_policy,sandbox_policy:e.payload.sandbox_policy});}catch{}}}record("codex_exec_persisted_contexts",contexts);
 if(key){
  const flags=["--mode","json","--no-extensions","--no-mcp","--no-skills","--no-prompt-templates","--no-themes","--no-context-files","--offline","--no-tools"];
  const pi1=await run("pi",["-p",...flags,"--provider","deepseek","--model","deepseek-flash","--thinking","low","--session-id","12345678-1234-4234-9234-123456789abc","Remember V0_PI. Reply only ACK."],{DEEPSEEK_API_KEY:key});
  const extractPi=(r:Awaited<ReturnType<typeof run>>)=>({code:r.code,types:[...new Set(r.events.map(e=>e.type))],assistantMessages:r.events.filter(e=>e.type==="message_end"&&e.message?.role==="assistant").map(e=>({model:e.message.model,provider:e.message.provider,stopReason:e.message.stopReason,usage:e.message.usage})),session:r.events.find(e=>e.type==="session")?shape(r.events.find(e=>e.type==="session")):undefined});
  record("pi_print",extractPi(pi1));
  const pi2=await run("pi",["-p",...flags,"--provider","deepseek","--model","deepseek-v4-pro","--thinking","high","--session-id","12345678-1234-4234-9234-123456789abc","Reply only the synthetic codeword."],{DEEPSEEK_API_KEY:key});record("pi_resume_model_thinking",{...extractPi(pi2),codewordReturned:JSON.stringify(pi2.events).includes("V0_PI")});
  const state=await run("pi",["--mode","rpc",...flags.slice(2),"--provider","deepseek","--model","deepseek-v4-pro","--thinking","high","--session-id","12345678-1234-4234-9234-123456789abc"],{},30000,true);
  const ps=state.events.find(e=>e.command==="get_state");record("pi_rpc_resumed_state",{success:ps?.success,model:ps?.data?.model?.id,provider:ps?.data?.model?.provider,thinkingLevel:ps?.data?.thinkingLevel});
  const changes:any[]=[];for(const p of await files(join(root,"pi"))){if(!p.endsWith(".jsonl"))continue;for(const line of (await readFile(p,"utf8")).split("\n")){try{const e=JSON.parse(line);if(["model_change","thinking_level_change"].includes(e.type))changes.push(e);}catch{}}}record("pi_persisted_model_thinking",changes);
  const fixture=join(cwd,"synthetic.txt");await writeFile(fixture,"V0_SYNTHETIC_42\n");
  const claudeEnv={ANTHROPIC_API_KEY:key,ANTHROPIC_BASE_URL:"https://api.deepseek.com/anthropic",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",CLAUDE_CODE_DISABLE_AUTO_MEMORY:"1"};
  const base=["--bare","-p","--model","deepseek-flash","--effort","low","--output-format","json","--tools","Read","--allowedTools","Read","--strict-mcp-config","--mcp-config",'{"mcpServers":{}}',"--setting-sources",""];
  const c1=await run("claude",[...base,`Use the Read tool to read ${fixture}, then reply only its content. Do not use any other tool.`],claudeEnv);
  const result=c1.events.find(e=>e.type==="result");record("claude_deepseek_tool_round",{code:c1.code,stderrBytes:c1.stderrBytes,type:result?.type,subtype:result?.subtype,isError:result?.is_error,usage:result?.usage,modelUsage:result?.modelUsage,sessionCreated:!!result?.session_id,fixtureReturned:String(result?.result??"").includes("V0_SYNTHETIC_42"),eventTypes:c1.events.map(e=>e.type)});
  if(result?.session_id){const c2=await run("claude",[...base,"--model","deepseek-v4-pro","--effort","high","--resume",result.session_id,"Reply only RESUMED. Do not use tools."],claudeEnv);const r=c2.events.find(e=>e.type==="result");record("claude_resume_model_effort",{code:c2.code,isError:r?.is_error,subtype:r?.subtype,usage:r?.usage,modelUsage:r?.modelUsage,sameSession:r?.session_id===result.session_id});}

  const wireParams:any[]=[];const toolItems:any[]=[];
  for(const p of await files(join(root,"claude"))){if(!p.endsWith(".jsonl"))continue;for(const line of (await readFile(p,"utf8")).split("\n")){try{const e=JSON.parse(line);if(e.type==="api-request")wireParams.push({model:e.params?.model,thinking:e.params?.thinking,output_config:e.params?.output_config});for(const c of Array.isArray(e.message?.content)?e.message.content:[])if(["tool_use","tool_result"].includes(c.type))toolItems.push({type:c.type,name:c.name,is_error:c.is_error});}catch{}}}
  record("claude_persisted_wire_params",wireParams);record("claude_tool_items",toolItems);

 }
}catch(error){record("failure",error instanceof Error?error.message:"unknown");}
finally{await rm(join(home,"auth.json"),{force:true});if(out)await writeFile(out,JSON.stringify(evidence,null,2)+"\n",{mode:0o600});console.log(JSON.stringify({stage:"finished",root,out}));}

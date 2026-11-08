/** Optional live Ark probe. A missing key is a recorded blocker, never a pass. */
import {writeFile} from "node:fs/promises";
import {isAbsolute} from "node:path";
const oi=process.argv.indexOf("--out");const out=oi<0?undefined:process.argv[oi+1];
if(out&&!isAbsolute(out))throw new Error("--out must be absolute");
const key=process.env.ARK_API_KEY,model=process.env.ARK_MODEL;
const checks:Record<string,unknown>={};
const record=(name:string,result:unknown)=>{checks[name]=result;console.log(JSON.stringify({check:name,result}));};
const summary=(status:number,b:any)=>({status,model:b.model,usage:b.usage,finish:b.choices?.[0]?.finish_reason,errorCode:b.error?.code});
async function request(body:unknown){const r=await fetch("https://ark.cn-beijing.volces.com/api/v3/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});return {status:r.status,body:await r.json() as any};}
try{
 if(!key||!model)record("blocked",{reason:"ARK_API_KEY and an enabled ARK_MODEL are required",credentialAvailable:!!key,modelConfigured:!!model});
 else{
  const tools=[{type:"function",function:{name:"synthetic_add",description:"Add two synthetic numbers",parameters:{type:"object",properties:{a:{type:"integer"},b:{type:"integer"}},required:["a","b"]}}}];
  const messages:any[]=[{role:"user",content:"Call synthetic_add(2,3), then answer using its returned result. You must call it."}];
  const common={model,tools,thinking:{type:"enabled"},reasoning_effort:process.env.ARK_EFFORT??"high",max_tokens:1024};
  const first=await request({...common,messages});const a=first.body.choices?.[0]?.message;
  record("tool_initial",{...summary(first.status,first.body),messageKeys:a?Object.keys(a):[]});
  if(a?.tool_calls?.length){
   const full=[...messages,a,...a.tool_calls.map((c:any)=>({role:"tool",tool_call_id:c.id,content:"5"}))];
   for(const variant of ["full","without_encrypted","without_reasoning_state"]){const m=structuredClone(full);if(variant!=="full")delete m[1].encrypted_content;if(variant==="without_reasoning_state")delete m[1].reasoning_content;const r=await request({...common,messages:m});record(variant,summary(r.status,r.body));}
  }
 }
}catch{record("failure","Request failed; raw diagnostics suppressed");process.exitCode=1;}
if(out)await writeFile(out,JSON.stringify({date:new Date().toISOString(),checks},null,2)+"\n",{mode:0o600});

/** Live DeepSeek protocol probes; no key or reasoning body is written to evidence. */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
const args=process.argv.slice(2);const outAt=args.indexOf("--out");const out=outAt<0?undefined:args[outAt+1];
if(out&&!isAbsolute(out))throw new Error("--out must be absolute");
let key=process.env.DEEPSEEK_API_KEY;
if(!key&&args.includes("--use-local-pi-deepseek-key")){const j=JSON.parse(await readFile(homedir()+"/.pi/agent/auth.json","utf8"));if(j.deepseek?.type==="api_key")key=j.deepseek.key;}
const evidence:any={date:new Date().toISOString(),provider:"deepseek",credentialAvailable:!!key,checks:{}};
const check=(name:string,v:unknown)=>{evidence.checks[name]=v;console.log(JSON.stringify({check:name,result:v}));};
async function request(path:string,body?:unknown):Promise<{status:number;body:any}>{
 const response=await fetch("https://api.deepseek.com"+path,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
 return {status:response.status,body:await response.json()};
}
function summary(r:{status:number;body:any}){return {status:r.status,model:r.body.model,finish:r.body.choices?.[0]?.finish_reason,usage:r.body.usage,errorType:r.body.error?.type,errorCode:r.body.error?.code,errorMentionsReasoningContent:String(r.body.error?.message??"").includes("reasoning_content")};}
try{
 if(key){
  const catalog=await request("/v1/models");check("catalog",{status:catalog.status,ids:catalog.body.data?.map((v:any)=>v.id)});
  if(!args.includes("--controls-only"))for(const model of ["deepseek-flash","deepseek-v4-pro"]){
   const efforts:any[]=[];
   // Success establishes accepted input, not actual internal effort or equivalence.
   for(const effort of ["minimal","low","medium","high","xhigh","max","ultra"]){
    const r=await request("/v1/chat/completions",{model,messages:[{role:"user",content:"Reply only OK."}],thinking:{type:"enabled"},reasoning_effort:effort,max_tokens:128});efforts.push({requested:effort,...summary(r)});
   }
   check(model+"_effort_acceptance",efforts);
  }
  const tools=[{type:"function",function:{name:"synthetic_add",description:"Adds two synthetic integers",parameters:{type:"object",properties:{a:{type:"integer"},b:{type:"integer"}},required:["a","b"],additionalProperties:false}}}];
  const common={model:"deepseek-flash",tools,thinking:{type:"enabled"},reasoning_effort:"low",max_tokens:1024};
  const messages:any[]=[{role:"user",content:"Call synthetic_add with a=2 and b=3, then answer with the number returned. You must call the tool."}];
  const initial=await request("/v1/chat/completions",{...common,messages});const assistant=initial.body.choices?.[0]?.message;check("tool_initial",{...summary(initial),messageKeys:assistant?Object.keys(assistant):[],reasoningType:typeof assistant?.reasoning_content,toolCount:assistant?.tool_calls?.length});
  if(assistant?.tool_calls?.length){
   const toolMessages=assistant.tool_calls.map((c:any)=>({role:"tool",tool_call_id:c.id,content:"5"}));
   const full=[...messages,assistant,...toolMessages];
   const valid=await request("/v1/chat/completions",{...common,messages:full});check("tool_continuation_with_reasoning",summary(valid));
   const missing=structuredClone(full);delete missing[1].reasoning_content;
   check("tool_continuation_without_reasoning",summary(await request("/v1/chat/completions",{...common,messages:missing})));
   const final=valid.body.choices?.[0]?.message;
   if(final){
    const next=[...full,final,{role:"user",content:"Now call synthetic_add with a=3 and b=4. You must call the tool."}];
    const follow=await request("/v1/chat/completions",{...common,messages:next});check("next_user_turn_with_all_reasoning",summary(follow));
    const omitted=structuredClone(next);for(const m of omitted)if(m.role==="assistant")delete m.reasoning_content;
    check("next_user_turn_without_prior_reasoning",summary(await request("/v1/chat/completions",{...common,messages:omitted})));
   }
  }
  for(const model of ["deepseek-flash","deepseek-v4-pro"]){
   const prompt=[{role:"user",content:`Synthetic control ${Date.now()} ${model}: call synthetic_add(2,3), then use its result. You must call it.`}];
   const first=await request("/v1/chat/completions",{...common,model,messages:prompt});
   const m=first.body.choices?.[0]?.message;const cases:any[]=[];
   if(m?.tool_calls?.length){
    for(const variant of ["missing","empty","null","full"]){
     const a=structuredClone(m);if(variant==="missing")delete a.reasoning_content;else if(variant==="empty")a.reasoning_content="";else if(variant==="null")a.reasoning_content=null;
     const r=await request("/v1/chat/completions",{...common,model,messages:[...prompt,a,...m.tool_calls.map((t:any)=>({role:"tool",tool_call_id:t.id,content:"5"}))]});cases.push({variant,...summary(r)});
    }
   }
   check(model+"_reasoning_controls_omission_first",{initial:summary(first),reasoningType:typeof m?.reasoning_content,cases});
  }
  const anthropic=await request("/anthropic/v1/messages",{model:"deepseek-flash",max_tokens:128,messages:[{role:"user",content:"Reply only OK."}]});
  check("anthropic_endpoint",{status:anthropic.status,model:anthropic.body.model,stopReason:anthropic.body.stop_reason,contentTypes:anthropic.body.content?.map((c:any)=>c.type),usage:anthropic.body.usage});
 }
}catch{evidence.failure="Provider request failed or timed out; raw diagnostics suppressed";console.log(JSON.stringify({failure:evidence.failure}));}
if(out)await writeFile(out,JSON.stringify(evidence,null,2)+"\n",{mode:0o600});

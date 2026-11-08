/** Synthetic stdio MCP server: no filesystem or network tools. */
import {createInterface} from "node:readline";
const suffix=process.argv[2]??"a";
createInterface({input:process.stdin}).on("line",line=>{
 let m:any;try{m=JSON.parse(line)}catch{return;}
 if(m.id===undefined)return;
 let result:any;
 if(m.method==="initialize")result={protocolVersion:m.params?.protocolVersion??"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"lumio-v0-synthetic",version:"0.0.0"}};
 else if(m.method==="tools/list")result={tools:[{name:`synthetic_echo_${suffix}`,description:"Returns a harmless synthetic marker",inputSchema:{type:"object",properties:{},additionalProperties:false}}]};
 else if(m.method==="tools/call")result={content:[{type:"text",text:`V0_MCP_${suffix}`}],isError:false};
 else if(m.method==="ping")result={};
 else {process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Not supported by synthetic server"}})+"\n");return;}
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\n");
});

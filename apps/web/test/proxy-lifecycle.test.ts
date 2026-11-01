import {expect,test} from "bun:test";
import {ApiError} from "@lumio/schema";
import {createHubProxy} from "../src/proxy.ts";
const origin="http://127.0.0.1:4317";
function request(path="/hub/v1/actors",init:RequestInit={}):Request{return new Request(origin+path,{...init,headers:{Host:"127.0.0.1:4317",...Object.fromEntries(new Headers(init.headers))}});}
const fake=(fn:(input:unknown,init?:RequestInit)=>Response|Promise<Response>)=>fn as typeof fetch;
function proxy(fetcher:typeof fetch,timeoutMs=50,signal?:AbortSignal){return createHubProxy({hubUrl:"http://127.0.0.1:7420",allowedOrigins:[origin],timeoutMs,fetch:fetcher,signal});}

test("request body deadline applies before Hub is contacted",async()=>{
  let contacted=0,cancelled=false;
  const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
  const handler=proxy(fake(()=>{contacted++;return Response.json([]);}),20);
  const response=await handler(request("/hub/v2/work/commands",{method:"POST",headers:{"Content-Type":"application/json"},body}));
  expect(response.status).toBe(504);expect(ApiError.parse(await response.json()).error.code).toBe("INTERNAL");expect(contacted).toBe(0);expect(cancelled).toBe(true);
});
test("a response that stalls after headers and one event is bounded",async()=>{
  let cancelled=false;
  const upstream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{"event":"first"}\n'));},cancel(){cancelled=true;}});
  const response=await proxy(fake(()=>new Response(upstream,{headers:{"Content-Type":"application/x-ndjson"}})),25)(request());
  const reader=response.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
  await expect(reader.read()).rejects.toThrow("Hub connection interrupted");expect(cancelled).toBe(true);reader.releaseLock();
});
test("browser cancellation and server shutdown both cancel the upstream stream",async()=>{
  for(const stopServer of [false,true]){
    const stopped=new AbortController();let upstreamSignal:AbortSignal|undefined,cancelled=false;
    const response=await proxy(fake((_url,init)=>{upstreamSignal=init?.signal??undefined;return new Response(new ReadableStream({cancel(){cancelled=true;}}));}),1000,stopped.signal)(request());
    if(stopServer){const reader=response.body!.getReader();const pending=reader.read();stopped.abort();await expect(pending).rejects.toThrow();reader.releaseLock();}
    else await response.body!.cancel();
    expect(upstreamSignal?.aborted).toBe(true);expect(cancelled).toBe(true);
  }
});
test("proxy strips stale content length and upstream cookies while preserving actual bytes",async()=>{
  const response=await proxy(fake(()=>new Response("complete response",{headers:{"content-length":"1","set-cookie":"synthetic-cookie=1"}})))(request());
  expect(response.headers.get("content-length")).toBeNull();expect(response.headers.get("set-cookie")).toBeNull();expect(await response.text()).toBe("complete response");
});
test("foreign host, mismatched scheme and oversized query are refused before forwarding",async()=>{
  let calls=0;const handler=proxy(fake(()=>{calls++;return Response.json([]);}));
  expect((await handler(request("/hub/v1/actors",{headers:{Host:"attacker.example"}}))).status).toBe(403);
  expect((await handler(request("/hub/v1/actors",{headers:{Origin:"https://127.0.0.1:4317"}}))).status).toBe(403);
  expect((await handler(request("/hub/v1/search?q="+"x".repeat(4200)))).status).toBe(400);expect(calls).toBe(0);
});
test("unexpected network errors are redacted and not retried",async()=>{
  let calls=0;const response=await proxy(fake(()=>{calls++;throw new Error("Bearer synthetic-secret-value");}))(request());
  const body=ApiError.parse(await response.json());expect(response.status).toBe(502);expect(body.error.message).not.toContain("synthetic-secret");expect(calls).toBe(1);
});

test("a page bound to a different Hub cannot forward its credential after reconfiguration",async()=>{
 let calls=0;const handler=proxy(fake(()=>{calls++;return Response.json([]);}));
 const rejected=await handler(request("/hub/v1/actors",{headers:{authorization:"Bearer synthetic-token","x-lumio-hub":"https://previous-hub.example"}}));
 expect(rejected.status).toBe(409);expect(ApiError.parse(await rejected.json()).error.message).toContain("配置已变更");expect(calls).toBe(0);
 const accepted=await handler(request("/hub/v1/actors",{headers:{"x-lumio-hub":"http://127.0.0.1:7420"}}));expect(accepted.status).toBe(200);expect(calls).toBe(1);await accepted.body?.cancel();
});

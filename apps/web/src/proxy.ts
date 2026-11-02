import { ApiError } from "@lumio/schema";
/**
 * 同源 /hub 代理（ADR 0026）：浏览器只与本服务通信，上游固定为配置里的 Hub。
 *
 * - 只转发工作台用到的 GET/POST 用户接口；执行器登记、归档上传、邀请等接口一律 404。
 * - 只转发 Authorization、Content-Type、Accept；不转发 Cookie、Host 或 X-Forwarded-*。
 * - 请求体有上限；上游重定向视为错误；请求与响应流全程有时限，浏览器断开时取消上游请求。
 * - 响应体原样流式返回（助手的 NDJSON 流），并统一加 no-store 与安全头。
 */

const ID = "[0-9A-HJKMNP-TV-Z]{26}";
const ROUTES: ReadonlyArray<readonly ["GET" | "POST", RegExp]> = [
  ["GET", /^\/v1\/actors$/],
  ["POST", /^\/v1\/client\/join$/],
  ["GET", /^\/v1\/search$/],
  ["GET", /^\/v1\/notes\/[^/]+$/],
  ["GET", /^\/v1\/notes\/[^/]+\/links$/],
  ["GET", /^\/v1\/jobs$/],
  ["GET", new RegExp(`^/v1/jobs/job_${ID}$`)],
  ["POST", new RegExp(`^/v1/jobs/job_${ID}/cancel$`)],
  ["GET", /^\/v1\/runtimes$/],
  ["GET", /^\/v1\/proposals$/],
  ["POST", new RegExp(`^/v1/proposals/prop_${ID}/(accept|reject)$`)],
  ["POST", /^\/v2\/work\/commands$/],
  ["GET", /^\/v2\/work\/tasks$/],
  ["GET", new RegExp(`^/v2/work/tasks/task_${ID}$`)],
  ["GET", /^\/v2\/work\/projects$/],
  ["GET", new RegExp(`^/v2/work/projects/prj_${ID}$`)],
  ["POST", /^\/v2\/execution\/commands$/],
  ["GET", /^\/v2\/execution\/routines$/],
  ["GET", new RegExp(`^/v2/execution/routines/rtn_${ID}$`)],
  ["GET", new RegExp(`^/v2/execution/jobs/job_${ID}/artifacts$`)],
  ["GET", new RegExp(`^/v2/execution/artifacts/art_${ID}$`)],
  ["GET", new RegExp(`^/v2/execution/artifacts/art_${ID}/content$`)],
  ["POST", /^\/v2\/assistant\/chat$/],
  ["GET", /^\/v2\/assistant\/conversations$/],
  ["GET", new RegExp(`^/v2/assistant/conversations/conv_${ID}$`)],
  ["GET", /^\/v2\/assistant\/memories$/],
  ["POST", /^\/v2\/assistant\/memory-commands$/],
];

export const PROXY_PREFIX = "/hub";
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 130_000;
const MAX_QUERY_LENGTH = 4096;

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export function isAllowedRoute(method: string, path: string): boolean {
  return ROUTES.some(([allowed, pattern]) => allowed === method && pattern.test(path));
}

export interface ProxyOptions {
  hubUrl: string;
  /** 允许的浏览器来源；Host 头也必须是其中之一的主机（防 DNS 重绑定）。 */
  allowedOrigins: string[];
  fetch?: typeof globalThis.fetch;
  maxBodyBytes?: number;
  timeoutMs?: number;
  signal?:AbortSignal;
}

type ErrorCode = "INVALID" | "FORBIDDEN" | "NOT_FOUND" | "INTERNAL";

/** 与 Hub 的 ApiError 同形，SDK 可以直接解析；说明不含上游地址或内部细节。 */
export function proxyError(status: number, code: ErrorCode, message: string): Response {
  return new Response(JSON.stringify(ApiError.parse({ error: { code, message } })), {
    status, headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** 检查 Host 与 Origin；对静态页面和代理都适用。返回 undefined 表示通过。 */
export function checkRequestSource(request: Request, allowedOrigins: string[]): Response | undefined {
  const hosts = new Set(allowedOrigins.map((origin) => new URL(origin).host));
  const host = request.headers.get("host");
  if (!host || !hosts.has(host.toLowerCase())) return proxyError(403, "FORBIDDEN", "请通过配置的地址打开工作台");
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins.includes(origin)) return proxyError(403, "FORBIDDEN", "拒绝来自其他网站的请求");
  if (request.headers.get("sec-fetch-site") === "cross-site") return proxyError(403, "FORBIDDEN", "拒绝来自其他网站的请求");
  return undefined;
}

interface ByteChunk {done?:boolean;value?:Uint8Array}
interface ByteReader {read():Promise<ByteChunk>}
async function readPart(reader:ByteReader,signal:AbortSignal):Promise<ByteChunk> {
  signal.throwIfAborted();let abort:()=>void=()=>{};
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(new Error("aborted"));signal.addEventListener("abort",abort,{once:true});});
  try{return await Promise.race([reader.read(),cancelled]);}finally{signal.removeEventListener("abort",abort);}
}
async function readBounded(request:Request,limit:number,signal:AbortSignal):Promise<Uint8Array|"too-large">{
  const declared=request.headers.get("content-length");
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))return "too-large";
  if(!request.body)return new Uint8Array();const reader=request.body.getReader();
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){const {done,value}=await readPart(reader,signal);if(done)break;if(!value)throw new Error("Invalid request stream");size+=value.byteLength;if(size>limit)return "too-large";chunks.push(value);}
    const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}return body;
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createHubProxy(options:ProxyOptions):(request:Request)=>Promise<Response>{
  const fetcher=options.fetch??globalThis.fetch,limit=options.maxBodyBytes??DEFAULT_MAX_BODY_BYTES,timeout=options.timeoutMs??DEFAULT_UPSTREAM_TIMEOUT_MS;
  return async(request)=>{
    const url=new URL(request.url),method=request.method;
    if(!url.pathname.startsWith(`${PROXY_PREFIX}/`))return proxyError(404,"NOT_FOUND","没有这个接口");
    const path=url.pathname.slice(PROXY_PREFIX.length);
    if(method!=="GET"&&method!=="POST")return proxyError(405,"INVALID","不支持这种请求方式");
    if(!isAllowedRoute(method,path))return proxyError(404,"NOT_FOUND","工作台没有开放这个接口");
    if(url.search.length>MAX_QUERY_LENGTH)return proxyError(400,"INVALID","查询条件太长");
    const rejected=checkRequestSource(request,options.allowedOrigins);if(rejected)return rejected;
    const expectedHub=request.headers.get("x-lumio-hub");
    if(expectedHub!==null&&expectedHub!==options.hubUrl)return proxyError(409,"FORBIDDEN","Hub 连接配置已变更，请刷新页面后重新连接");
    if(method==="POST"&&!/^application\/json(\s*;|$)/i.test(request.headers.get("content-type")??""))return proxyError(415,"INVALID","请求内容必须是 JSON");
    const controller=new AbortController(),sources=[request.signal,...(options.signal?[options.signal]:[])];
    const onAbort=()=>controller.abort();for(const source of sources){source.addEventListener("abort",onAbort,{once:true});if(source.aborted)controller.abort();}
    const timer=setTimeout(()=>controller.abort(),timeout);let cleaned=false;
    const cleanup=()=>{if(cleaned)return;cleaned=true;clearTimeout(timer);for(const source of sources)source.removeEventListener("abort",onAbort);};
    try{
      const headers=new Headers();for(const name of ["authorization","content-type","accept"]){const value=request.headers.get(name);if(value)headers.set(name,value);}
      let body:Uint8Array|undefined;
      if(method==="POST"){const read=await readBounded(request,limit,controller.signal);if(read==="too-large"){cleanup();return proxyError(413,"INVALID","提交的内容太大");}body=read;}
      const upstream=await fetcher(`${options.hubUrl}${path}${url.search}`,{method,headers,redirect:"error",signal:controller.signal,...(body?{body:new Uint8Array(body).buffer}:{})});
      if(upstream.status>=300&&upstream.status<400){await upstream.body?.cancel().catch(()=>{});cleanup();return proxyError(502,"INTERNAL","Hub 返回了重定向，已拒绝跟随");}
      const responseHeaders=new Headers({...SECURITY_HEADERS,"Cache-Control":"no-store","Content-Type":upstream.headers.get("content-type")??"application/octet-stream"});
      if(!upstream.body){cleanup();return new Response(null,{status:upstream.status,headers:responseHeaders});}
      const reader=upstream.body.getReader();let ended=false;
      const stream=new ReadableStream<Uint8Array>({
        async pull(sink){try{const part=await readPart(reader,controller.signal);if(ended)return;if(part.done){ended=true;cleanup();reader.releaseLock();sink.close();}else{if(!part.value)throw new Error("Invalid response stream");sink.enqueue(part.value);}}
          catch{if(ended)return;ended=true;cleanup();await reader.cancel().catch(()=>{});reader.releaseLock();sink.error(new Error("Hub connection interrupted"));}},
        async cancel(){if(ended)return;ended=true;controller.abort();cleanup();await reader.cancel().catch(()=>{});reader.releaseLock();},
      });
      return new Response(stream,{status:upstream.status,headers:responseHeaders});
    }catch{
      cleanup();return controller.signal.aborted?proxyError(504,"INTERNAL","连接已中断或超时。修改操作请先核对保存记录，不要直接重试"):proxyError(502,"INTERNAL","无法连接 Hub，请确认服务正在运行");
    }
  };
}

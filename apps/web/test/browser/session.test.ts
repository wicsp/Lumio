import {afterEach,expect,test} from "bun:test";
import {createSession} from "../../src/client/api.ts";
const original=Object.getOwnPropertyDescriptor(globalThis,"window");
const originalDocument=Object.getOwnPropertyDescriptor(globalThis,"document");
afterEach(()=>{if(original)Object.defineProperty(globalThis,"window",original);else Reflect.deleteProperty(globalThis,"window");if(originalDocument)Object.defineProperty(globalThis,"document",originalDocument);else Reflect.deleteProperty(globalThis,"document");});
function browser(fetcher:(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>){Object.defineProperty(globalThis,"window",{configurable:true,value:{location:{origin:"http://127.0.0.1:4317"},fetch:fetcher}});}
const unauthorized=()=>Response.json({error:{code:"UNAUTHENTICATED",message:"synthetic unauthorized"}},{status:401});
test("session requests are same-origin, omit ambient credentials and close their abort scope",async()=>{
  let captured:RequestInit|undefined,url="";
  browser(async(input,init)=>{url=String(input);captured=init;return Response.json([]);});
  const session=createSession("synthetic-human-token",()=>{});expect(await session.client.actors()).toEqual([]);
  expect(url).toBe("http://127.0.0.1:4317/hub/v1/actors");expect(captured?.credentials).toBe("omit");expect(captured?.cache).toBe("no-store");expect(new Headers(captured?.headers).get("authorization")).toBe("Bearer synthetic-human-token");
  session.close();expect(captured?.signal?.aborted).toBe(true);
});
test("late 401 from a closed session cannot invalidate its replacement",async()=>{
  let deliver:(response:Response)=>void=()=>{},invalidated=0;
  browser(()=>new Promise(resolve=>{deliver=resolve;}));
  const previous=createSession("synthetic-old-token",()=>{invalidated++;});const pending=previous.client.actors().catch(()=>{});
  previous.close();deliver(unauthorized());await pending;await Promise.resolve();expect(invalidated).toBe(0);
});
test("an active 401 notifies the application so it can clear all module state",async()=>{
  let invalidated=0;browser(async()=>unauthorized());const session=createSession("synthetic-current-token",()=>{invalidated++;});
  await expect(session.client.actors()).rejects.toMatchObject({status:401});await Promise.resolve();expect(invalidated).toBe(1);session.close();
});

test("browser requests identify their boot-time Hub while keeping the bearer out of URLs",async()=>{
 let captured:RequestInit|undefined,url="";browser(async(input,init)=>{url=String(input);captured=init;return Response.json([]);});
 Object.defineProperty(globalThis,"document",{configurable:true,value:{querySelector:()=>({content:"https://expected-hub.example"})}});
 const session=createSession("synthetic-token",()=>{});await session.client.actors();expect(new Headers(captured?.headers).get("x-lumio-hub")).toBe("https://expected-hub.example");expect(url).not.toContain("synthetic-token");session.close();
});

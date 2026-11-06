import { expect, test } from "bun:test";
import { WorkCommandRequest, WorkCommandResult, WorkTask } from "@lumio/schema";
import { DraftStore, type DraftStorage } from "../src/client/draft-store.ts";
import { WorkSave } from "../src/client/work-save.ts";
const at = "2026-11-06T00:00:00Z";
const initial = () => WorkTask.parse({ schema_version: 3, type: "task", id: "task_00000000000000000000000001", title: "Synthetic", description: "Before", revision: 1, outcome: "open", turn: {holder:"human",reason:"todo",since:at},created:at,updated:at,tags:[],dependencies:[],references:[] });
function applied(base: WorkTask, input: WorkCommandRequest) {
  const request = WorkCommandRequest.parse(input);
  if (request.operation.op !== "work.task.update") throw new Error("wrong operation");
  expect(request.operation.args.expected_revision).toBe(base.revision);
  const task = WorkTask.parse({...base,...request.operation.args.patch,revision:base.revision+1});
  return WorkCommandResult.parse({kind:"task",task});
}
test("work autosave serializes title/body/property edits made while saving", async () => {
  let base = initial(), release!:()=>void;
  const gate = new Promise<void>(resolve => release=resolve), requests:WorkCommandRequest[]=[];
  const saver = new WorkSave(base, {async workCommand(request){requests.push(structuredClone(request));if(requests.length===1)await gate;const result=applied(base,request);if(result.kind==="task")base=result.task;return result;}},()=>{});
  saver.change("First", "First body"); const flight=saver.save();
  saver.change("Second", "Second body"); saver.property("workdir","~/synthetic");
  expect(saver.save()).toBe(flight); release();
  const ok = await flight; expect(saver.error).toBeUndefined(); expect(ok).toBe(true);expect(requests).toHaveLength(3);expect(base.title).toBe("Second");expect(base.description).toBe("Second body");expect(base.workdir).toBe("~/synthetic");expect(saver.dirty).toBe(false);
});
test("uncertain work save survives reconstruction and replays the exact request before newer edits",async()=>{
  const base=initial();let receipt:WorkCommandResult|undefined;const calls:WorkCommandRequest[]=[];
  const client={async workCommand(request:WorkCommandRequest){calls.push(structuredClone(request));if(!receipt){receipt=applied(base,request);throw new Error("response lost");}if(request.request_id===calls[0]!.request_id)return receipt;if(receipt.kind!=="task")throw new Error("wrong result");receipt=applied(receipt.task,request);return receipt;}};
  const saver=new WorkSave(base,client,()=>{});saver.change("First","Written");expect(await saver.save()).toBe(false);
  const snapshot=structuredClone(saver.snapshot), restored=new WorkSave(snapshot.base,client,()=>{});
  restored.title=snapshot.title;restored.description=snapshot.description;restored.pending=snapshot.pending;restored.change("Second","Latest");
  expect(await restored.save()).toBe(true);expect(calls[1]).toEqual(calls[0]);expect(calls[2]!.request_id).not.toBe(calls[0]!.request_id);expect(restored.base.title).toBe("Second");
});
test("conflicts retain draft without overwriting the remote record; blank titles can be corrected",async()=>{
  const saver=new WorkSave(initial(),{async workCommand(){throw {code:"CONFLICT"};}},()=>{});
  saver.change("","Draft");expect(await saver.save()).toBe(false);expect(saver.pending).toBeUndefined();saver.change("Valid","Draft");expect(saver.error).toBeUndefined();expect(await saver.save()).toBe(false);expect(saver.dirty).toBe(true);expect(saver.description).toBe("Draft");expect(saver.base.description).toBe("Before");
});
test("no-op property edits settle without a request and invalid numeric input remains recoverable",async()=>{
  let requests=0;const saver=new WorkSave(initial(),{async workCommand(){requests++;throw {code:"INVALID"};}},()=>{});
  saver.property("workdir",null);expect(await saver.save()).toBe(true);expect(requests).toBe(0);expect(saver.dirty).toBe(false);
  saver.property("timeout_minutes","half");expect(await saver.save()).toBe(false);expect(saver.snapshot.properties).toEqual({timeout_minutes:"half"});
});
function storage():DraftStorage {const map=new Map<string,string>();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>{map.set(key,value);},removeItem:key=>{map.delete(key);}};}
test("drafts persist exact empty fields and isolate accounts; an older editor cannot erase newer input",()=>{
  const disk=storage(),store=new DraftStore("account-a",disk),old=store.claim("task:1");old.write({title:"",body:"half"});
  expect(new DraftStore("account-a",disk).read("task:1")).toEqual({title:"",body:"half"});expect(new DraftStore("account-b",disk).read("task:1")).toBeUndefined();
  const next=store.claim("task:1");next.write({body:"newer"});old.remove();old.write({body:"stale"});expect(next.read()).toEqual({body:"newer"});next.remove();expect(store.read("task:1")).toBeUndefined();
});
test("storage denial keeps a session copy and reports that it is not durable; malformed copies are ignored",()=>{
  const store=new DraftStore("a",{getItem:()=>"broken",setItem(){throw new Error("quota");},removeItem(){throw new Error("denied");}});
  expect(store.read("draft")).toBeUndefined();expect(store.write("draft","text")).toBe(false);expect(store.persistent).toBe(false);expect(store.read("draft")).toBe("text");store.remove("draft");expect(store.read("draft")).toBeUndefined();
});

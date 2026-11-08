import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteAIStore } from "@lumio/storage";
import { newId } from "@lumio/foundation";
import { randomBytes } from "node:crypto";
import { AIConfigurationService } from "../src/ai-config.ts";
import { ChatCompletionsModel } from "../src/assistant-model.ts";
import { AssistantModelResponse } from "@lumio/schema";
const owner = newId("act", new Date(), randomBytes), other = newId("act", new Date(), randomBytes);
test("AI connection views never expose keys and profiles cannot acquire permissions", () => {
    const db = new Database(":memory:"), s = new SqliteAIStore(db), ai = new AIConfigurationService(s);
    try {
        const c = ai.connection(owner, { name: "Synthetic API", kind: "deepseek", host: "hub", base_url: "https://api.deepseek.com/v1", api_key: "SYNTHETIC_PRIVATE_KEY" });
        const p = ai.profile(owner, { name: "Synthetic", connection: c.id, engine: "lumio", model: "deepseek-flash", thinking: "on", effort: "high" });
        expect(JSON.stringify(ai.list(owner))).not.toContain("SYNTHETIC_PRIVATE_KEY");
        expect(ai.list(other).profiles).toEqual([]);
        expect(() => ai.get(other, p.id)).toThrow();
        expect(() => ai.profile(other, { name: "Other", connection: c.id, engine: "lumio", model: "x", thinking: "default" })).toThrow();
        expect(() => ai.connection(owner, { name: "SYNTHETIC_PRIVATE_KEY", kind: "deepseek", host: "hub", base_url: "https://api.deepseek.com/v1" }, c.id)).toThrow();
        expect(() => ai.profile(owner, { name: "Unsafe", connection: c.id, engine: "lumio", model: "x", thinking: "on", effort: "ultra" })).toThrow();
    }
    finally {
        db.close();
    }
});
test("DeepSeek reasoning and encrypted state survive a tool continuation without being displayed", async () => {
    const requests: Record<string, any>[] = [];
    const fakeFetch = (async (_url: unknown, init: RequestInit) => { const body = JSON.parse(String(init.body)); requests.push(body); return Response.json({ choices: [{ finish_reason: requests.length === 1 ? "tool_calls" : "stop", message: { role: "assistant", content: requests.length === 1 ? "" : "SYNTHETIC_DONE", ...(requests.length === 1 ? { reasoning_content: "SYNTHETIC_REASONING", encrypted_content: "SYNTHETIC_ENCRYPTED", tool_calls: [{ id: "call-1", type: "function", function: { name: "synthetic_tool", arguments: "{}" } }] } : {}) } }] }); }) as typeof fetch;
    const model = new ChatCompletionsModel({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", credential: () => undefined }, fakeFetch);
    const input = { thinking: "on" as const, reasoning_effort: "high", messages: [{ role: "user" as const, content: "Synthetic question" }], tools: [{ name: "synthetic_tool", description: "Synthetic", input_schema: { type: "object", properties: {} } }] };
    const tokens: string[] = [];
    const first = AssistantModelResponse.parse(await model.complete(input, { token: t => tokens.push(t) }));
    expect(first.continuation?.reasoning_content).toBe("SYNTHETIC_REASONING");
    expect(tokens).toEqual([]);
    await model.complete({ ...input, messages: [...input.messages, { role: "assistant", content: first.content, continuation: first.continuation, tool_calls: first.tool_calls }, { role: "tool", content: "Synthetic result", tool_call_id: "call-1" }] }, { token: t => tokens.push(t) });
    expect(requests[0]?.thinking.type).toBe("enabled");
    expect(requests[0]?.reasoning_effort).toBe("high");
    expect(requests[1]?.messages[1]?.encrypted_content).toBe("SYNTHETIC_ENCRYPTED");
    expect(tokens).toEqual(["SYNTHETIC_DONE"]);
});

test("an active API profile keeps its endpoint and credential snapshot during connection edits",async()=>{
 const db=new Database(":memory:"),ai=new AIConfigurationService(new SqliteAIStore(db));
 try{const c=ai.connection(owner,{name:"Synthetic",kind:"openai-compatible",host:"hub",base_url:"https://first.example.test/v1",api_key:"SYNTHETIC_FIRST_KEY"});const p=ai.profile(owner,{name:"Synthetic",connection:c.id,engine:"lumio",model:"synthetic-model",thinking:"default"});
 const requests:{url:string;authorization:string|null}[]=[];const original=globalThis.fetch;let selected:ReturnType<AIConfigurationService["model"]>;
 try{globalThis.fetch=(async(url:unknown,init:RequestInit)=>{requests.push({url:String(url),authorization:new Headers(init.headers).get("authorization")});return Response.json({choices:[{finish_reason:"stop",message:{role:"assistant",content:"SYNTHETIC_DONE"}}]});}) as typeof fetch;selected=ai.model(owner,p.id);}finally{globalThis.fetch=original;}
 ai.connection(owner,{name:"Changed",kind:"openai-compatible",host:"hub",base_url:"https://second.example.test/v1",api_key:"SYNTHETIC_SECOND_KEY"},c.id);
 await selected.model.complete({messages:[{role:"user",content:"Synthetic"}],tools:[]},{token:()=>{}});
 expect(requests).toEqual([{url:"https://first.example.test/v1/chat/completions",authorization:"Bearer SYNTHETIC_FIRST_KEY"}]);
 }finally{db.close();}
});

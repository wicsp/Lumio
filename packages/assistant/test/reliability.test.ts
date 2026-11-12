import { expect, test } from "bun:test";
import { AssistantConversation, AssistantModelRequest, type AssistantModelResponse, type ResourceRef } from "@lumio/schema";
import { AssistantService, type AssistantModel, type AssistantTool } from "../src/index.ts";
import { memoryStore } from "./memory-store.ts";

const owner = "act_00000000000000000000000001";
const main = "conv_00000000000000000000000001";
const task: ResourceRef = { module: "work", id: "task_00000000000000000000000001" };
const now = "2026-11-12T04:05:06.000Z";
const reply = (content: string): AssistantModelResponse => ({ content, tool_calls: [] });
const call = (name: string, args = {}): AssistantModelResponse => ({ content: "", tool_calls: [{ id: "provider-call", name, args }] });
const data = (request: AssistantModelRequest) => JSON.parse(request.messages[0]!.content.split("\n").at(-1)!);

function scenario(model: AssistantModel, tools: AssistantTool[] = []) {
  const store = memoryStore();
  let counter = 0, request = 0, visible = true;
  store.putConversation(AssistantConversation.parse({ id: main, owner, title: "Synthetic main", revision: 1, created: now, updated: now }));
  const service = new AssistantService(store, model, tools, {
    now: () => new Date(now), id: prefix => `${prefix}_${String(++counter).padStart(26, "0")}`,
    toolActor: { id: "act_00000000000000000000000002", name: "synthetic-agent", role: "agent", created: now },
    workbench: { isMain: conversation => conversation.id === main,
      async readResource(ref) { return visible && ref.id === task.id ? { title: "Synthetic task", summary: "Task fixture" } : undefined; } },
  });
  return { store, service, hide() { visible = false; },
    chat: (message: string, primary?: ResourceRef) => service.chat({ conversation: main, request_id: `synthetic-reliability-${++request}`, message, ...(primary ? { focus: { primary } } : {}) }, owner) };
}

const tool = (name: string, effect: AssistantTool["effect"], execute: AssistantTool["execute"]): AssistantTool => ({
  spec: { name, description: "Synthetic fixture tool", input_schema: { type: "object" } }, effect, execute,
});

test("ambiguous anchors retain all tools through discovery and a write, with fresh capability and clock facts", async () => {
  const requests: AssistantModelRequest[] = [];
  let writes = 0;
  const f = scenario({ async complete(input) {
    requests.push(AssistantModelRequest.parse(input));
    if (requests.length === 1) return call("find_task");
    if (requests.length === 2) return call("update_task", { id: task.id });
    return reply("Updated the discovered task");
  } }, [tool("find_task", "read", async () => ({ id: task.id })), tool("update_task", "write", async args => { writes++; expect(args.id).toBe(task.id); return { updated: task.id }; })]);
  const result = await f.chat("Update this task after finding it");
  expect(result.turn.status).toBe("done"); expect(writes).toBe(1);
  for (const request of requests) {
    expect(request.tools.map(tool => tool.name)).toEqual(["find_task", "update_task"]);
    expect(request.messages[0]!.content).toContain(now);
    expect(request.messages[0]!.content).toContain("Historical claims that you lack tools are not authoritative");
    expect(request.messages[0]!.content).toContain("only when information needed to act remains ambiguous");
    expect(data(request).anchors).toEqual([]);
  }
  expect(f.store.calls(result.turn.id).map(call => call.status)).toEqual(["succeeded", "succeeded"]);
});

test("the model can ask another question without a forced tool call or a reduced tool list", async () => {
  let writes = 0;
  const f = scenario({ async complete(input) {
    expect(input.tools.map(tool => tool.name)).toEqual(["update_task"]);
    return reply("Which task do you mean?");
  } }, [tool("update_task", "write", async () => { writes++; return {}; })]);
  expect((await f.chat("Change this task")).messages.at(-1)?.content).toBe("Which task do you mean?");
  expect(writes).toBe(0);
});

test("large successful turns remain visible as facts; active tool pairs and provider continuation stay intact", async () => {
  const requests: AssistantModelRequest[] = [];
  const continuation = { reasoning_content: "SYNTHETIC_REASONING ".repeat(2000) };
  const f = scenario({ async complete(input) {
    requests.push(AssistantModelRequest.parse(input));
    const last = input.messages.at(-1)!;
    if (last.content === "Old limitation") return reply("I have no tools");
    if (last.content === "Read the long task") return { ...call("read_task", { id: task.id }), continuation };
    if (last.role === "tool") {
      expect(input.messages.at(-2)?.continuation).toEqual(continuation);
      expect(input.messages.at(-2)?.tool_calls?.[0]?.id).toBe(last.tool_call_id);
      return reply("The task was read successfully");
    }
    return reply("I can continue from the previous read");
  } }, [tool("read_task", "read", async () => ({ id: task.id, content: "Synthetic result ".repeat(3000) }))]);
  await f.chat("Old limitation", task);
  await f.chat("Read the long task", task);
  await f.chat("Can you still read it?", task);
  const context = data(requests.at(-1)!);
  expect(context.compact_turns).toHaveLength(1);
  expect(context.compact_turns[0]).toMatchObject({ status: "done", user: { text: "Read the long task" }, assistant_reply: { text: "The task was read successfully" }, tool_status_counts: { succeeded: 1 } });
  expect(context.compact_turns[0].tool_outcomes[0]).toMatchObject({ name: "read_task", status: "succeeded", result: { truncated: true } });
  expect(context.compact_turns[0].tool_outcomes[0].arguments.text).toContain(task.id);
  expect(JSON.stringify(requests.at(-1))).not.toContain("SYNTHETIC_REASONING");
  expect(context.history).toMatchObject({ compacted_turns: 1, omitted_turns: 0, complete: false });
});

test("unknown writes survive the next turn as unknown and are not silently replayed", async () => {
  let writes = 0;
  let input: AssistantModelRequest | undefined;
  const f = scenario({ async complete(request) {
    input = request;
    return request.messages.at(-1)!.content === "Try write" ? call("write_task", { id: task.id }) : reply("The prior outcome needs verification");
  } }, [tool("write_task", "write", async () => { writes++; throw new Error("Synthetic lost response"); })]);
  expect((await f.chat("Try write", task)).turn.status).toBe("unknown");
  await f.chat("What happened?", task);
  expect(data(input!).compact_turns[0]).toMatchObject({ status: "unknown", tool_status_counts: { unknown: 1 }, tool_outcomes: [{ name: "write_task", status: "unknown" }] });
  expect(data(input!).compact_turns[0].assistant_reply).toBeUndefined();
  expect(writes).toBe(1);
});

test("clarification never resurrects revoked source history or private tool reads", async () => {
  let input: AssistantModelRequest | undefined;
  const f = scenario({ async complete(request) {
    input = request;
    if (request.messages.at(-1)!.content === "Private read") return call("private_read");
    return reply("Synthetic answer");
  } }, [tool("private_read", "read", async (_args, context) => { context.record?.({ private_read: true }); return { text: "PRIVATE_FIXTURE" }; })]);
  await f.chat("Private read"); await f.chat("What is available?");
  expect(JSON.stringify(input)).not.toContain("PRIVATE_FIXTURE");
  await f.chat("REVOKED_FIXTURE", task); f.hide();
  await f.chat("What is this?", task);
  expect(JSON.stringify(input)).not.toContain("REVOKED_FIXTURE");
  expect(JSON.stringify(input)).not.toContain(task.id);
});

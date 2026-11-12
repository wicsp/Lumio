import { expect, test } from "bun:test";
import { AssistantConversation, AssistantModelRequest, type AssistantEvent, type AssistantModelResponse, type ResourceRef } from "@lumio/schema";
import { AssistantService, type AssistantContext, type AssistantModel, type AssistantTool } from "../src/index.ts";
import { memoryStore } from "./memory-store.ts";

const owner = "act_00000000000000000000000001", main = "conv_00000000000000000000000001";
const task: ResourceRef = { module: "work", id: "task_00000000000000000000000001" };
const note: ResourceRef = { module: "knowledge", id: "src_00000000000000000000000001" };
const other: ResourceRef = { module: "work", id: "task_00000000000000000000000002" };
const data = (input: AssistantModelRequest) => JSON.parse(input.messages[0]!.content.split("\n").at(-1)!);
const reply = (content: string): AssistantModelResponse => ({ content, tool_calls: [] });
const call = (name: string, args: Record<string, unknown>): AssistantModelResponse => ({ content: "", tool_calls: [{ id: "provider-fixture", name, args }] });

function scenario(model: AssistantModel) {
  const store = memoryStore(), events: AssistantEvent[] = [];
  let count = 0, requests = 0, clock = Date.parse("2026-11-12T16:00:00Z");
  const hidden = new Set<string>();
  const context: AssistantContext = {
    now: () => new Date(clock), id: prefix => `${prefix}_${String(++count).padStart(26, "0")}`,
    toolActor: { id: "act_00000000000000000000000002", name: "synthetic-assistant", role: "agent", created: new Date(clock).toISOString() },
    workbench: { isMain: conversation => conversation.id === main,
      async readResource(ref) { return hidden.has(ref.id) ? undefined : { title: ref.id === note.id ? "Synthetic education note" : "Synthetic task", summary: "Public fixture" }; } },
  };
  const tools: AssistantTool[] = [
    { spec: { name: "knowledge__note__show", description: "Synthetic read", input_schema: {} }, effect: "read", async execute() { return { note: { id: note.id }, body: "SYNTHETIC_EDUCATION_DECISION" }; } },
    { spec: { name: "ui__navigate", description: "Synthetic navigation", input_schema: {} }, effect: "read", async execute(args) {
      const target = args.target as ResourceRef;
      if (hidden.has(target.id)) throw Object.assign(new Error("Synthetic denial"), { code: "FORBIDDEN" });
      return { displayed: true };
    } },
  ];
  store.putConversation(AssistantConversation.parse({ id: main, owner, title: "Synthetic main", revision: 1, created: context.now().toISOString(), updated: context.now().toISOString() }));
  let service = new AssistantService(store, model, tools, context);
  return { store, events, hidden,
    restart() { service = new AssistantService(store, model, tools, context); },
    async chat(message: string, primary: ResourceRef = task) {
      clock += 1000;
      return service.chat({ conversation: main, request_id: `synthetic-topic-${++requests}`, message, focus: { section: primary.module === "knowledge" ? "knowledge" : "work", primary } }, owner, { event: event => events.push(event) });
    },
  };
}

test("an old discussion read from an unrelated page is recalled and re-anchored in the same turn, surviving restart", async () => {
  const inputs: AssistantModelRequest[] = [];
  const f = scenario({ async complete(input) {
    inputs.push(AssistantModelRequest.parse(input));
    const last = input.messages.at(-1)!;
    if (last.content === "聊聊教育") return call("knowledge__note__show", { ref: "synthetic-education-title" });
    if (last.content === "继续刚刚那个教育话题") {
      const candidate = data(input).topic_candidates.find((topic: { ref: ResourceRef }) => topic.ref.id === note.id);
      expect(candidate).toMatchObject({ title: "Synthetic education note", question: "聊聊教育" });
      return call("ui__navigate", { section: "knowledge", target: candidate.ref });
    }
    if (last.role === "tool" && JSON.parse(last.content).displayed) {
      expect(data(input).anchors.map((entry: { ref: ResourceRef }) => entry.ref.id)).toEqual([note.id]);
      expect(input.messages.some(message => message.role === "tool" && message.content.includes("SYNTHETIC_EDUCATION_DECISION"))).toBe(true);
      expect(data(input).display_requests).toEqual([{ target: note, browser_confirmation: "unavailable" }]);
      expect(data(input).focus.primary.id).toBe(other.id);
      return reply("Continuing the education decision");
    }
    return reply("Synthetic discussion");
  } });
  await f.chat("聊聊教育");
  for (let index = 0; index < 20; index++) await f.chat(`Unrelated round ${index}`, { ...other, id: `task_${String(index + 2).padStart(26, "0")}` });
  f.restart();
  const restored = await f.chat("继续刚刚那个教育话题", other);
  expect(restored.turn.status).toBe("done");
  expect(f.store.messageAnchors(main).get(restored.messages.at(-1)!.id)).toEqual([note]);
  expect(f.events.filter(event => event.type === "topic").at(-1)).toMatchObject({ anchors: [note] });
  f.restart(); await f.chat("Continue that decision", other);
  expect(data(inputs.at(-1)!).anchors.map((entry: { ref: ResourceRef }) => entry.ref.id)).toEqual([note.id]);
});

test("focus snapshots distinguish switching away, returning and unchanged focus without claiming a live navigation outcome", async () => {
  const inputs: AssistantModelRequest[] = [];
  const f = scenario({ async complete(input) { inputs.push(input); return reply("Synthetic current page answer"); } });
  await f.chat("Current task", task); await f.chat("Current task", other); await f.chat("Current task", task); await f.chat("Current task", task);
  expect(inputs.map(input => data(input).focus_observation.change)).toEqual(["first_observation", "changed", "changed", "unchanged"]);
  expect(data(inputs[2]!).focus_observation).toMatchObject({ live: false, source: "client_message_snapshot", previous: { focus: { primary: other } } });
  expect(data(inputs[2]!).focus.primary).toEqual(task);
  expect(inputs[2]!.messages[0]!.content).toContain("not evidence that your earlier answer was wrong");
  expect(inputs[2]!.messages[0]!.content).toContain("Never replay an old navigation");
  expect(f.store.turns().flatMap(turn => f.store.calls(turn.id))).toEqual([]);
});

test("revoked discussion sources never reappear through catalog excerpts or inferred read references", async () => {
  let latest: AssistantModelRequest | undefined;
  const f = scenario({ async complete(input) {
    latest = input;
    return input.messages.at(-1)!.content === "Discuss education" ? call("knowledge__note__show", { ref: note.id }) : reply("Private-source-sensitive discussion");
  } });
  await f.chat("Discuss education", task); f.hidden.add(note.id);
  await f.chat("Return to earlier topic", task);
  const content = JSON.stringify(latest);
  expect(content).not.toContain("Private-source-sensitive discussion");
  expect(content).not.toContain("SYNTHETIC_EDUCATION_DECISION");
  expect(content).not.toContain(note.id);
});

test("failed navigation does not change or persist the active topic", async () => {
  let latest: AssistantModelRequest | undefined;
  const f = scenario({ async complete(input) {
    latest = input;
    return input.messages.at(-1)!.content === "Open unavailable resource" ? call("ui__navigate", { section: "knowledge", target: note }) : reply("Could not open the resource");
  } });
  f.hidden.add(note.id);
  const result = await f.chat("Open unavailable resource");
  expect(data(latest!).anchors.map((entry: { ref: ResourceRef }) => entry.ref.id)).toEqual([task.id]);
  expect(data(latest!).display_requests).toEqual([]);
  expect(f.store.messageAnchors(main).get(result.messages.at(-1)!.id)).toEqual([task]);
});

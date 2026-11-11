import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AssistantService, type AssistantModel, type AssistantTool, type AssistantWorkbenchContext } from "@lumio/assistant";
import {
  AssistantConversation, AssistantEvent, AssistantModelRequest, ResourceRef, WorkTask,
  type AssistantModelMessage, type FocusSnapshot,
} from "@lumio/schema";
import { SqliteAssistantStore } from "../src/assistant.ts";

const task = WorkTask.parse(await Bun.file(new URL("../../../fixtures/work/readiness.json", import.meta.url)).json());
const taskRef = ResourceRef.parse({ module: "work", id: task.id });
const paperRef = ResourceRef.parse({ module: "knowledge", id: "pap_00000000000000000000000001" });
const deniedRef = ResourceRef.parse({ module: "knowledge", id: "pap_00000000000000000000000003", label: "PRIVATE LABEL" });
const owner = "act_00000000000000000000000001";
const agent = { id: "act_00000000000000000000000002", name: "assistant", role: "agent" as const, created: task.created };
const main = "conv_00000000000000000000000001";
const profile = "aip_00000000000000000000000001";

function scenario(db: Database, model: AssistantModel, tools: AssistantTool[] = [], overrides: Partial<AssistantWorkbenchContext> = {}) {
  const store = new SqliteAssistantStore(db);
  let next = 0;
  const seenProfiles: string[] = [];
  const context = {
    now: () => new Date(task.created),
    id: (prefix: string) => `${prefix}_${String(++next).padStart(26, "0")}`,
    toolActor: agent,
    resolveModel: (selected: string, actor: string) => {
      expect(actor).toBe(owner);
      seenProfiles.push(selected);
      return { model, settings: { model: "synthetic-model" } };
    },
    workbench: {
      isMain: (conversation) => conversation.id === main && conversation.owner === owner,
      async readResource(ref, actor, signal, scope) {
        expect(actor).toBe(agent.id);
        expect(scope).toMatchObject({ owner, conversation: main });
        expect(signal.aborted).toBe(false);
        expect(ref.label).toBeUndefined();
        if (ref.id === taskRef.id) {
          return { title: task.title, summary: "Synthetic task summary", content: task.description,
            related: [{ ref: { ...paperRef, label: "discard the label" }, summary: "Related paper", content: "non-summary content" }] };
        }
        if (ref.id === paperRef.id) return { title: "English Index Paper", summary: "Synthetic paper summary", content: "研究内容".repeat(1500) };
      },
      ...overrides,
    } satisfies AssistantWorkbenchContext,
  };
  store.putConversation(AssistantConversation.parse({ id: main, title: "Synthetic workbench", owner, revision: 1, created: task.created, updated: task.updated }));
  let requestCount = 0;
  const service = new AssistantService(store, model, tools, context);
  const events: AssistantEvent[] = [];
  const chat = (message: string, primary?: ResourceRef, settings?: { focus?: FocusSnapshot; profile?: string }) =>
    service.chat({ conversation: main, request_id: `synthetic-workbench-${++requestCount}`, message,
      ...(primary ? { focus: { primary } } : {}), ...settings }, owner, { event: event => events.push(AssistantEvent.parse(event)) });
  return { store, context, service, chat, events, seenProfiles };
}

function workbenchData(input: AssistantModelRequest) {
  return JSON.parse(input.messages[0]!.content.split("\n").at(-1)!);
}

function containsToolPair(messages: AssistantModelMessage[], output: string): boolean {
  const index = messages.findIndex(message => message.role === "tool" && message.content.includes(output));
  return index > 0 && (messages[index - 1]!.tool_calls?.some(call => call.id === messages[index]!.tool_call_id) ?? false);
}

test("focus, exact refs and visible titles select anchors as the assistant agent and snapshot only visible focus", async () => {
  const db = new Database(":memory:");
  const requests: AssistantModelRequest[] = [];
  try {
    const f = scenario(db, { async complete(input) {
      const row = db.query<{ request: string }, []>("SELECT request FROM assistant_contexts ORDER BY rowid DESC LIMIT 1").get()!;
      expect(AssistantModelRequest.parse(JSON.parse(row.request))).toEqual(input);
      requests.push(input);
      return { content: "Synthetic reply", tool_calls: [] };
    } });
    const first = await f.chat("这个怎么做", undefined, { focus: { primary: { ...taskRef, label: "client label" }, selected: [],
      selection_text: "synthetic selected text", section: "work" } });
    const firstData = workbenchData(requests[0]!);
    expect(firstData.focus).toEqual({ primary: taskRef, selected: [], selection_text: "synthetic selected text", section: "work" });
    expect(firstData.anchors[0].content).toBe(task.description);
    expect(firstData.related).toEqual([{ ref: paperRef, summary: "Related paper" }]);
    expect(f.events[0]).toEqual({ type: "topic", turn: first.turn.id, anchors: [taskRef] });
    for (const message of first.messages) expect(f.store.messageAnchors(main).get(message.id)).toEqual([taskRef]);

    const second = await f.chat(`Discuss lumio:${paperRef.id}`, taskRef);
    expect(workbenchData(requests[1]!).anchors[0]).toEqual({
      ref: paperRef, title: "English Index Paper", summary: "Synthetic paper summary", read_by_id: true,
    });
    expect(f.events.filter(event => event.type === "topic").at(-1)).toEqual({ type: "topic", turn: second.turn.id, anchors: [paperRef] });

    await f.chat("Continue from Synthetic prerequisite", paperRef, { focus: { selected: [taskRef, paperRef], primary: paperRef } });
    expect(workbenchData(requests[2]!).anchors.map((entry: { ref: ResourceRef }) => entry.ref)).toEqual([taskRef]);
    await f.chat("这个怎么样", undefined, { focus: { primary: deniedRef, selected: [], selection_text: "PRIVATE SELECTION" } });
    expect(requests[3]!.messages[0]!.content).toContain("Ask a short clarifying question");
    expect(requests[3]!.messages[0]!.content).not.toContain("PRIVATE");
    expect(requests[3]!.messages[0]!.content).not.toContain(deniedRef.id);
    expect(requests[3]!.tools).toEqual([]);

    await f.chat("这个呢", undefined, { focus: { selected: [taskRef, paperRef], primary: taskRef } });
    expect(requests[4]!.messages[0]!.content).toContain("Ask a short clarifying question");
    await f.chat("对比这两个", undefined, { focus: { selected: [taskRef, paperRef] } });
    expect(workbenchData(requests[5]!).anchors.map((entry: { ref: ResourceRef }) => entry.ref)).toEqual([taskRef, paperRef]);
    expect(f.events.filter(event => event.type === "topic")).toHaveLength(4);

    await expect(f.service.chat({ request_id: "synthetic-focus-ordinary", message: "Synthetic ordinary", focus: { primary: taskRef } }, owner)).rejects.toThrow("INVALID");
    const ordinary = await f.service.chat({ request_id: "synthetic-create-ordinary", message: "Synthetic ordinary" }, owner);
    expect(requests.at(-1)!.messages[0]!.content).not.toContain("Workbench context");
    expect(f.store.messageAnchors(ordinary.conversation.id).size).toBe(0);
  } finally {
    db.close();
  }
});

test("topic changes persist deduplicated ranges, recall complete tool exchanges immediately, and later use the background summary", async () => {
  const db = new Database(":memory:");
  let unblock!: () => void;
  const held = new Promise<void>(resolve => { unblock = resolve; });
  const foreground: AssistantModelRequest[] = [];
  const summaries: AssistantModelRequest[] = [];
  try {
    const f = scenario(db, { async complete(input) {
      if (input.messages[0]!.content.startsWith("Summarize this past Lumio discussion")) {
        const row = db.query<{ request: string }, []>("SELECT request FROM assistant_fragment_requests").get()!;
        expect(AssistantModelRequest.parse(JSON.parse(row.request))).toEqual(input);
        expect(input.messages[1]!.content).toContain("short authorized result");
        summaries.push(input);
        await held;
        return { content: "Synthetic decision: keep the prerequisite.", tool_calls: [] };
      }
      foreground.push(input);
      if (input.messages.at(-1)!.content === "Read the task") {
        return { content: "", tool_calls: [{ id: "model-fixture", name: "fixture_read", args: { id: taskRef.id } }] };
      }
      return { content: "Synthetic foreground reply", tool_calls: [] };
    } }, [{
      spec: { name: "fixture_read", description: "Read synthetic data", input_schema: {} }, effect: "read",
      async execute() { return { id: taskRef.id, content: "short authorized result", related: "full next-hop data" }; },
    }], {
      async expandReadResult(tool, args, raw, actor, _signal, scope) {
        expect(tool).toBe("fixture_read");
        expect(args).toEqual({ id: taskRef.id });
        expect(actor).toBe(agent.id);
        expect(scope.conversation).toBe(main);
        const result = raw as { id: string; content: string };
        return { id: result.id, content: result.content, related: [{ ref: paperRef, summary: "Next hop summary" }] };
      },
    });
    const first = await f.chat("Read the task", taskRef, { focus: { primary: taskRef, selected: [] }, profile });
    expect(first.messages.map(message => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(first.messages[2]!.content).not.toContain("full next-hop data");
    expect(containsToolPair(foreground.at(-1)!.messages, "short authorized result")).toBe(true);
    for (let index = 0; index < 4; index++) await f.chat(`Paper discussion ${index}`, paperRef);

    const restart = new AssistantService(f.store, { async complete() { throw new Error("Source profile was ignored"); } }, [], f.context);
    const background = restart.drainWorkbenchSummaries();
    const returned = await f.chat("Back to the prerequisite", taskRef);
    expect(returned.turn.status).toBe("done");
    expect(containsToolPair(foreground.at(-1)!.messages, "short authorized result")).toBe(true);
    const source = { conversation: main, firstMessage: first.messages[0]!.id, lastMessage: first.messages.at(-1)!.id, anchors: [taskRef] };
    f.store.enqueueFragment(source, task.created);
    expect(db.query("SELECT * FROM assistant_fragments WHERE first_message=?").all(source.firstMessage)).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    expect(f.seenProfiles).toEqual([profile, profile]);

    unblock();
    await background;
    for (let index = 0; index < 4; index++) await f.chat(`More paper discussion ${index}`, paperRef);
    await f.chat("Use the decision", taskRef);
    const input = foreground.at(-1)!;
    expect(workbenchData(input).summaries).toContainEqual({ firstMessage: source.firstMessage, lastMessage: source.lastMessage,
      summary: "Synthetic decision: keep the prerequisite." });
    expect(containsToolPair(input.messages, "short authorized result")).toBe(false);

    f.service.trash(main, owner);
    expect(f.store.nextFragment(task.created)).toBeUndefined();
    f.store.transaction(() => f.store.purge(main));
    for (const table of ["assistant_message_anchors", "assistant_fragments", "assistant_fragment_requests"]) {
      expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
  } finally {
    unblock();
    db.close();
  }
});

test("budget omits oversized history as whole turns and the summary worker rechecks source access", async () => {
  const db = new Database(":memory:");
  const requests: AssistantModelRequest[] = [];
  let taskVisible = true;
  try {
    const f = scenario(db, { async complete(input) {
      requests.push(input);
      if (input.messages.at(-1)!.content === "Large read") {
        return { content: "", tool_calls: [{ id: "large-model-fixture", name: "large_read", args: {} }] };
      }
      return { content: "Synthetic reply", tool_calls: [] };
    } }, [{
      spec: { name: "large_read", description: "Read synthetic data", input_schema: {} }, effect: "read",
      async execute() { return { content: "large fixture result ".repeat(2000) }; },
    }], {
      async readResource(ref) {
        if (ref.id === taskRef.id && taskVisible) return { title: task.title, summary: "Task" };
        if (ref.id === paperRef.id) return { title: "English Index Paper", summary: "Paper" };
      },
    });
    await f.chat("Large read", taskRef);
    await f.chat("Switch to paper", paperRef);
    expect(requests.at(-1)!.messages.every(message => message.role !== "tool" && !message.tool_calls?.length)).toBe(true);
    expect(f.store.nextFragment(task.created)?.anchors).toEqual([taskRef]);

    taskVisible = false;
    await f.service.drainWorkbenchSummaries();
    expect(db.query("SELECT * FROM assistant_fragment_requests").all()).toEqual([]);
    expect(requests).toHaveLength(3);
    const invalidFocus = await f.chat("Continue on that", taskRef);
    expect(invalidFocus.turn.status).toBe("done");
    expect(requests.at(-1)!.messages[0]!.content).toContain("Ask a short clarifying question");
    expect(requests.at(-1)!.messages[0]!.content).not.toContain(taskRef.id);
  } finally {
    db.close();
  }
});

test("an unchanged page focus preserves an explicitly switched topic across service restarts", async () => {
  const db = new Database(":memory:");
  const requests: AssistantModelRequest[] = [];
  const model: AssistantModel = { async complete(input) {
    requests.push(input);
    return { content: "Synthetic reply", tool_calls: [] };
  } };
  try {
    const f = scenario(db, model);
    await f.chat("这个怎么做", taskRef);
    const switched = await f.chat(`Discuss lumio:${paperRef.id}`, taskRef);
    expect(f.events.filter(event => event.type === "topic").at(-1)).toEqual({ type: "topic", turn: switched.turn.id, anchors: [paperRef] });

    const restartedStore = new SqliteAssistantStore(db);
    const restarted = new AssistantService(restartedStore, model, [], f.context);
    const events: AssistantEvent[] = [];
    const chat = (request_id: string, message: string, focus: Partial<FocusSnapshot>) =>
      restarted.chat({ conversation: main, request_id, message, focus }, owner, { event: event => events.push(event) });
    const followUp = await chat("synthetic-workbench-follow-up", "那第三段呢", { primary: taskRef });
    expect(restartedStore.messageAnchors(main).get(followUp.messages[0]!.id)).toEqual([paperRef]);
    expect(workbenchData(requests.at(-1)!).focus).toEqual({ primary: taskRef, selected: [] });
    expect(workbenchData(requests.at(-1)!).anchors[0].ref).toEqual(paperRef);
    expect(events.some(event => event.type === "topic")).toBe(false);

    await chat("synthetic-workbench-label-update", "这个如何继续", {
      primary: { ...taskRef, label: "Client-only label", revision: "new revision" }, section: "work", selection_text: "Newly highlighted text",
    });
    expect(workbenchData(requests.at(-1)!).anchors[0].ref).toEqual(paperRef);
    expect(workbenchData(requests.at(-1)!).focus).toMatchObject({ section: "work", selection_text: "Newly highlighted text" });
    expect(requests.at(-1)!.messages[0]!.content).not.toContain("Client-only label");

    await chat("synthetic-workbench-open-paper", "这个如何继续", { primary: paperRef });
    const moved = await chat("synthetic-workbench-open-task", "这个如何继续", { primary: taskRef });
    expect(restartedStore.messageAnchors(main).get(moved.messages[0]!.id)).toEqual([taskRef]);
    expect(events.filter(event => event.type === "topic")).toEqual([{ type: "topic", turn: moved.turn.id, anchors: [taskRef] }]);

    const selected = await chat("synthetic-workbench-select-paper", "这个如何继续", { primary: taskRef, selected: [paperRef] });
    expect(restartedStore.messageAnchors(main).get(selected.messages[0]!.id)).toEqual([paperRef]);
    await chat("synthetic-workbench-explicit-task", taskRef.id, { primary: taskRef, selected: [paperRef] });
    const duplicateSelection = await chat("synthetic-workbench-duplicate-selection", "这个如何继续", { primary: taskRef, selected: [paperRef, paperRef] });
    expect(restartedStore.messageAnchors(main).get(duplicateSelection.messages[0]!.id)).toEqual([taskRef]);
  } finally {
    db.close();
  }
});

test("a fragment has three paid summary attempts across restarts and then keeps full-turn recall", async () => {
  const db = new Database(":memory:");
  let clock = Date.parse(task.created);
  let paidCalls = 0;
  const foreground: AssistantModelRequest[] = [];
  const model: AssistantModel = { async complete(input) {
    if (input.messages[0]!.content.startsWith("Summarize this past Lumio discussion")) {
      paidCalls++;
      if (paidCalls === 1) throw new Error("synthetic provider failure");
      if (paidCalls === 2) return { content: null, tool_calls: [] } as unknown as Awaited<ReturnType<AssistantModel["complete"]>>;
      return { content: "   ", tool_calls: [] };
    }
    foreground.push(input);
    if (input.messages.at(-1)!.content === "Read once") {
      return { content: "", tool_calls: [{ id: "fixture-read", name: "fixture_read", args: {} }] };
    }
    return { content: "Synthetic reply", tool_calls: [] };
  } };
  const tools: AssistantTool[] = [{
    spec: { name: "fixture_read", description: "Read synthetic data", input_schema: {} },
    effect: "read",
    async execute() { return { content: "complete fixture result" }; },
  }];
  try {
    const f = scenario(db, model, tools);
    f.context.now = () => new Date(clock);
    const first = await f.chat("Read once", taskRef);
    for (let index = 0; index < 4; index++) await f.chat(`Paper discussion ${index}`, paperRef);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const worker = new AssistantService(new SqliteAssistantStore(db), model, [], f.context);
      const drain = worker.drainWorkbenchSummaries();
      if (attempt <= 2) await expect(drain).rejects.toThrow();
      else await drain;
      expect(paidCalls).toBe(attempt);
      clock += 600_000;
    }

    const restartedStore = new SqliteAssistantStore(db);
    const restarted = new AssistantService(restartedStore, model, tools, f.context);
    const firstMessage = first.messages[0]!.id, lastMessage = first.messages.at(-1)!.id;
    restartedStore.enqueueFragment({ conversation: main, firstMessage, lastMessage, anchors: [taskRef] }, f.context.now().toISOString());
    expect(restartedStore.nextFragment(f.context.now().toISOString())).toBeUndefined();
    await restarted.drainWorkbenchSummaries();
    expect(paidCalls).toBe(3);
    expect(db.query("SELECT attempts,summary FROM assistant_fragments WHERE first_message=? AND last_message=?").get(firstMessage, lastMessage))
      .toEqual({ attempts: 3, summary: null });
    expect(db.query("SELECT attempt FROM assistant_fragment_requests WHERE first_message=? AND last_message=? ORDER BY attempt").all(firstMessage, lastMessage))
      .toEqual([{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }]);

    const recalled = await restarted.chat({ conversation: main, request_id: "synthetic-after-cap", message: "Back to the task", focus: { primary: taskRef } }, owner);
    expect(recalled.turn.status).toBe("done");
    expect(workbenchData(foreground.at(-1)!).summaries).toEqual([]);
    expect(containsToolPair(foreground.at(-1)!.messages, "complete fixture result")).toBe(true);
  } finally {
    db.close();
  }
});

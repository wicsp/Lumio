import { afterEach, beforeEach, expect, test } from "bun:test";
import { AssistantChatRequest, FOCUS_LIMITS, FocusSnapshot, NoteDetail, type ResourceRef } from "@lumio/schema";
import { KnowledgePane } from "../../src/client/panes/knowledge.ts";
import { WorkbenchView } from "../../src/client/views/workbench.ts";
import { MainDock } from "../../src/client/main-dock.ts";
import { buildFocus, type FocusInput } from "../../src/client/workbench-assist.ts";
import fixture from "../fixtures/note-focus.json";

// Exercise the real pane load/render, workbench collection and dock send with a small DOM surface.
class ElementStub extends EventTarget {
  children: (ElementStub | string)[] = [];
  attrs: Record<string, string> = {};
  className = "";
  innerHTML = "";
  value = "";
  scrollTop = 0;
  isConnected = false;
  classList = { add() {}, remove() {}, toggle() {} };
  constructor(readonly tag: string) { super(); }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  append(...children: (ElementStub | string)[]): void { this.children.push(...children); }
  replaceChildren(): void { this.children = []; }
  remove(): void {}
  querySelectorAll(): ElementStub[] { return []; }
  querySelector(selector: string): ElementStub | undefined {
    return this.find(node => selector === "article" ? node.tag === "article" : selector === ".reader" ? node.className === "reader" : false);
  }
  find(match: (node: ElementStub) => boolean): ElementStub | undefined {
    if (match(this)) return this;
    for (const child of this.children) {
      if (child instanceof ElementStub) { const hit = child.find(match); if (hit) return hit; }
    }
  }
}

let restore: () => void;
beforeEach(() => {
  const descriptors = ["document", "window", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries({
    document: { documentElement: { lang: "en" }, createElement: (tag: string) => new ElementStub(tag), createElementNS: (_ns: string, tag: string) => new ElementStub(tag) },
    window: { getSelection: () => null }, Node: ElementStub,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });
  restore = () => { for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } };
});
afterEach(() => restore());

const seed = NoteDetail.parse(fixture);
const second = NoteDetail.parse({ ...fixture, note: { ...fixture.note, id: "pap_01JA0000000000000000000001", type: "paper", title: "Another synthetic note" } });

function setup(initialHash = "#knowledge") {
  let next: Promise<NoteDetail> = Promise.resolve(seed);
  const changes: (ResourceRef | undefined)[] = [];
  const pane = Object.assign(Object.create(KnowledgePane.prototype), {
    active: true, generation: 0, relatedGeneration: 0, includePrivate: false,
    detail: new ElementStub("section"), results: new ElementStub("div"), split: new ElementStub("div"), related: new ElementStub("section"),
    outline: { refresh() {} }, recoveries: new WeakMap(),
    // Reading and editing share the same render path; editor state is supplied explicitly below.
    enableEditing: async () => {},
    client: { show: async (_ref: string) => next, links: async () => undefined },
    focusChanged: () => changes.push(pane.focus),
  }) as KnowledgePane;
  const view = Object.assign(Object.create(WorkbenchView.prototype), {
    currentHash: initialHash, current: { pane }, main: { contains: () => false },
  }) as unknown as { focusInput(): FocusInput };
  return { pane, view, changes, load(value: Promise<NoteDetail> | NoteDetail) { next = Promise.resolve(value); },
    snapshot() { return FocusSnapshot.parse(buildFocus(view.focusInput())); } };
}

test("list open at #knowledge sends the loaded note as primary and selected", async () => {
  const f = setup();
  expect(f.snapshot()).toEqual({ section: "knowledge", selected: [] });
  await f.pane.open(seed.note.id!);
  const expected: ResourceRef = { module: "knowledge", id: seed.note.id!, label: seed.note.title };
  expect(f.snapshot()).toEqual({ section: "knowledge", primary: expected, selected: [expected] });
  expect(f.changes.at(-1)).toEqual(expected);
});

test("direct URL, path and citekey entry resolve to the loaded stable ID", async () => {
  for (const reference of [seed.note.id!, seed.note.path, "Synthetic2026"]) {
    const f = setup(`#knowledge/${encodeURIComponent(reference)}`);
    expect(f.snapshot().primary).toBeUndefined(); // A route alone is not a loaded note.
    await f.pane.open(reference);
    expect(f.snapshot().selected[0]?.id).toBe(seed.note.id!);
  }
});

test("internal link/graph navigation overrides a stale direct URL and ignores late responses", async () => {
  const f = setup(`#knowledge/${seed.note.id}`);
  let finish!: (note: NoteDetail) => void;
  f.load(new Promise(resolve => { finish = resolve; }));
  const older = f.pane.open(seed.note.id!);
  await Promise.resolve(); await Promise.resolve();
  f.load(second);
  await f.pane.open(second.note.id!);
  finish(seed); await older;
  expect(f.snapshot().selected[0]?.id).toBe(second.note.id!);
});

test("all current knowledge types share focus; idless and legacy notes do not fabricate refs", async () => {
  for (const [type, prefix] of [["paper", "pap"], ["source", "src"], ["idea", "idea"], ["experiment", "exp"], ["post", "post"], ["asset", "ast"], ["ai-note", "ain"]] as const) {
    const f = setup();
    const note = NoteDetail.parse({ ...fixture, note: { ...fixture.note, type, id: `${prefix}_01JA0000000000000000000000` } });
    f.load(note); await f.pane.open(note.note.id!);
    expect(f.snapshot().selected[0]).toMatchObject({ module: "knowledge", id: note.note.id });
  }
  for (const note of [
    NoteDetail.parse({ ...fixture, note: { ...fixture.note, id: undefined } }),
    NoteDetail.parse({ ...fixture, note: { ...fixture.note, type: "task", id: "task_01JA0000000000000000000000" } }),
  ]) {
    const f = setup(`#knowledge/${note.note.id ?? note.note.path}`);
    f.load(note); await f.pane.open(note.note.id ?? note.note.path);
    expect(f.snapshot()).toEqual({ section: "knowledge", selected: [] });
  }
});

test("loading, failed reads and returning to the placeholder clear the old focus", async () => {
  const f = setup(`#knowledge/${seed.note.id}`);
  await f.pane.open(seed.note.id!);
  let fail!: (error: Error) => void;
  f.load(new Promise((_resolve, reject) => { fail = reject; }));
  const loading = f.pane.open(second.note.id!);
  await Promise.resolve(); await Promise.resolve();
  expect(f.snapshot()).toEqual({ section: "knowledge", selected: [] });
  fail(new Error("Synthetic missing note")); await loading;
  expect(f.snapshot().primary).toBeUndefined();
  f.load(seed); await f.pane.open(seed.note.id!, true);
  const internal = f.pane as unknown as { clearWriter(): void; showPlaceholder(): void };
  internal.clearWriter(); internal.showPlaceholder();
  expect(f.snapshot().selected).toEqual([]);
  expect(f.changes.at(-1)).toBeUndefined();
});

test("editing uses the persisted title/revision and clears focus even before the saver is released", async () => {
  const f = setup(); await f.pane.open(seed.note.id!);
  const state = f.pane as unknown as { saver: { base: { document: NoteDetail; revision: string }; dirty: boolean }; clearWriter(): void };
  state.saver = { base: { document: seed, revision: "synthetic-revision-1" }, dirty: false };
  expect(f.snapshot().selected[0]?.revision).toBe("synthetic-revision-1");
  state.saver.base = { document: { ...seed, note: { ...seed.note, title: "Saved new title" } }, revision: "synthetic-revision-2" };
  expect(f.snapshot().selected[0]).toMatchObject({ label: "Saved new title", revision: "synthetic-revision-2" });
  state.clearWriter();
  expect(f.changes.at(-1)).toBeUndefined();
  expect(f.snapshot().selected).toEqual([]);
});

// Drive the real submit path, including focus modes and AssistantChatRequest validation.
async function send(focus: () => FocusInput, mode = "auto", pinned?: FocusInput) {
  let request: AssistantChatRequest | undefined;
  const text = new ElementStub("textarea"); text.value = "Summarize this note";
  const dock = Object.assign(Object.create(MainDock.prototype), {
    mode, pinned, host: { focus }, text, conversation: "conv_01JA0000000000000000000000", titles: new Map(),
    start: async () => {}, setBusy() {}, notice: new ElementStub("div"), messages: new ElementStub("div"), scroller: new ElementStub("div"),
    client: { async *assistantEvents(value: AssistantChatRequest) { request = AssistantChatRequest.parse(value); } },
  }) as unknown as { submit(): Promise<void> };
  await dock.submit();
  return request!;
}

test("dock sends note label/revision; pin retains the old note; disabling sharing sends no focus", async () => {
  const f = setup(); await f.pane.open(seed.note.id!);
  const pinned = f.view.focusInput();
  f.load(second); await f.pane.open(second.note.id!);
  const state = f.pane as unknown as { saver: { base: { document: NoteDetail; revision: string }; dirty: boolean } };
  state.saver = { base: { document: second, revision: "synthetic-revision-2" }, dirty: false };
  expect((await send(() => f.view.focusInput())).focus?.selected[0]).toEqual({
    module: "knowledge", id: second.note.id!, label: second.note.title, revision: "synthetic-revision-2",
  });
  expect((await send(() => f.view.focusInput(), "pinned", pinned)).focus?.selected[0]?.id).toBe(seed.note.id!);
  expect((await send(() => f.view.focusInput(), "off")).focus).toBeUndefined();
});

test("knowledge primary plus selected still respect the shared focus byte budget", () => {
  const focus = FocusSnapshot.parse(buildFocus({ section: "knowledge", id: seed.note.id!, label: "字".repeat(200),
    revision: "synthetic-revision", selection: "👨‍👩‍👧‍👦".repeat(FOCUS_LIMITS.max_selection_graphemes) }));
  expect(focus.selected[0]?.id).toBe(seed.note.id!);
  expect(new TextEncoder().encode(JSON.stringify(focus)).length).toBeLessThanOrEqual(FOCUS_LIMITS.max_bytes);
});

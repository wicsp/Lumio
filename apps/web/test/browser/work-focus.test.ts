import { afterEach, beforeEach, expect, test } from "bun:test";
import { AssistantChatRequest, WorkTask, WorkTaskDetail, WorkProject, type ResourceRef } from "@lumio/schema";
import seed from "../../../../fixtures/work/readiness.json";
import { WorkPane } from "../../src/client/panes/work.ts";
import { WorkEditor } from "../../src/client/panes/work-editor.ts";
import { WorkbenchView } from "../../src/client/views/workbench.ts";
import { MainDock } from "../../src/client/main-dock.ts";
import { buildFocus, type FocusInput } from "../../src/client/workbench-assist.ts";

class ElementStub extends EventTarget {
  children: unknown[] = [];
  value = ""; scrollTop = 0; hidden = false; innerHTML = ""; textContent = "";
  classList = { add() {}, remove() {}, toggle() {} };
  setAttribute() {}
  append(...items: unknown[]) { this.children.push(...items); }
  replaceChildren() { this.children = []; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  remove() {}
}
let restore: () => void;
beforeEach(() => {
  const values = {
    document: { documentElement: { lang: "en" }, createElement: () => new ElementStub(), createElementNS: () => new ElementStub() },
    window: { getSelection: () => null }, Node: ElementStub,
    location: { hash: "#work/tasks" }, history: { replaceState() {} },
  };
  const old = Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  restore = () => { for (const [key, descriptor] of old) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } };
});
afterEach(() => restore());

const first = WorkTaskDetail.parse({ task: WorkTask.parse(seed), comments: [], executions: [], turns: [], children: [], dependents: [] });
const second = WorkTaskDetail.parse({ ...first, task: { ...first.task, id: "task_00000000000000000000000002", title: "Synthetic second task" } });
const project = WorkProject.parse({ schema_version: 2, type: "project", id: "prj_00000000000000000000000001", title: "Synthetic project",
  description: "", revision: 3, status: "active", created: seed.created, updated: seed.updated, tags: [] });

function setup(mode: "tasks" | "projects" = "tasks", hash = "#work/tasks") {
  let result: Promise<WorkTaskDetail | WorkProject> = Promise.resolve(first);
  const changes: (ResourceRef | undefined)[] = [];
  const sharingResets: boolean[] = [];
  const pane = Object.assign(Object.create(WorkPane.prototype), {
    active: true, mode, root: new ElementStub(), detail: new ElementStub(), dock: new ElementStub(), list: new ElementStub(), split: new ElementStub(), detailGeneration: 0,
    client: { workTask: () => result, workProject: () => result }, renderEditor() {},
    focusChanged: (reset: boolean) => { changes.push(pane.focus); sharingResets.push(reset); },
  }) as WorkPane;
  const view = Object.assign(Object.create(WorkbenchView.prototype), { currentHash: hash, current: { pane }, main: { contains: () => false } }) as unknown as { focusInput(): FocusInput };
  return { pane, view, changes, sharingResets, load(value: Promise<WorkTaskDetail | WorkProject> | WorkTaskDetail | WorkProject) { result = Promise.resolve(value); },
    snapshot: () => buildFocus(view.focusInput()) };
}

async function send(focus: () => FocusInput, mode = "auto", pinned?: FocusInput, start = async () => {}) {
  let request: AssistantChatRequest | undefined;
  const text = new ElementStub(); text.value = "What is this task?";
  const dock = Object.assign(Object.create(MainDock.prototype), {
    mode, pinned, host: { focus }, text, conversation: "conv_00000000000000000000000001", titles: new Map(), start, setBusy() {},
    notice: new ElementStub(), messages: new ElementStub(), scroller: new ElementStub(),
    client: { async *assistantEvents(value: AssistantChatRequest) { request = AssistantChatRequest.parse(value); } },
  }) as unknown as { submit(): Promise<void> };
  await dock.submit(); return request!;
}

test("manual task selection overrides both list routes and previous AI navigation in the actual chat request", async () => {
  for (const hash of ["#work/tasks", `#work/${first.task.id}`]) {
    const f = setup("tasks", hash);
    expect(f.snapshot()?.primary).toBeUndefined();
    await f.pane.open(first.task.id);
    expect((await send(() => f.view.focusInput())).focus?.primary).toMatchObject({ id: first.task.id, revision: "1" });
    f.load(second); await f.pane.open(second.task.id);
    expect((await send(() => f.view.focusInput())).focus?.primary).toMatchObject({ id: second.task.id, label: second.task.title });
    expect(f.changes.at(-1)?.id).toBe(second.task.id);
  }
});

test("projects use their loaded object and persisted editor revision", async () => {
  const f = setup("projects", "#work/projects"); f.load(project); await f.pane.open(project.id);
  expect((await send(() => f.view.focusInput())).focus?.primary).toMatchObject({ id: project.id, revision: "3" });
  const editor = Object.assign(Object.create(WorkEditor.prototype), { record: { ...project, revision: 4, title: "Saved title" } });
  Object.assign(f.pane, { editor });
  expect(f.snapshot()?.primary).toMatchObject({ id: project.id, revision: "4", label: "Saved title" });
});

test("loading, failure and closing clear focus; a late response cannot restore a previous task", async () => {
  const f = setup(); await f.pane.open(first.task.id);
  let resolve!: (value: WorkTaskDetail) => void;
  f.load(new Promise(done => { resolve = done; }));
  const old = f.pane.open(second.task.id);
  await Promise.resolve(); await Promise.resolve();
  expect(f.snapshot()?.primary).toBeUndefined();
  f.load(first); await f.pane.open(first.task.id);
  resolve(second); await old;
  expect(f.snapshot()?.primary?.id).toBe(first.task.id);
  f.load(Promise.reject(new Error("Synthetic unavailable task"))); await f.pane.open(second.task.id);
  expect(f.snapshot()?.primary).toBeUndefined();
  f.load(first); await f.pane.open(first.task.id);
  (f.pane as unknown as { closeDetail(): void }).closeDetail();
  expect(f.snapshot()?.primary).toBeUndefined();
});

test("pin preserves the chosen task and disabled sharing omits focus", async () => {
  const f = setup(); await f.pane.open(first.task.id); const pinned = f.view.focusInput();
  f.load(second); await f.pane.open(second.task.id);
  expect((await send(() => f.view.focusInput(), "pinned", pinned)).focus?.primary?.id).toBe(first.task.id);
  expect((await send(() => f.view.focusInput(), "off")).focus).toBeUndefined();
});

test("a delayed title lookup cannot replace the current context chip", async () => {
  let input: FocusInput = { section: "work", id: first.task.id };
  let finish!: (title: string) => void;
  const chip = new ElementStub();
  const dock = Object.assign(Object.create(MainDock.prototype), {
    mode: "auto", chipGeneration: 0, chip, exploring: new Set(), host: { focus: () => input },
    title: () => new Promise<string>(resolve => { finish = resolve; }),
  }) as unknown as { renderChip(): Promise<void> };
  const old = dock.renderChip();
  input = { section: "work", id: second.task.id, label: second.task.title };
  await dock.renderChip();
  const current = chip.children.slice();
  finish("Old title"); await old;
  expect(chip.children).toEqual(current);
  expect(JSON.stringify(chip.children)).toContain(second.task.title);
});

test("background refresh updates focus without re-enabling disabled sharing", async () => {
  const f = setup(); await f.pane.open(first.task.id);
  expect(f.sharingResets).toEqual([true, false]);
  f.sharingResets.length = 0;
  Object.assign(f.pane, { canRefreshDetail: () => true });
  f.load({ ...first, task: { ...first.task, revision: 2 } });
  await f.pane.open(first.task.id, true, true);
  expect(f.sharingResets).toEqual([false]);
  expect(f.snapshot()?.primary?.revision).toBe("2");
  const dock = Object.assign(Object.create(MainDock.prototype), { mode: "off", renderChip: async () => {} }) as MainDock;
  dock.pageChanged(f.sharingResets[0]);
  expect(Reflect.get(dock, "mode")).toBe("off");
  dock.pageChanged(true);
  expect(Reflect.get(dock, "mode")).toBe("auto");
});

test("sending fixes the selected task before waiting for the conversation to initialize", async () => {
  const f = setup(); await f.pane.open(first.task.id);
  f.load(second);
  const request = await send(() => f.view.focusInput(), "auto", undefined, () => f.pane.open(second.task.id));
  expect(f.snapshot()?.primary?.id).toBe(second.task.id);
  expect(request.focus?.primary?.id).toBe(first.task.id);
});

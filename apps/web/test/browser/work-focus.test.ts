import { afterEach, beforeEach, expect, test } from "bun:test";
import { AssistantChatRequest, WorkCommandRequest, WorkTask, WorkTaskDetail, WorkProject, type ResourceRef } from "@lumio/schema";
import seed from "../../../../fixtures/work/readiness.json";
import { WorkPane } from "../../src/client/panes/work.ts";
import { WorkEditor } from "../../src/client/panes/work-editor.ts";
import { WorkbenchView } from "../../src/client/views/workbench.ts";
import { MainDock } from "../../src/client/main-dock.ts";
import { resourceLinks } from "../../src/client/resources.ts";
import { buildFocus, type FocusInput } from "../../src/client/workbench-assist.ts";
import type { Client, HubExtras } from "../../src/client/api.ts";

class ElementStub extends EventTarget {
  children: unknown[] = [];
  attributes = new Map<string, string>();
  style = { height: "" };
  private listeners = new Map<string, EventListener[]>();
  className = ""; disabled = false;
  #parent?: ElementStub;
  get isConnected(): boolean { return Object.is(this, globalThis.document?.body) || this.#parent?.isConnected === true; }
  value = ""; scrollTop = 0; hidden = false; innerHTML = ""; textContent = "";
  classList = { add() {}, remove() {}, toggle() {} };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  get dataset() { return { resource: this.attributes.get("data-resource") }; }
  append(...items: unknown[]) {
    for (const item of items) if (item instanceof ElementStub) item.#parent = this;
    this.children.push(...items);
  }
  replaceChildren() {
    for (const child of this.children) if (child instanceof ElementStub) child.#parent = undefined;
    this.children = [];
  }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  contains(element: ElementStub): boolean {
    return element === this || (element.#parent !== undefined && this.contains(element.#parent));
  }
  closest(selector: string) { return selector === "[data-resource]" && this.dataset.resource ? this : null; }
  after() {}
  remove() {}
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type, callback, options);
    if (typeof callback === "function") this.listeners.set(type, [...this.listeners.get(type) ?? [], callback]);
  }
  userInput(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, isTrusted: true } as Event);
  }
}
let restore: () => void;
beforeEach(() => {
  const values = {
    document: { body: new ElementStub(), documentElement: { lang: "en" }, createElement: () => new ElementStub(), createElementNS: () => new ElementStub() },
    window: Object.assign(new EventTarget(), { getSelection: () => null }), Node: ElementStub,
    ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
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
const project = WorkProject.parse({ schema_version: 2, type: "project", created_by: "act_00000000000000000000000001", updated_by: "act_00000000000000000000000001", id: "prj_00000000000000000000000001", title: "Synthetic project",
  description: "", revision: 3, status: "active", created: seed.created, updated: seed.updated, tags: [] });

test("task knowledge references open the resolved resource or show why it is unavailable", async () => {
  const idea = "idea_00000000000000000000000001";
  const source = "src_00000000000000000000000001";
  const note = "ain_00000000000000000000000001";
  const trashed = "ain_00000000000000000000000002";
  const missing = "src_00000000000000000000000002";
  const detail = WorkTaskDetail.parse({ ...first, task: { ...first.task, references: [
    { module: "knowledge", id: idea, label: "Discussion" },
    { module: "knowledge", id: source },
    { module: "knowledge", id: note, label: "AI note" },
    { module: "knowledge", id: trashed, label: "Trashed note" },
    { module: "knowledge", id: missing, label: "Missing source" },
    { module: "work", id: second.task.id, label: "Other task" },
  ] } });
  const root = new ElementStub();
  const navigations: unknown[][] = [];
  const lookups: string[] = [];
  const navigate = (...args: unknown[]) => { navigations.push(args); };
  const client = {
    actors: async () => [],
    workTasks: async () => [],
    async resource(id: string) {
      lookups.push(id);
      if (id === trashed) return { id, status: "trashed" };
      if (id === missing) return { id, status: "unavailable" };
      return { id, status: "visible", title: id };
    },
  } as unknown as Client;
  const editor = new WorkEditor(root as unknown as HTMLElement, root as unknown as HTMLElement,
    client, {} as HubExtras, detail, [], { navigate, back() {}, openProject() {}, changed() {}, reload() {} }, null);
  const disposeLinks = resourceLinks(root as unknown as HTMLElement, client, navigate);
  const descendants = (node: ElementStub): ElementStub[] =>
    [node, ...node.children.flatMap(child => child instanceof ElementStub ? descendants(child) : [])];
  try {
    const links = descendants(root).filter(node => node.className === "resource-link");
    expect(links.map(link => [link.attributes.get("href"), link.children[0]])).toEqual([
      [`lumio:${idea}`, "Discussion"], [`lumio:${source}`, source], [`lumio:${note}`, "AI note"],
      [`lumio:${trashed}`, "Trashed note"], [`lumio:${missing}`, "Missing source"],
    ]);
    for (const link of links) {
      const click = new Event("click", { cancelable: true });
      Object.defineProperty(click, "target", { value: link });
      root.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
    }
    await Bun.sleep(0);
    expect(lookups).toEqual([idea, source, note, trashed, missing]);
    expect(navigations).toEqual([["knowledge", idea], ["knowledge", source], ["knowledge", note]]);
    const notices = descendants(document.body as unknown as ElementStub).flatMap(node => node.children);
    expect(notices).toContain("This item is in Recently deleted.");
    expect(notices).toContain("This item isn't available to you.");
  } finally {
    disposeLinks();
    editor.dispose();
  }
});

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

test("opening a Work card clears its own unread reminders after the detail loads", async () => {
  const f = setup();
  const view = f.view as typeof f.view & { readSubject(id: string): void };
  const unread = new Map([[first.task.id, ["notice:first", "notice:follow-up"]], [second.task.id, ["notice:second"]]]);
  const reads: string[][] = [];
  Object.assign(view, { unread, decorate() {}, refreshCounts() {},
    session: { client: { async readNotices(_request: string, ids: string[]) { reads.push(ids); } } },
  });
  Object.assign(f.pane, { onReadSubject: (id: string) => view.readSubject(id), canRefreshDetail: () => true });

  const detail = Promise.withResolvers<WorkTaskDetail>();
  f.load(detail.promise);
  const opening = f.pane.open(first.task.id);
  expect(reads).toEqual([]);
  detail.resolve(first);
  await opening;
  expect(reads).toEqual([["notice:first", "notice:follow-up"]]);
  expect([...unread.keys()]).toEqual([second.task.id]);

  unread.set(first.task.id, ["notice:new"]);
  f.load({ ...first, task: { ...first.task, revision: first.task.revision + 1 } });
  await f.pane.open(first.task.id, true, true);
  expect(unread.get(first.task.id)).toEqual(["notice:new"]);
});

test("interacting with a visible Work detail acknowledges the open card", async () => {
  const root = new ElementStub();
  const reads: string[] = [];
  const client = { workProjects: async () => [], workTasks: async () => [], workTask: async () => first } as unknown as Client;
  const pane = new WorkPane(root as unknown as HTMLElement, client, {} as HubExtras, "tasks", undefined,
    () => {}, () => {}, undefined, id => reads.push(id));
  Object.assign(pane, { renderEditor() {} });
  const detail = Reflect.get(pane, "detailLayout") as ElementStub;
  try {
    detail.userInput("click");
    expect(reads).toEqual([]);
    await pane.open(first.task.id);
    expect(reads).toEqual([first.task.id]);
    reads.length = 0;

    root.userInput("wheel");
    detail.userInput("scroll");
    detail.dispatchEvent(new Event("click"));
    expect(reads).toEqual([]);
    for (const type of ["click", "wheel", "touchmove", "keydown", "pointerdown"]) {
      detail.userInput(type);
      expect(reads.pop()).toBe(first.task.id);
    }
    root.hidden = true;
    detail.userInput("click");
    expect(reads).toEqual([]);
  } finally { pane.dispose(); }
});

test("project to-dos delegate in place and refresh into the agents group", async () => {
  const eligible = WorkTask.parse({ ...first.task, project: project.id, next_target: { target: "codex@test", source: "project" } });
  const blocked = WorkTask.parse({ ...second.task, project: project.id, next_target: eligible.next_target, dependencies: [eligible.id], blocked_by: [eligible.id] });
  let tasks = [eligible, blocked];
  const reads: string[] = [];
  const commands: WorkCommandRequest[] = [];
  const navigations: unknown[][] = [];
  let changes = 0;
  const editor = Object.assign(Object.create(WorkEditor.prototype), {
    active: true,
    client: {
      workTasks: async ({ project }: { project: string }) => { reads.push(project); return tasks; },
      workCommand: async (request: unknown) => {
        commands.push(WorkCommandRequest.parse(request));
        tasks = [WorkTask.parse({ ...eligible, revision: eligible.revision + 1, next_target: undefined,
          turn: { holder: "codex@test", reason: "working", since: eligible.updated, job: "job_00000000000000000000000001" } }), blocked];
        return { kind: "job", job: { spec: { id: tasks[0]!.turn.job } } };
      },
    },
    hooks: { navigate: (...args: unknown[]) => navigations.push(args), changed: () => changes++ },
  }) as { projectTasks(project: WorkProject): ElementStub };

  const section = editor.projectTasks(project);
  document.body.append(section as unknown as Node);
  const descendants = (node: ElementStub): ElementStub[] =>
    [node, ...node.children.flatMap(child => child instanceof ElementStub ? descendants(child) : [])];
  const find = (name: string) => descendants(section).filter(node => node.className.split(" ").includes(name));
  await Bun.sleep(0);

  expect(find("run")).toHaveLength(2);
  expect(find("quick-delegate")).toHaveLength(1);
  const delegate = find("quick-delegate")[0]!;
  expect(find("task-action-row")[0]?.children).toEqual([find("run")[0], find("quick-delegate-group")[0]]);
  delegate.dispatchEvent(new Event("click"));
  delegate.dispatchEvent(new Event("click"));
  await Bun.sleep(0);

  expect(commands.map(command => command.operation)).toEqual([
    { op: "work.task.dispatch", args: { task: eligible.id, expected_revision: eligible.revision } },
  ]);
  expect(reads).toEqual([project.id, project.id]);
  expect(changes).toBe(1);
  expect(navigations).toEqual([]);
  expect(find("quick-delegate")).toHaveLength(0);
  expect(descendants(section).flatMap(node => node.children)).toContain("codex@test is working");
});

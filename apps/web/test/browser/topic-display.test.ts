import { afterEach, beforeEach, expect, test } from "bun:test";
import { AssistantEvent, type WorkbenchAction } from "@lumio/schema";
import { MainDock } from "../../src/client/main-dock.ts";
import { WorkbenchView } from "../../src/client/views/workbench.ts";
import { canNavigateNow, type FocusInput } from "../../src/client/workbench-assist.ts";

class ElementStub extends EventTarget {
  children: unknown[] = []; hidden = false; value = ""; innerHTML = ""; textContent = ""; scrollTop = 0;
  classList = { add() {}, remove() {} };
  setAttribute() {} remove() {}
  append(...children: unknown[]) { this.children.push(...children); }
  replaceChildren(...children: unknown[]) { this.children = children; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
let restore: () => void;
beforeEach(() => {
  const globals = { Node: ElementStub, document: { documentElement: { lang: "en" }, activeElement: null, visibilityState: "visible", hasFocus: () => true,
    querySelector: () => null, createElement: () => new ElementStub(), createElementNS: () => new ElementStub() } };
  const old = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  restore = () => { for (const [key, descriptor] of old) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } };
});
afterEach(() => restore());
const task = "task_00000000000000000000000001", note = "src_00000000000000000000000001";
const navigation: WorkbenchAction = { action: "navigate", section: "knowledge", target: { module: "knowledge", id: note } };

function dockFixture() {
  let focus: FocusInput = { section: "work", id: task };
  const applied: unknown[] = [], navigated: unknown[] = [];
  const panel = new ElementStub(), text = new ElementStub(); text.value = "Return to the education topic";
  const dock = Object.assign(Object.create(MainDock.prototype), { mode: "auto", panelGeneration: 0, panel, titles: new Map(),
    text, conversation: "conv_00000000000000000000000001", start: async () => {}, setBusy() {},
    notice: new ElementStub(), messages: new ElementStub(), scroller: new ElementStub(),
    host: { focus: () => focus, apply: (action: unknown, at: number) => { applied.push({ action, at }); return "applied"; },
      navigate: (...args: unknown[]) => navigated.push(args), clearHighlights() {} },
  }) as unknown as { act(action: WorkbenchAction, where: ElementStub, origin?: { requestedAt: number; page: FocusInput }): void;
    show(panel: unknown): Promise<void>; closePanel(): void; submit(): Promise<void> };
  return { dock, panel, applied, navigated, focus: () => focus, move: (next: FocusInput) => { focus = next; } };
}

test("chat navigation follows pre-message activity but never later interaction, edits or an inactive tab", () => {
  const idle = { now: 10_100, lastActivity: 10_000, requestedAt: 10_050, editing: false, attentive: true };
  expect(canNavigateNow(idle)).toBe(true);
  expect(canNavigateNow({ ...idle, lastActivity: 10_060 })).toBe(false);
  expect(canNavigateNow({ ...idle, now: 100_000, lastActivity: 10_060 })).toBe(false);
  expect(canNavigateNow({ ...idle, editing: true })).toBe(false);
  expect(canNavigateNow({ ...idle, attentive: false })).toBe(false);
});

test("actual workbench navigation protects dirty editors and propagates the message timestamp", () => {
  const routes: unknown[] = [];
  const view = Object.assign(Object.create(WorkbenchView.prototype), { lastActivity: 100, main: { contains: () => false },
    current: { pane: { dirty: true } }, go: (...args: unknown[]) => routes.push(args),
  }) as unknown as { applyAction(action: WorkbenchAction, at: number): string; current: { pane: { dirty: boolean } }; lastActivity: number };
  expect(view.applyAction(navigation, 110)).toBe("deferred");
  view.current.pane.dirty = false;
  expect(view.applyAction(navigation, 110)).toBe("applied");
  expect(routes).toEqual([["knowledge", note]]);
  view.lastActivity = 120;
  expect(view.applyAction(navigation, 110)).toBe("deferred");
});

test("a streamed display opens its subject and clears the old related panel", async () => {
  const f = dockFixture(); f.panel.append("Old topic cards");
  Object.assign(f.dock, { client: { async *assistantEvents() {
    yield AssistantEvent.parse({ type: "ui", turn: "turn_00000000000000000000000001", tool: "tool_00000000000000000000000001", action: navigation });
  } } });
  await f.dock.submit();
  expect(f.applied).toHaveLength(1);
  expect(f.applied[0]).toMatchObject({ action: navigation, at: expect.any(Number) });
  expect(f.panel.hidden).toBe(true); expect(f.panel.children).toEqual([]);
});

test("a task/section change during the round defers the stale navigation to a clickable action", () => {
  const f = dockFixture(), where = new ElementStub();
  const origin = { requestedAt: 100, page: f.focus() };
  f.move({ section: "work", id: "task_00000000000000000000000002" });
  f.dock.act(navigation, where, origin);
  expect(f.applied).toEqual([]); expect(where.children).toHaveLength(1);
  const button = where.children[0] as ElementStub;
  button.dispatchEvent(new Event("click"));
  expect(f.navigated).toEqual([["knowledge", note]]);
});

test("repeated navigation to the current object is a no-op", () => {
  const f = dockFixture(); f.move({ section: "knowledge", id: note });
  f.dock.act(navigation, new ElementStub(), { requestedAt: 100, page: { section: "work", id: task } });
  expect(f.applied).toEqual([]);
});

test("late related-panel work cannot resurrect a closed or replaced topic", async () => {
  const f = dockFixture(); let finish!: (tasks: unknown[]) => void;
  Object.assign(f.dock, { client: { workTasks: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = f.dock.show({ kind: "dependency_graph", project: { module: "work", id: "prj_00000000000000000000000001" } });
  f.dock.closePanel(); finish([]); await pending;
  expect(f.panel.hidden).toBe(true); expect(f.panel.children).toEqual([]);
  const old = f.dock.show({ kind: "dependency_graph", project: { module: "work", id: "prj_00000000000000000000000001" } });
  await f.dock.show({ kind: "search", title: "New topic", results: [{ title: "Synthetic article", url: "https://example.com/article" }] });
  const current = f.panel.children.slice(); finish([]); await old;
  expect(f.panel.children).toEqual(current); expect(JSON.stringify(current)).toContain("Synthetic article");
});

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WorkTask, WorkTaskDetail } from "@lumio/schema";
import { WorkPane } from "../../src/client/panes/work.ts";
import { WorkEditor } from "../../src/client/panes/work-editor.ts";

const seed = WorkTask.parse(JSON.parse(readFileSync(new URL("../../../../fixtures/work/readiness.json", import.meta.url), "utf8")));
const detail = WorkTaskDetail.parse({ task: { ...seed, id: "task_00000000000000000000000002", title: "Synthetic dependent", dependencies: [seed.id], blocked_by: [] },
  comments: [], executions: [], turns: [], children: [], dependents: [] });
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

function fixture() {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: {} } });
  const editor = { dirty: false, isBusy: false, hasUnsentComment: false, refreshRelatedTasks: async (_canApply: () => boolean) => {} };
  let focused = false, reloads = 0, listLoads = 0;
  const pane = Object.assign(Object.create(WorkPane.prototype), {
    root: { hidden: false }, active: true, selected: detail.task.id, editor, displayed: detail, detailGeneration: 0,
    // A saved title is always populated. It is not an unposted composer draft.
    detailLayout: { contains: () => focused, querySelectorAll: () => [{ value: detail.task.title }], querySelector: () => null },
    split: { classList: { add() {} } }, list: { querySelectorAll: () => [] }, client: { workTask: async () => detail },
    load: async () => { listLoads++; }, open: async () => { reloads++; },
  }) as WorkPane;
  return { pane, editor, focus(value: boolean) { focused = value; }, reloads: () => reloads, listLoads: () => listLoads };
}

test("returning from trash refreshes a clean task despite its populated saved title", () => {
  const f = fixture();
  f.pane.liveRefresh();
  expect(f.listLoads()).toBe(1); expect(f.reloads()).toBe(1);
});

test("live refresh protects unsaved edits, pending actions, focused controls and unposted discussion", () => {
  const f = fixture();
  f.editor.dirty = true; f.pane.liveRefresh(); f.editor.dirty = false;
  f.editor.isBusy = true; f.pane.liveRefresh(); f.editor.isBusy = false;
  f.editor.hasUnsentComment = true; f.pane.liveRefresh(); f.editor.hasUnsentComment = false;
  f.focus(true); f.pane.liveRefresh();
  expect(f.reloads()).toBe(0); expect(f.listLoads()).toBe(4);
  f.focus(false); f.pane.liveRefresh(); expect(f.reloads()).toBe(1);
});

test("unchanged task detail still refreshes related titles, outcomes and subtask progress", async () => {
  const f = fixture(); let relatedLoads = 0;
  f.editor.refreshRelatedTasks = async canApply => { if (canApply()) relatedLoads++; };
  await WorkPane.prototype.open.call(f.pane, detail.task.id, true, true);
  expect(relatedLoads).toBe(1);
});

test("related task refresh follows deleted, restored and cancelled prerequisites without changing the dependent revision", async () => {
  let visible: WorkTask[] = [], props = 0, relations = 0;
  const editor = Object.assign(Object.create(WorkEditor.prototype), { active: true, allTasks: [] as WorkTask[], byId: new Map<string, WorkTask>(),
    client: { workTasks: async () => visible }, renderProps: () => { props++; }, renderRelations: () => { relations++; } });
  visible = [seed]; await editor.refreshRelatedTasks();
  expect(editor.byId.get(seed.id)?.title).toBe(seed.title);
  visible = []; await editor.refreshRelatedTasks(); expect(editor.byId.has(seed.id)).toBe(false);
  visible = [{ ...seed, title: "Synthetic restored prerequisite" }]; await editor.refreshRelatedTasks();
  expect(editor.byId.get(seed.id)?.title).toBe("Synthetic restored prerequisite");
  visible = [WorkTask.parse({ ...seed, outcome: "cancelled", turn: { holder: "nobody", reason: "on_hold", since: seed.updated } })];
  await editor.refreshRelatedTasks(); expect(editor.byId.get(seed.id)?.outcome).toBe("cancelled");
  await editor.refreshRelatedTasks(); expect(props).toBe(4); expect(relations).toBe(4);
  visible = []; await editor.refreshRelatedTasks(() => false); expect(editor.byId.has(seed.id)).toBe(true);
  editor.active = false; await editor.refreshRelatedTasks(); expect(editor.byId.has(seed.id)).toBe(true);
});

test("deleting the selected work item uses the revision after pending edits save", async () => {
  const writer = { base: seed };
  const editor = Object.assign(Object.create(WorkEditor.prototype), {
    active: true, busy: false, writer,
    flush: async () => {
      writer.base = { ...seed, revision: seed.revision + 1 };
      return true;
    },
  }) as WorkEditor;

  expect((await editor.prepareDelete())?.revision).toBe(seed.revision + 1);
});

test("deleting the selected work item stops if its edits could not be saved", async () => {
  const editor = Object.assign(Object.create(WorkEditor.prototype), {
    active: true, busy: false, writer: { base: seed }, flush: async () => false,
  }) as WorkEditor;

  expect(await editor.prepareDelete()).toBeUndefined();
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { GamepadNavigation } from "../../src/client/gamepad-navigation.ts";
import { BUTTONS, DEFAULT_BINDINGS, PadInputState, type PadCommand } from "../../src/client/gamepad-input.ts";
import { nextListItem } from "../../src/client/list-keys.ts";

const ROWS = "[data-pad-row], .row[data-id]";
const ITEMS = ROWS + ', .split.has-detail [data-pad-action="primary"], .split.has-detail [data-pad-action="delegate"], .split.has-detail [data-pad-action="reject"]';
const PRIMARY = '[data-pad-action="primary"]';

// A narrow DOM surface for the real controller dispatcher. Full rendering is
// exercised separately in the synthetic Hub browser run.
class ElementStub extends EventTarget {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  queries = new Map<string, ElementStub[]>();
  children: unknown[] = [];
  parent?: ElementStub;
  className = "";
  isConnected = true;
  disabled = false;
  visible = true;
  isContentEditable = false;
  textContent = "";
  scrolls = 0;
  clicks = 0;
  value = 0;
  bounds = { left: 0, right: 100, top: 0, bottom: 30 };
  get parentElement() { return this.parent; }
  getBoundingClientRect() { return this.bounds; }
  constructor(readonly tagName: string) { super(); }
  getClientRects(): object[] { return this.visible && this.isConnected ? [{}] : []; }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  hasAttribute(key: string): boolean { return this.attributes.has(key); }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  querySelectorAll(selector: string): ElementStub[] { return this.queries.get(selector) ?? []; }
  querySelector(selector: string): ElementStub | undefined { return this.querySelectorAll(selector)[0]; }
  append(...children: unknown[]): void {
    this.children.push(...children);
    for (const child of children) if (child instanceof ElementStub) child.parent = this;
  }
  replaceChildren(): void { this.children = []; }
  close(): void { dialogs = []; doc.activeElement = body; }
  after(child: unknown): void { this.children.push(child); }
  remove(): void {
    this.isConnected = false;
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = undefined;
  }
  focus(): void { doc.activeElement = this; }
  blur(): void { doc.activeElement = body; }
  click(): void { if (!this.disabled) { this.clicks++; this.dispatchEvent(new Event("click")); } }
  scrollIntoView(): void { this.scrolls++; }
  scrollBy(): void { this.scrolls++; }
  contains(item: ElementStub | null): boolean { return item === this || (!!item?.parent && this.contains(item.parent)); }
  closest(selector: string): ElementStub | undefined {
    if (this.matches(selector)) return this;
    return this.parent?.closest(selector);
  }
  matches(selector: string): boolean {
    if (selector === "dialog") return this.tagName === "DIALOG";
    if (selector === "[data-pad-region], .bar, .list-pane, .detail-pane") return !!this.dataset.padRegion;
    if (selector === ":disabled") return this.disabled;
    if (selector === ".is-busy, [inert]") return this.className === "is-busy" || this.hasAttribute("inert");
    if (selector === ROWS) return !!this.dataset.padRow || !!this.dataset.id;
    if (selector === "button, summary, a, .row[data-id]") return ["BUTTON", "SUMMARY", "A"].includes(this.tagName) || !!this.dataset.id;
    return false;
  }
}

let body: ElementStub;
let doc: {
  activeElement: ElementStub | null; body: ElementStub; visibilityState: string;
  hasFocus(): boolean; querySelectorAll(selector: string): ElementStub[];
  querySelector(selector: string): ElementStub | undefined;
  createElement(tag: string): ElementStub;
};
let dialogs: ElementStub[];
let toastButtons: ElementStub[];
let pane: ElementStub;
let row: ElementStub;
let button: ElementStub;
let navigation: GamepadNavigation;
let frameCallbacks: Map<number, FrameRequestCallback>;
let moduleSteps: number[];
let returned: number;
let palette: number;
let restore: () => void;

beforeEach(() => {
  body = new ElementStub("BODY");
  pane = new ElementStub("DIV");
  row = new ElementStub("ARTICLE");
  row.dataset.padRow = "synthetic-card-1";
  row.parent = pane;
  button = new ElementStub("BUTTON");
  button.parent = row;
  pane.queries.set(ITEMS, [row]);
  row.queries.set(PRIMARY, [button]);
  dialogs = [];
  toastButtons = [];
  doc = {
    activeElement: body, body, visibilityState: "visible", hasFocus: () => true,
    querySelectorAll: selector => selector === "dialog[open]" ? dialogs : selector.startsWith(".toast-action") ? toastButtons : [],
    querySelector: () => undefined,
    createElement: tag => new ElementStub(tag.toUpperCase()),
  };
  frameCallbacks = new Map();
  let frameId = 0;
  const descriptors = ["window", "document", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const win = {
    requestAnimationFrame: (callback: FrameRequestCallback) => { frameCallbacks.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frameCallbacks.delete(id); },
  };
  for (const [key, value] of Object.entries({ window: win, document: doc, Node: ElementStub })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  restore = () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  moduleSteps = []; returned = palette = 0;
  navigation = new GamepadNavigation({
    pane: () => pane as unknown as HTMLElement, back: () => { returned++; },
    section: step => { moduleSteps.push(step); }, palette: () => { palette++; },
    backLabel: () => "Back",
    sectionLabel: step => step < 0 ? "Previous" : "Next",
    buttonLabel: command => BUTTONS[DEFAULT_BINDINGS[command]],
    returnFromToast: () => false,
    paletteAction() {}, delegate() {},
  });
});
afterEach(() => { navigation.leave(); restore(); });

const press = (command: PadCommand) =>
  navigation.handle({ command, phase: "press" });

test("D-pad focus scrolls with the row, and A invokes its existing primary button", () => {
  press("down");
  expect(doc.activeElement).toBe(row);
  expect(row.scrolls).toBe(1);
  press("activate");
  expect(button.clicks).toBe(1);
  expect(nextListItem([row, button] as unknown as HTMLElement[], row as unknown as HTMLElement, -1)).toBe(row as unknown as HTMLElement);
});

test("single A cannot approve a protected decision, early release cancels, and a full hold fires once", () => {
  button.setAttribute("data-pad-hold", "");
  press("down");
  const input = new PadInputState();
  const sample = (down: boolean) => ({ index: 0, id: "Synthetic", mapping: "standard" as const, timestamp: 0,
    buttons: [down], axes: [0, 0, 0, 0] });
  const tick = (down: boolean, time: number) => input.update([sample(down)], time, DEFAULT_BINDINGS).forEach(event => navigation.handle(event));
  tick(true, 0);
  expect(button.clicks).toBe(0);
  expect(frameCallbacks.size).toBe(1);
  tick(false, 500);
  expect(frameCallbacks.size).toBe(0);
  tick(true, 501);
  tick(true, 1500);
  expect(button.clicks).toBe(0);
  tick(true, 1501);
  tick(true, 3000);
  expect(button.clicks).toBe(1);
  expect(frameCallbacks.size).toBe(0);
});

test("a protected target replaced, disabled, or moved out of focus during a hold stays untouched", () => {
  for (const invalidate of [
    () => { button.isConnected = false; },
    () => { button.disabled = true; },
    () => { button.visible = false; },
    () => { doc.activeElement = body; },
    () => { row.className = "is-busy"; },
  ]) {
    navigation.leave();
    button.isConnected = button.visible = true;
    button.disabled = false;
    row.className = "";
    button.setAttribute("data-pad-hold", "");
    press("down"); press("activate");
    invalidate();
    navigation.handle({ command: "activate", phase: "hold" });
    expect(button.clicks).toBe(0);
  }
});

test("visibility/device reset cancels a pending approval and removes progress", () => {
  button.setAttribute("data-pad-hold", "");
  press("down"); press("activate");
  navigation.handle({ phase: "reset" });
  navigation.handle({ command: "activate", phase: "hold" });
  expect(button.clicks).toBe(0);
  expect(frameCallbacks.size).toBe(0);
});

test("typing suppresses all commands and scroll, B leaves the field without submitting", () => {
  const input = new ElementStub("TEXTAREA");
  input.parent = row;
  doc.activeElement = input;
  for (const command of ["activate", "next", "previous", "palette", "down"] as const) press(command);
  navigation.handle({ phase: "scroll", x: 10, y: 10 });
  expect(button.clicks).toBe(0);
  expect(moduleSteps).toEqual([]);
  expect(palette).toBe(0);
  expect(doc.activeElement).toBe(input);
  press("back");
  expect(doc.activeElement).toBe(row);
  expect(returned).toBe(0);
  press("activate");
  expect(button.clicks).toBe(1);
});

test("module switching and command menu use the workbench commands", () => {
  press("next"); press("previous"); press("palette"); press("back");
  expect(moduleSteps).toEqual([1, -1]);
  expect(palette).toBe(1);
  expect(returned).toBe(1);
});

test("a silent rerender restores focus by stable identity, never by list position", () => {
  press("down");
  row.isConnected = false;
  doc.activeElement = body;
  const replacement = new ElementStub("ARTICLE");
  replacement.dataset.padRow = row.dataset.padRow!;
  replacement.queries.set(PRIMARY, [button]);
  pane.queries.set(ITEMS, [replacement]);
  press("activate");
  expect(button.clicks).toBe(1);
  replacement.dataset.padRow = "different-decision";
  press("activate");
  expect(button.clicks).toBe(1);
});

function hints(): ElementStub[] {
  const bar = body.children.find(node => node instanceof ElementStub && node.className === "pad-hints") as ElementStub | undefined;
  return (bar?.children ?? []) as ElementStub[];
}

test("controller mode hides on pointer input and restores the last row on new controller activity", () => {
  press("down");
  expect(body.hasAttribute("data-gamepad-mode")).toBe(true);
  expect(row.hasAttribute("data-pad-focus")).toBe(true);
  navigation.leave(true);
  expect(row.hasAttribute("data-pad-focus")).toBe(false);
  expect(body.hasAttribute("data-gamepad-mode")).toBe(false);
  expect(hints()).toHaveLength(0);
  expect(doc.activeElement).toBe(body);
  navigation.handle({ phase: "activity" });
  expect(doc.activeElement).toBe(row);
  expect(row.hasAttribute("data-pad-focus")).toBe(true);
});

test("View clicks the current toast action once, and disappears when there is no action", () => {
  const old = new ElementStub("BUTTON");
  const newest = new ElementStub("BUTTON");
  newest.textContent = "Undo";
  newest.addEventListener("click", () => { toastButtons = []; });
  toastButtons = [old, newest];
  press("down");
  expect(hints().length).toBeLessThanOrEqual(5);
  expect(hints().some(hint => hint.children.includes("Undo"))).toBe(true);
  press("view");
  press("view");
  expect(newest.clicks).toBe(1);
  expect(old.clicks).toBe(0);
  expect(hints().some(hint => hint.children.includes("Undo"))).toBe(false);
});

test("X prefers the current card’s rejection, leaving its primary approval untouched", () => {
  const reject = new ElementStub("BUTTON");
  reject.parent = row;
  reject.textContent = "Refuse";
  row.queries.set('[data-pad-action="reject"]', [reject]);
  press("down");
  expect(hints().some(hint => hint.children.includes("Refuse"))).toBe(true);
  press("delegate");
  expect(reject.clicks).toBe(1);
  expect(button.clicks).toBe(0);
});

test("directional navigation moves within a region, crosses to a neighboring region, and stops at the far edge", () => {
  const left = new ElementStub("SECTION");
  left.dataset.padRegion = "list";
  left.parent = pane;
  row.parent = left;
  const below = new ElementStub("ARTICLE");
  below.dataset.padRow = "second";
  below.bounds = { left: 0, right: 100, top: 40, bottom: 70 };
  below.parent = left;
  const detail = new ElementStub("SECTION");
  detail.dataset.padRegion = "detail";
  detail.parent = pane;
  const next = new ElementStub("ARTICLE");
  next.dataset.padRow = "detail-item";
  next.bounds = { left: 140, right: 240, top: 40, bottom: 70 };
  next.parent = detail;
  pane.queries.set(ITEMS, [row, below, next]);
  press("down");
  expect(doc.activeElement).toBe(row);
  press("down");
  expect(doc.activeElement).toBe(below);
  press("right");
  expect(doc.activeElement).toBe(next);
  press("right");
  expect(doc.activeElement).toBe(next);
  press("left");
  expect(doc.activeElement).toBe(below);
});

test("an open dialog locks navigation and Back restores the previous card", () => {
  press("down");
  const dialog = new ElementStub("DIALOG");
  const close = new ElementStub("BUTTON");
  close.parent = dialog;
  dialog.queries.set("button, summary", [close]);
  dialogs = [dialog];
  close.focus();
  press("down");
  expect(doc.activeElement).toBe(close);
  press("next");
  expect(moduleSteps).toEqual([]);
  press("back");
  expect(doc.activeElement).toBe(row);
  expect(row.hasAttribute("data-pad-focus")).toBe(true);
});

test("when the remembered row disappears, re-entry lands on its nearest list item before acting", () => {
  const before = new ElementStub("ARTICLE");
  before.dataset.padRow = "before";
  before.bounds = { left: 0, right: 100, top: -40, bottom: -10 };
  const after = new ElementStub("ARTICLE");
  after.dataset.padRow = "after";
  after.bounds = { left: 0, right: 100, top: 40, bottom: 70 };
  after.queries.set(PRIMARY, [button]);
  pane.queries.set(ITEMS, [before, row, after]);
  press("down");
  press("down");
  expect(doc.activeElement).toBe(row);
  navigation.leave(true);
  pane.queries.set(ITEMS, [before, after]);
  press("activate");
  expect(doc.activeElement).toBe(after);
  expect(button.clicks).toBe(0);
  press("activate");
  expect(button.clicks).toBe(1);
});

test("a stick held through a pointer takeover waits for new controller activity", () => {
  navigation.handle({ phase: "activity" });
  navigation.leave(true);
  navigation.handle({ phase: "scroll", x: 0, y: 8 });
  expect(body.hasAttribute("data-gamepad-mode")).toBe(false);
  navigation.handle({ phase: "activity" });
  expect(body.hasAttribute("data-gamepad-mode")).toBe(true);
});

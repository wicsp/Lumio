import { afterEach, beforeEach, expect, test } from "bun:test";
import { GamepadNavigation } from "../../src/client/gamepad-navigation.ts";
import { DEFAULT_BINDINGS, PadInputState } from "../../src/client/gamepad-input.ts";
import { nextListItem } from "../../src/client/list-keys.ts";

const ROWS = "[data-pad-row], .row[data-id]";
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
  constructor(readonly tagName: string) { super(); }
  getClientRects(): object[] { return this.visible && this.isConnected ? [{}] : []; }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  hasAttribute(key: string): boolean { return this.attributes.has(key); }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  querySelectorAll(selector: string): ElementStub[] { return this.queries.get(selector) ?? []; }
  querySelector(selector: string): ElementStub | undefined { return this.querySelectorAll(selector)[0]; }
  append(...children: unknown[]): void { this.children.push(...children); }
  after(child: unknown): void { this.children.push(child); }
  remove(): void { this.isConnected = false; }
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
  pane.queries.set(ROWS, [row]);
  row.queries.set(PRIMARY, [button]);
  dialogs = [];
  doc = {
    activeElement: body, body, visibilityState: "visible", hasFocus: () => true,
    querySelectorAll: selector => selector === "dialog[open]" ? dialogs : [],
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
    paletteAction() {}, delegate() {},
  });
});
afterEach(() => { navigation.reset(); restore(); });

const press = (command: "activate" | "back" | "down" | "next" | "previous" | "palette") =>
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
    navigation.reset();
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
  pane.queries.set(ROWS, [replacement]);
  press("activate");
  expect(button.clicks).toBe(1);
  replacement.dataset.padRow = "different-decision";
  press("activate");
  expect(button.clicks).toBe(1);
});

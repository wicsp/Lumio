import { afterEach, beforeEach, expect, test } from "bun:test";
import { confirmDialog, h, openConfirmation } from "../../src/client/dom.ts";

class ElementStub extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly classList = { add() {} };
  readonly dataset = {};
  children: (ElementStub | string)[] = [];
  disabled = false;
  open = false;

  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  append(...children: (ElementStub | string)[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  remove() {}
  focus() { doc.activeElement = this; }
  find(attribute: string): ElementStub | undefined {
    if (this.attributes.has(attribute)) return this;
    for (const child of this.children) {
      if (typeof child === "string") continue;
      const match = child.find(attribute);
      if (match) return match;
    }
  }
  showModal() {
    this.open = true;
    this.find("autofocus")?.focus();
  }
  close() {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  }
  click() {
    if (!this.disabled) this.dispatchEvent(new Event("click"));
  }
}

let doc: { body: ElementStub; activeElement: ElementStub };
let restore: () => void;

beforeEach(() => {
  const body = new ElementStub();
  doc = { body, activeElement: body };
  const values = {
    document: { ...doc, get activeElement() { return doc.activeElement; },
      createElement: () => new ElementStub(), createElementNS: () => new ElementStub() },
    Node: ElementStub,
    MutationObserver: class { disconnect() {} },
  };
  const descriptors = Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  restore = () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
});
afterEach(() => restore());

function keydown(dialog: ElementStub, key: string, options: { repeat?: boolean; isComposing?: boolean } = {}): Event {
  const event = new Event("keydown", { cancelable: true, bubbles: true });
  Object.assign(event, { key, ...options });
  Object.defineProperty(event, "target", { value: doc.activeElement });
  dialog.dispatchEvent(event);
  // A real modal converts an unhandled Escape to a native, cancelable close request.
  if (key === "Escape" && !event.defaultPrevented && dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
  return event;
}

test("the confirmation starts on its primary button and Enter confirms it", async () => {
  const result = confirmDialog({ title: "Delete fixture?", danger: true });
  const dialog = doc.body.children[0] as ElementStub;
  expect(doc.activeElement).toBe(dialog.find("autofocus")!);
  expect(keydown(dialog, "Enter").defaultPrevented).toBe(true);
  expect(await result).toBe(true);
  expect(dialog.open).toBe(false);
});

test("Esc uses native modal cancellation", async () => {
  const result = confirmDialog({ title: "Delete fixture?", danger: true });
  const dialog = doc.body.children[0] as ElementStub;
  keydown(dialog, "Escape");
  expect(await result).toBe(false);
  expect(dialog.open).toBe(false);
});

test("Enter in a textarea or an input keeps the dialog open and retains its default behavior", () => {
  const textarea = h("textarea");
  const input = h("input");
  let calls = 0;
  const dialog = openConfirmation({ title: "Delete fixture?", body: h("div", {}, textarea, input), run: () => calls++ });
  for (const field of [textarea, input]) {
    field.focus();
    expect(keydown(dialog as unknown as ElementStub, "Enter").defaultPrevented).toBe(false);
  }
  expect(calls).toBe(0);
  expect(dialog.open).toBe(true);
});

test("held Enter, IME confirmation and extra Enter presses while pending do not submit", async () => {
  let finish!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  let calls = 0;
  const completed: string[] = [];
  const dialog = openConfirmation({
    title: "Delete fixture?", body: h("div"), danger: true,
    run: () => { calls++; return pending; },
    completed: value => { completed.push(value); },
  }) as unknown as ElementStub;
  keydown(dialog, "Enter", { repeat: true });
  keydown(dialog, "Enter", { isComposing: true });
  expect(calls).toBe(0);
  keydown(dialog, "Enter");
  expect(doc.activeElement.disabled).toBe(true);
  keydown(dialog, "Enter", { repeat: true });
  keydown(dialog, "Enter");
  doc.activeElement.dispatchEvent(new Event("click"));
  expect(calls).toBe(1);
  expect(dialog.open).toBe(true);
  finish("removed");
  await pending;
  expect(dialog.open).toBe(false);
  expect(completed).toEqual(["removed"]);
});

import { expect, mock, test } from "bun:test";
import type { Client } from "../../src/client/api.ts";
import { t } from "../../src/client/i18n.ts";
import { CommandPalette } from "../../src/client/views/palette.ts";

class ElementStub extends EventTarget {
  children: ElementStub[] = [];
  attributes = new Map<string, string>();
  classList = { add() {}, remove() {} };
  open = false;
  value = "";
  textContent = "";

  constructor(readonly tag: string) { super(); }
  get id(): string { return this.getAttribute("id") ?? ""; }
  getAttribute(name: string): string | undefined { return this.attributes.get(name); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  append(child: ElementStub | string): void {
    if (child instanceof ElementStub) this.children.push(child);
    else this.textContent += child;
  }
  replaceChildren(): void { this.children = []; }
  descendants(): ElementStub[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.dispatchEvent(new Event("close")); }
  remove(): void {}
  focus(): void {}
  scrollIntoView(): void {}
}

test("command selection keeps its mouse target and ignores a response for a previous query", async () => {
  const body = new ElementStub("body");
  const globals = { Node: ElementStub, document: {
    body, createElement: (tag: string) => new ElementStub(tag), createElementNS: (_: string, tag: string) => new ElementStub(tag),
  } };
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  const started = Promise.withResolvers<void>();
  const stale = Promise.withResolvers<{ hits: { note: { type: string; title: string; path: string } }[] }>();
  const client = {
    workTasks: async () => [],
    workProjects: async () => [],
    search: mock((query: string) => {
      if (query !== "first note") return Promise.resolve({ hits: [] });
      started.resolve();
      return stale.promise;
    }),
  };
  const navigate = mock(() => {});
  try {
    const palette = new CommandPalette(client as unknown as Client, navigate);
    palette.open();
    await Bun.sleep(0);
    const dialog = body.children[0]!;
    const input = dialog.descendants().find(element => element.getAttribute("role") === "combobox")!;
    const options = () => dialog.descendants().filter(element => element.getAttribute("role") === "option");
    const row = options()[1]!;
    row.dispatchEvent(new Event("pointermove"));
    expect(options()[1]).toBe(row);
    expect(input.getAttribute("aria-activedescendant")).toBe(row.id);
    expect(row.getAttribute("aria-selected")).toBe("true");

    input.value = "first note";
    input.dispatchEvent(new Event("input"));
    await started.promise;
    input.value = t("Personal");
    input.dispatchEvent(new Event("input"));
    stale.resolve({ hits: [{ note: { type: "paper", title: "Stale fixture", path: "stale.md" } }] });
    await Bun.sleep(0);

    expect(options().map(option => option.descendants().map(child => child.textContent))).toEqual([
      expect.arrayContaining([t("Personal"), "8"]),
    ]);
    input.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Enter", isComposing: false }));
    expect(navigate).toHaveBeenCalledWith("personal", undefined, undefined);
    expect(dialog.open).toBe(false);
    palette.dispose();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

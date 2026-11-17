import { expect, test } from "bun:test";
import { ResourceSummary } from "@lumio/schema";
import type { Client } from "../../src/client/api.ts";
import { hydrateResourceCards } from "../../src/client/resource-card.ts";

class ElementStub extends EventTarget {
  className = "";
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  replacement?: ElementStub;

  constructor(readonly tag: string, private children: (ElementStub | string)[] = []) { super(); }

  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  append(...children: (ElementStub | string)[]): void { this.children.push(...children); }
  replaceWith(replacement: ElementStub): void { this.replacement = replacement; }
  get childElementCount(): number { return this.children.filter(child => child instanceof ElementStub).length; }
  get textContent(): string { return this.children.map(child => typeof child === "string" ? child : child.textContent).join(""); }
  set textContent(value: string) { this.children = [value]; }

  querySelector(selector: string): ElementStub | undefined {
    expect(selector).toBe(":scope > a[data-resource]");
    return this.children.find((child): child is ElementStub => child instanceof ElementStub && child.tag === "a" && !!child.dataset.resource);
  }
}

const ulid = "01JA0000000000000000000000";
const task = `task_${ulid}`, note = `pap_${ulid}`, other = `job_${ulid}`;
function link(id: string, label = id): ElementStub {
  const anchor = new ElementStub("a", [label]);
  anchor.dataset.resource = id;
  return anchor;
}

test("standalone assistant references become cards and reuse visibility-checked navigation", async () => {
  const globals = { document: {
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_ns: string, tag: string) => new ElementStub(tag),
  }, Node: ElementStub };
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const bare = new ElementStub("p", [link(task)]);
    const explicit = new ElementStub("p", [link(note, "Paper reference")]);
    const inline = new ElementStub("p", ["See ", link(task)]);
    const unsupported = new ElementStub("p", [link(other)]);
    const multiple = new ElementStub("p", [link(task), link(note)]);
    const root = {
      querySelectorAll(selector: string) {
        expect(selector).toBe("p");
        return [bare, explicit, inline, unsupported, multiple];
      },
    } as unknown as HTMLElement;
    const lookups: string[] = [], navigations: unknown[] = [];
    const client = { async resource(id: string) {
      lookups.push(id);
      return ResourceSummary.parse({ id, status: "visible", title: "Synthetic task" });
    } } as unknown as Client;

    hydrateResourceCards(root, client, (...args) => navigations.push(args));
    await Promise.resolve();
    expect(inline.replacement).toBeUndefined();
    expect(unsupported.replacement).toBeUndefined();
    expect(multiple.replacement).toBeUndefined();
    expect(bare.replacement?.className).toBe("resource-card");
    expect(bare.replacement?.textContent).toContain("Synthetic task");
    expect(explicit.replacement?.textContent).toContain("Paper reference");
    expect(lookups).toEqual([task]);

    const click = new Event("click", { cancelable: true });
    bare.replacement!.dispatchEvent(click);
    await Promise.resolve();
    expect(click.defaultPrevented).toBe(true);
    expect(lookups).toEqual([task, task]);
    expect(navigations).toEqual([["work", task]]);
  } finally {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

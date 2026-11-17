import { afterEach, beforeEach, expect, test } from "bun:test";
import { WorkAttention } from "@lumio/schema";
import { attentionCard, type AttentionContext } from "../../src/client/attention-card.ts";
import { LiveData } from "../../src/client/live-data.ts";
import { setLang } from "../../src/client/i18n.ts";

class ElementStub extends EventTarget {
  children: (ElementStub | string)[] = [];
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  parent?: ElementStub;
  className = "";
  classList = { add() {}, remove() {} };
  style = {};
  innerHTML = "";
  value = "";
  hidden = false;
  disabled = false;
  constructor(readonly tag: string) { super(); }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  hasAttribute(key: string): boolean { return key in this.attrs; }
  toggleAttribute(key: string, on: boolean): void { if (on) this.attrs[key] = ""; else delete this.attrs[key]; }
  append(...children: (ElementStub | string)[]): void {
    for (const child of children) { if (child instanceof ElementStub) child.parent = this; this.children.push(child); }
  }
  replaceChildren(): void { this.children = []; }
  replaceWith(node: ElementStub): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    this.parent.children[index] = node; node.parent = this.parent;
  }
  contains(node: ElementStub): boolean { return node === this || this.children.some(child => child instanceof ElementStub && child.contains(node)); }
  querySelectorAll(): ElementStub[] { return []; }
  querySelector(): undefined { return undefined; }
  focus(): void {}
  remove(): void {}
  // Not connected: the shared toast host must not stay attached to this file's stub body for later test files.
  isConnected = false;
  click(): void { this.dispatchEvent(new Event("click")); }
  find(match: (node: ElementStub) => boolean): ElementStub | undefined {
    if (match(this)) return this;
    for (const child of this.children) if (child instanceof ElementStub) { const found = child.find(match); if (found) return found; }
  }
  get textContent(): string { return this.children.map(child => typeof child === "string" ? child : child.textContent).join(""); }
  set textContent(value: string) { this.children = [value]; }
}

let restore: () => void;
beforeEach(() => {
  const keys = ["document", "Node"];
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const doc = { body: new ElementStub("body"), createElement: (tag: string) => new ElementStub(tag), createElementNS: (_ns: string, tag: string) => new ElementStub(tag) };
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: ElementStub });
  restore = () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  setLang("en", false);
});
afterEach(() => restore());

const suffix = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const task = { id: `task_${suffix}`, revision: 4 };
const longSummary = "Synthetic summary line.\n\n## Details\n\nMore synthetic detail.";
const item = (patch: Record<string, unknown> = {}) => WorkAttention.parse({ task: task.id, job: `job_${suffix}`, title: "Synthetic task",
  kind: "review", round: 2, since: "2026-11-17T00:00:00Z", agent: "codex@fixture", summary: longSummary, ...patch });
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const button = (root: ElementStub, text: string) => root.find(node => node.tag === "button" && node.textContent === text);

function context(extra: Partial<AttentionContext> = {}) {
  const commands: unknown[] = [];
  let changed = 0;
  const ctx = {
    client: { job: async () => ({ status: "succeeded", result: { report: "SYNTHETIC FULL REPORT" } }), workTask: async () => ({ task }),
      workCommand: async (command: unknown) => { commands.push(command); return { kind: "job" }; } },
    hub: {}, navigate() {}, changed: () => { changed++; }, ...extra,
  } as unknown as AttentionContext;
  return { ctx, commands, changed: () => changed };
}

test("Today shows the opening of a long report and expands the full report in place, keeping the actions below it", async () => {
  const expanded = new Set<string>();
  const { ctx } = context({ expanded });
  const card = attentionCard(item(), ctx, "today") as unknown as ElementStub;
  expect(card.find(node => node.innerHTML.includes("Synthetic summary line."))).toBeDefined();
  expect(button(card, "Mark done")).toBeDefined();
  button(card, "Read full report")!.click();
  await settle();
  expect(card.find(node => node.innerHTML.includes("SYNTHETIC FULL REPORT"))).toBeDefined();
  expect(expanded.has(`${task.id}:2`)).toBe(true);
  expect(button(card, "Show less")).toBeDefined();
  // A refresh redraws the card; it stays expanded.
  const again = attentionCard(item(), ctx, "today") as unknown as ElementStub;
  await settle();
  expect(again.find(node => node.innerHTML.includes("SYNTHETIC FULL REPORT"))).toBeDefined();
});

test("a one-paragraph report has no expand control; a checkpoint whose summary is its prompt offers the round's report instead", () => {
  const checkpoint = attentionCard(item({ stage: "merge", prompt: "Synthetic: merge it?", summary: "Synthetic: merge it?" }), context({ expanded: new Set() }).ctx, "today") as unknown as ElementStub;
  expect(checkpoint.find(node => node.className === "attn-summary markdown")).toBeUndefined();
  expect(button(checkpoint, "Read full report")).toBeDefined();
  const card = attentionCard(item({ summary: "Done." }), context({ expanded: new Set() }).ctx, "today") as unknown as ElementStub;
  expect(button(card, "Read full report")).toBeUndefined();
});

test("in task detail the full report is in the card and the decisions are in the docked bar next to the discussion box", async () => {
  const bar = new ElementStub("div");
  const replies: string[] = [];
  const { ctx } = context({ docked: { bar: bar as unknown as HTMLElement, reply: kind => { replies.push(kind); } } });
  const card = attentionCard(item(), ctx, "task") as unknown as ElementStub;
  await settle();
  expect(card.find(node => node.innerHTML.includes("SYNTHETIC FULL REPORT"))).toBeDefined();
  expect(button(card, "Mark done")).toBeUndefined();
  expect(button(bar, "Mark done")).toBeDefined();
  expect(bar.textContent).toContain("Ready for your review");
  button(bar, "Add feedback and continue")!.click();
  expect(replies).toEqual(["review"]);
});

test("a docked failed round retries with the same agent in one click and clears the bar", async () => {
  const bar = new ElementStub("div");
  const { ctx, commands, changed } = context({ docked: { bar: bar as unknown as HTMLElement, reply() {} } });
  attentionCard(item({ kind: "failed", summary: "Synthetic failure" }), ctx, "task");
  button(bar, "Retry")!.click();
  await settle();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ operation: { op: "work.task.dispatch", args: { task: task.id, to: "codex@fixture", expected_revision: 4 } } });
  expect(bar.children).toHaveLength(0);
  expect(changed()).toBe(1);
});

test("a checkpoint shows what was delivered together with the question it asks", () => {
  const card = attentionCard(item({ stage: "merge", prompt: "Synthetic: merge it?", summary: "Synthetic delivery" }), context({ expanded: new Set() }).ctx, "today") as unknown as ElementStub;
  expect(card.find(node => node.innerHTML.includes("Synthetic delivery"))).toBeDefined();
  expect(card.find(node => node.innerHTML.includes("merge it?"))).toBeDefined();
  expect(button(card, "Continue")).toBeDefined();
});

test("live data merges concurrent reads, reuses fresh results and refetches after a change", async () => {
  let reads = 0, now = 1000;
  const client = { workTasks: async () => { reads++; return []; }, jobs: async () => [], proposals: async () => [],
    notices: async () => ({ notices: [] }), jobAttention: async () => [] };
  const live = new LiveData(client as never, { attention: async () => [] }, () => now);
  await Promise.all([live.get(), live.get(), live.get()]);
  expect(reads).toBe(1);
  now += 1500; await live.get(2000); expect(reads).toBe(1);
  await live.get(); expect(reads).toBe(2);
  now += 1;
  const before = live.get();
  live.invalidate();
  await Promise.all([before, live.get()]);
  expect(reads).toBe(4);
});

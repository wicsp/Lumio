import { afterEach, beforeEach, expect, test } from "bun:test";
import { Capture, Glance, KnowledgeOriginal, NoteDetail } from "@lumio/schema";
import { InboxPane } from "../../src/client/panes/inbox.ts";
import { KnowledgePane } from "../../src/client/panes/knowledge.ts";
import { lang, setLang, t } from "../../src/client/i18n.ts";

// 最小 DOM：只够渲染真实的资料页头部与 Inbox 行（C1-5）。
class ElementStub extends EventTarget {
  children: (ElementStub | string)[] = [];
  attrs: Record<string, string> = {};
  className = ""; innerHTML = ""; scrollTop = 0; isConnected = false; hidden = false; title = ""; disabled = false;
  classList = { add() {}, remove() {}, toggle() { return false; } };
  constructor(readonly tag: string) { super(); }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; if (key === "hidden") this.hidden = true; if (key === "title") this.title = value; }
  append(...children: (ElementStub | string)[]): void { this.children.push(...children); }
  replaceChildren(...children: (ElementStub | string)[]): void { this.children = children; }
  remove(): void {}
  querySelectorAll(): ElementStub[] { return []; }
  querySelector(tag: string): ElementStub | undefined { return this.find(node => node.tag === tag); }
  find(match: (node: ElementStub) => boolean): ElementStub | undefined {
    if (match(this)) return this;
    for (const child of this.children) if (child instanceof ElementStub) { const hit = child.find(match); if (hit) return hit; }
  }
  get textContent(): string { return this.children.map(child => typeof child === "string" ? child : child.textContent).join(""); }
  set textContent(value: string) { this.children = [value]; }
}

let restore: () => void;
const originalLang = lang();
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

beforeEach(() => {
  const descriptors = ["document", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const document = { body: new ElementStub("body"), documentElement: { lang: "en" }, createElement: (tag: string) => new ElementStub(tag), createElementNS: (_ns: string, tag: string) => new ElementStub(tag) };
  for (const [key, value] of Object.entries({ document, Node: ElementStub })) Object.defineProperty(globalThis, key, { configurable: true, value });
  restore = () => { for (const [key, d] of descriptors) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); } };
  setLang("en", false);
});
afterEach(() => { restore(); setLang(originalLang, false); });

const glanceId = "gln_01JZ0000000000000000000001";
const original = (glance?: object) => KnowledgeOriginal.parse({
  note: { type: "source", id: "src_01JZ0000000000000000000001", title: "Saved", path: "library/sources/saved.md" }, path: "library/originals/saved.md",
  frontmatter: { of: "src_01JZ0000000000000000000001", captured: "2026-11-16T08:00:00+08:00", extractor: "glance-ocr@1", sha256: "a".repeat(64), ...(glance ? { glance } : {}) },
  body: "## Pointed paragraph\n\nSynthetic",
});

function renderSource(client: object): ElementStub {
  const detail = new ElementStub("section");
  const pane = Object.assign(Object.create(KnowledgePane.prototype), { detail, client, active: true, generation: 0, outline: { refresh() {} }, enableEditing: async () => {} }) as { render(note: NoteDetail, links: undefined): void };
  pane.render(NoteDetail.parse({ note: { type: "source", id: "src_01JZ0000000000000000000001", title: "Saved", path: "library/sources/saved.md" }, frontmatter: { url: "https://example.com/a" }, body: "x" }), undefined);
  return detail;
}

test("a material shows its desktop source without a capture-method sentence", async () => {
  const detail = renderSource({ showOriginal: async () => original({ id: glanceId, app: { name: "Safari" }, window: "Synthetic window", pointing: "point" }) });
  await flush();
  const box = detail.find(node => node.className === "material-glance")!;
  expect(box.hidden).toBe(false);
  expect(box.textContent).toContain(t("Desktop helper"));
  expect(box.textContent).toContain("Safari · Synthetic window");
  expect(box.textContent).not.toContain("Saved the paragraph you pointed at");
});

test("materials without a glance, or without an archived original, show no desktop origin", async () => {
  for (const client of [{ showOriginal: async () => original() }, { showOriginal: async () => { throw new Error("no original"); } }, {}]) {
    const detail = renderSource(client);
    await flush();
    expect(detail.find(node => node.className === "material-glance")!.hidden).toBe(true);
  }
});

test("desktop captures in the Inbox are labelled with the helper, app and site", async () => {
  const glance = Glance.parse({ id: glanceId, owner: "act_00000000000000000000000001", captured: "2026-11-16T08:00:00+08:00", app: { name: "Safari" },
    url: "https://www.example.com/post", trail: [], ocr: [], pointing: { method: "selection", text: "x", blocks: [] }, used_by: {}, created: "2026-11-16T08:00:00+08:00" });
  const capture = Capture.parse({ id: "cap_00000000000000000000000001", owner: "act_00000000000000000000000001", channel: "desktop", glance: glanceId,
    url: "https://example.com/post", kind: "web", state: "ready", card: "none", attempt: 1, revision: 1, created: "2026-11-16T00:00:00Z", updated: "2026-11-16T00:00:00Z" });
  const pane = Object.assign(Object.create(InboxPane.prototype), { client: { glance: async () => glance }, glances: new Map(), active: true, summaryConfigured: true }) as { row(capture: Capture): ElementStub };
  const row = pane.row(capture);
  expect(row.textContent).toContain(t("Desktop helper"));
  await flush();
  expect(row.textContent).toContain("Safari · example.com");
});

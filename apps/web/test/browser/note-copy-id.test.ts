import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { NoteDetail } from "@lumio/schema";
import { KnowledgePane } from "../../src/client/panes/knowledge.ts";
import { lang, setLang, t } from "../../src/client/i18n.ts";

// Small DOM surface for rendering the real note header and activating its button.
class ElementStub extends EventTarget {
  children: (ElementStub | string)[] = [];
  attrs: Record<string, string> = {};
  className = "";
  innerHTML = "";
  scrollTop = 0;
  isConnected = false;
  classList = { add() {} };
  constructor(readonly tag: string) { super(); }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  append(...children: (ElementStub | string)[]): void { this.children.push(...children); }
  replaceChildren(): void { this.children = []; }
  remove(): void {}
  querySelectorAll(): ElementStub[] { return []; }
  querySelector(tag: string): ElementStub | undefined { return this.find(node => node.tag === tag); }
  find(match: (node: ElementStub) => boolean): ElementStub | undefined {
    if (match(this)) return this;
    for (const child of this.children) {
      if (child instanceof ElementStub) { const hit = child.find(match); if (hit) return hit; }
    }
  }
  get textContent(): string { return this.children.map(child => typeof child === "string" ? child : child.textContent).join(""); }
}

let body: ElementStub;
let writeText: ReturnType<typeof spyOn<Clipboard, "writeText">>;
let timer: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>;
let restore: () => void;
const originalLang = lang();
const id = "idea_01JA0000000000000000000000";

beforeEach(() => {
  const descriptors = ["document", "Node", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  body = new ElementStub("body");
  const document = { body, documentElement: { lang: "en" }, createElement: (tag: string) => new ElementStub(tag), createElementNS: (_ns: string, tag: string) => new ElementStub(tag) };
  const clipboard = { writeText: async (_value: string) => {} } as Clipboard;
  for (const [key, value] of Object.entries({ document, Node: ElementStub, navigator: { clipboard } }))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  restore = () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  writeText = spyOn(clipboard, "writeText");
  timer = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
  setLang("en", false);
});
afterEach(() => { writeText.mockRestore(); timer.mockRestore(); restore(); setLang(originalLang, false); });

function render(note: Partial<NoteDetail["note"]> = {}): ElementStub | undefined {
  const detail = new ElementStub("section");
  const pane = Object.assign(Object.create(KnowledgePane.prototype), {
    detail, client: {}, outline: { refresh() {} }, enableEditing: async () => {},
  }) as { render(note: NoteDetail, links: undefined): void };
  pane.render(NoteDetail.parse({
    note: { type: "idea", id, title: "Synthetic note", path: "research/ideas/synthetic.md", ...note },
    frontmatter: {}, body: "Synthetic body",
  }), undefined);
  return detail.find(node => node.attrs["aria-label"] === t("Copy ID"));
}

test("each note type offers an accessible button that copies only its stable ID", async () => {
  for (const [type, prefix] of [["paper", "pap"], ["source", "src"], ["idea", "idea"], ["experiment", "exp"], ["post", "post"], ["asset", "ast"], ["ai-note", "ain"], ["task", "task"], ["project", "prj"], ["routine", "rtn"]] as const) {
    const noteId = `${prefix}_01JA0000000000000000000000`;
    const button = render({ type, id: noteId })!;
    expect(button.tag).toBe("button");
    expect(button.attrs).toMatchObject({ type: "button", title: "Copy ID", "aria-label": "Copy ID" });
    button.dispatchEvent(new Event("click"));
    await Promise.resolve();
    expect(writeText).toHaveBeenLastCalledWith(noteId);
  }
  expect(body.textContent).toContain("ID copied");
});

test("a note without an ID offers no copy action or fabricated path ID", () => {
  expect(render({ id: undefined })).toBeUndefined();
  expect(writeText).not.toHaveBeenCalled();
});

test("success is shown only after the clipboard write completes", async () => {
  let finish!: () => void;
  writeText.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  render()!.dispatchEvent(new Event("click"));
  expect(body.textContent).not.toContain("ID copied");
  finish();
  await Promise.resolve();
  expect(body.textContent).toContain("ID copied");
});

test("denied clipboard writes show a translated error and allow retry", async () => {
  setLang("zh", false);
  writeText.mockRejectedValueOnce(new Error("Denied"));
  const button = render()!;
  expect(button.attrs.title).toBe("复制编号");
  button.dispatchEvent(new Event("click"));
  await Promise.resolve();
  expect(body.textContent).toContain("无法复制编号");
  expect(body.textContent).not.toContain("已复制编号");
  button.dispatchEvent(new Event("click"));
  await Promise.resolve();
  expect(body.textContent).toContain("已复制编号");
});

test("an unavailable clipboard shows an error instead of claiming success", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  render()!.dispatchEvent(new Event("click"));
  await Promise.resolve();
  expect(body.textContent).toContain("Couldn't copy ID");
  expect(body.textContent).not.toContain("ID copied");
});

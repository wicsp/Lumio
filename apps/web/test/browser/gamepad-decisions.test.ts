import { afterEach, beforeEach, expect, test } from "bun:test";
import { Proposal, WorkAttention, type TrashItem } from "@lumio/schema";
import { isWorkProposal, proposalCard, riskyProposal } from "../../src/client/proposal-card.ts";
import { attentionCard, type AttentionContext } from "../../src/client/attention-card.ts";
import { ApprovalsPane } from "../../src/client/panes/approvals.ts";
import { TrashPane } from "../../src/client/panes/trash.ts";
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
  checked = false;
  disabled = false;
  scrollHeight = 40;
  isConnected = true;
  constructor(readonly tag: string) { super(); }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; if (key === "checked") this.checked = true; }
  hasAttribute(key: string): boolean { return key in this.attrs; }
  toggleAttribute(key: string, on: boolean): void { if (on) this.attrs[key] = ""; else delete this.attrs[key]; }
  append(...children: (ElementStub | string)[]): void {
    for (const child of children) { if (child instanceof ElementStub) child.parent = this; this.children.push(child); }
  }
  get lastChild(): ElementStub | string | undefined { return this.children.at(-1); }
  replaceChildren(): void { this.children = []; }
  replaceWith(node: ElementStub): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    this.parent.children[index] = node; node.parent = this.parent;
  }
  contains(node: ElementStub): boolean { return node === this || this.children.some(child => child instanceof ElementStub && child.contains(node)); }
  querySelectorAll(): ElementStub[] { return []; }
  querySelector(): undefined { return undefined; }
  remove(): void {}
  focus(): void {}
  showModal(): void {}
  close(): void {}
  find(match: (node: ElementStub) => boolean): ElementStub | undefined {
    if (match(this)) return this;
    for (const child of this.children) if (child instanceof ElementStub) { const found = child.find(match); if (found) return found; }
  }
  get textContent(): string { return this.children.map(child => typeof child === "string" ? child : child.textContent).join(""); }
  set textContent(value: string) { this.children = [value]; }
}

const suffix = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const taskId = `task_${suffix}`, jobId = `job_${suffix}`, runtimeId = `act_${suffix}`;
const created = "2026-11-11T00:00:00Z";
const base = { id: `prop_${suffix}`, author: runtimeId, reason: "Synthetic request", status: "pending", created };
let body: ElementStub;
let restore: () => void;

beforeEach(() => {
  const keys = ["document", "Node", "MutationObserver", "HTMLInputElement", "requestAnimationFrame"];
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  body = new ElementStub("body");
  const doc = { body, documentElement: { lang: "en" }, createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_ns: string, tag: string) => new ElementStub(tag) };
  const values = { document: doc, Node: ElementStub, MutationObserver: class { observe() {} disconnect() {} },
    HTMLInputElement: ElementStub, requestAnimationFrame: () => 0 };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  restore = () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  setLang("en", false);
});
afterEach(() => restore());

function planProposal(stage: Record<string, unknown>, template = false) {
  return Proposal.parse({ ...base, operation: { op: "work.command", args: { request_id: "synthetic-proposal-0001",
    operation: { op: template ? "work.plan_template.save" : "work.task.plan.set", args: {
      ...(template ? { name: "Synthetic plan" } : { task: taskId, expected_revision: 1 }),
      plan: { stages: [{ kind: "agent", id: "implement", agent: "codex@fixture", instruction: "Synthetic step", ...stage }] },
    } },
  } } });
}

test("both plan and template cards mark full-access and hook approvals for holding, and show the commands", () => {
  for (const template of [false, true]) {
    for (const stage of [{ access: "full" }, { hooks: { before: { argv: ["bun", "run", "check"] } } },
      { hooks: { after: { argv: ["echo", "fixture"] } } }]) {
      const proposal = planProposal(stage, template);
      if (!isWorkProposal(proposal)) throw new Error("Expected a work proposal");
      expect(riskyProposal(proposal)).toBe(true);
      const client = { actors: async () => [], workTask: async () => ({ task: { title: "Fixture" } }) };
      const card = proposalCard(proposal, { client: client as never, navigate() {}, changed() {} }) as unknown as ElementStub;
      const primary = card.find(node => node.attrs["data-pad-action"] === "primary")!;
      expect(primary.hasAttribute("data-pad-hold")).toBe(true);
      if ("hooks" in stage) expect(card.textContent).toContain(stage.hooks?.before ? "bun run check" : "echo fixture");
      else expect(card.textContent).toContain("full access");
    }
  }
});

test("ordinary plan and dispatch approvals keep their normal single-key action", () => {
  const proposal = planProposal({ access: "write" });
  if (!isWorkProposal(proposal)) throw new Error("Expected a work proposal");
  expect(riskyProposal(proposal)).toBe(false);
  const dispatch = Proposal.parse({ ...base, operation: { op: "work.command", args: { request_id: "synthetic-dispatch-0001",
    operation: { op: "work.task.dispatch", args: { task: taskId, to: "codex@fixture", expected_revision: 1 } } } } });
  if (!isWorkProposal(dispatch)) throw new Error("Expected a work proposal");
  expect(riskyProposal(dispatch)).toBe(false);
});

test("privileged approval remains disabled until its run is checked and renders the full argv and identities", async () => {
  const proposal = Proposal.parse({ ...base, operation: { op: "exec.privileged", args: {
    runtime: runtimeId, job: jobId, argv: ["/usr/bin/fixture", "--argument", "value with spaces"],
  } } });
  const detail = new ElementStub("section");
  let resolve!: (value: unknown) => void;
  const pane = Object.assign(Object.create(ApprovalsPane.prototype), {
    active: true, detailGeneration: 0, list: new ElementStub("div"), split: new ElementStub("div"), detail,
    client: { job: () => new Promise(done => { resolve = done; }) },
  }) as { openProposal(proposal: Proposal): void };
  pane.openProposal(proposal);
  const primary = detail.find(node => node.attrs["data-pad-action"] === "primary")!;
  expect(primary.hasAttribute("data-pad-hold")).toBe(true);
  expect(primary.disabled).toBe(true);
  for (const text of ['"/usr/bin/fixture"', '"--argument"', '"value with spaces"', jobId, runtimeId, base.reason]) {
    expect(detail.textContent).toContain(text);
  }
  resolve({ spec: { runtime: runtimeId, workdir: "/synthetic" }, status: "running" });
  await Promise.resolve(); await Promise.resolve();
  expect(primary.disabled).toBe(false);
});

test("the permanent-delete confirmation uses the same hold guard as privileged approvals", () => {
  const pane = Object.create(TrashPane.prototype) as { confirmPurge(item: TrashItem): void };
  pane.confirmPurge({ id: taskId, title: "Synthetic deleted task", kind: "task" } as TrashItem);
  const primary = body.find(node => node.hasAttribute("data-pad-hold"));
  expect(primary?.textContent).toBe("Delete permanently");
  expect(body.textContent).toContain("This can't be undone.");
});

test("full permission grants require holding, and deselecting full removes that requirement", async () => {
  const item = WorkAttention.parse({ task: taskId, job: jobId, title: "Synthetic permission request", kind: "question",
    round: 1, since: created, agent: "codex@fixture", question: "Need more access" });
  const ctx = { client: { job: async () => ({ status: "waiting_for_human", result: { permission: { access: "full", git: true }, report: "Synthetic reason" } }) },
    hub: {}, navigate() {}, changed() {} } as unknown as AttentionContext;
  const card = attentionCard(item, ctx) as unknown as ElementStub;
  await Promise.resolve(); await Promise.resolve();
  const primary = card.find(node => node.textContent === "Approve and continue" && node.tag === "button")!;
  expect(primary.hasAttribute("data-pad-hold")).toBe(true);
  expect(card.find(node => node.attrs["data-pad-action"] === "reject")?.textContent).toBe("Refuse…");
  const full = card.find(node => node.attrs.name === "grant-full")!;
  full.checked = false;
  // h() uses the actual checked attribute in a browser.
  card.find(node => node.attrs.name === "grant-git")!.checked = true;
  full.dispatchEvent(new Event("change"));
  expect(primary.hasAttribute("data-pad-hold")).toBe(false);
});

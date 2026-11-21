import { afterEach, beforeEach, expect, test } from "bun:test";
import { Actor, JOB_PROTOCOL_VERSION, Job, Proposal, WorkAttention, WorkProject, WorkTaskDetail, type TrashItem } from "@lumio/schema";
import { isWorkProposal, proposalCard, riskyProposal } from "../../src/client/proposal-card.ts";
import { attentionCard, type AttentionContext } from "../../src/client/attention-card.ts";
import { ApprovalsPane } from "../../src/client/panes/approvals.ts";
import { TrashPane } from "../../src/client/panes/trash.ts";
import { setLang } from "../../src/client/i18n.ts";
import delegation from "../fixtures/pending-delegation.json";

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
const taskId = `task_${suffix}`, jobId = `job_${suffix}`, runtimeId = `act_${suffix}`, projectId = `prj_${suffix}`;
const created = "2026-11-11T00:00:00Z";
const project = WorkProject.parse({ schema_version: 2, type: "project", id: projectId, title: "Fixture project",
  description: "", revision: 1, status: "active", created, updated: created, created_by: runtimeId, updated_by: runtimeId, tags: [] });
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

test("the approvals list shows four fields for pending delegations and keeps historical rows compact", async () => {
  const proposal = Proposal.parse(delegation.proposal);
  const detail = WorkTaskDetail.parse(delegation.taskDetail);
  const list = new ElementStub("div");
  const client = {
    proposals: async (status: Proposal["status"]) => [Proposal.parse({ ...proposal, status })],
    actors: async () => [{ id: proposal.author, name: delegation.authorName }],
    workTask: async () => detail,
  };
  const pane = Object.assign(Object.create(ApprovalsPane.prototype), {
    active: true, generation: 0, list, client, status: "pending",
  }) as { status: Proposal["status"]; load(): Promise<void> };

  await pane.load();
  await Bun.sleep(0);
  const summary = list.find(node => node.className === "dispatch-summary");
  expect(summary?.children.map(child => typeof child === "string" ? child : child.textContent)).toEqual([
    "Proposed by", delegation.authorName,
    "Task title", detail.task.title,
    "Task description", detail.task.description,
    "Assigned to", delegation.proposal.operation.args.operation.args.to,
  ]);

  for (const status of ["accepted", "rejected", "withdrawn"] as const) {
    pane.status = status;
    await pane.load();
    expect(list.find(node => node.className === "dispatch-summary")).toBeUndefined();
    expect(list.find(node => node.className === "row-sub")?.textContent).toBe(proposal.reason);
  }
});

test("the pending approval card retains the proposer, stored target and decisions when the task lookup fails", async () => {
  const proposal = Proposal.parse(delegation.proposal);
  if (!isWorkProposal(proposal)) throw new Error("Expected a work proposal");
  const client = { actors: async () => [], workTask: async () => { throw new Error("Fixture task unavailable"); } };
  const card = proposalCard(proposal, { client: client as never, navigate() {}, changed() {} }, "approvals") as unknown as ElementStub;
  await Promise.resolve(); await Promise.resolve();
  const summary = card.find(node => node.className === "dispatch-summary");
  expect(summary?.children.map(child => typeof child === "string" ? child : child.textContent)).toEqual([
    "Proposed by", `Unknown object ${proposal.author}`,
    "Task title", `Unknown object ${delegation.taskDetail.task.id}`,
    "Task description", "Task description unavailable.",
    "Assigned to", delegation.proposal.operation.args.operation.args.to,
    "Project", "—",
  ]);
  expect(card.textContent).toContain(delegation.proposal.operation.args.operation.args.comment);
  expect(card.textContent).toContain("目标执行器目前离线。");
  expect(card.find(node => node.attrs["data-pad-action"] === "primary")?.textContent).toBe("Approve");
  expect(card.find(node => node.attrs["data-pad-action"] === "reject")?.textContent).toBe("Reject");
});

test("privileged approval remains disabled until its run is checked and renders the full argv and identities", async () => {
  const proposal = Proposal.parse({ ...base, operation: { op: "exec.privileged", args: {
    runtime: runtimeId, job: jobId, argv: ["/usr/bin/fixture", "--argument", "value with spaces"],
  } } });
  const detail = new ElementStub("section");
  let resolve!: (value: Job) => void;
  const navigations: [string, string | undefined][] = [];
  const pane = Object.assign(Object.create(ApprovalsPane.prototype), {
    active: true, detailGeneration: 0, list: new ElementStub("div"), split: new ElementStub("div"), detail,
    navigate: (section: string, id?: string) => { navigations.push([section, id]); },
    client: {
      runtimes: async () => [{ actor: runtimeId, registration: { name: "fixture" } }],
      actors: async () => [Actor.parse({ id: runtimeId, name: "fixture-runtime-actor", role: "runtime", created })],
      job: () => new Promise(done => { resolve = done; }),
      workTask: async () => WorkTaskDetail.parse(delegation.taskDetail),
      workProject: async (id: string) => {
        expect(id).toBe(project.id);
        return project;
      },
    },
  }) as { openProposal(proposal: Proposal): void };
  pane.openProposal(proposal);
  const primary = detail.find(node => node.attrs["data-pad-action"] === "primary")!;
  expect(primary.hasAttribute("data-pad-hold")).toBe(true);
  expect(primary.disabled).toBe(true);
  for (const text of ['"/usr/bin/fixture"', '"--argument"', '"value with spaces"', jobId, runtimeId, base.reason]) {
    expect(detail.textContent).toContain(text);
  }
  resolve(Job.parse({ project: project.id, spec: {
    id: jobId, runtime: runtimeId, protocol_version: JOB_PROTOCOL_VERSION, lease: "synthetic-lease-0001", timeout_seconds: 3600,
    workdir: "/synthetic", created, run: { kind: "agent", engine: "codex", prompt: "Fixture" }, source: { task: taskId, round: 2 },
  }, status: "running" }));
  await Bun.sleep(0);
  expect(primary.disabled).toBe(false);
  expect(detail.textContent).toContain("codex@fixture");
  expect(detail.textContent).toContain("Round 2");
  expect(detail.textContent).toContain(project.title);
  expect(detail.textContent).not.toContain(jobId);
  expect(detail.textContent).not.toContain(runtimeId);
  expect(detail.find(node => node.attrs.title === jobId)).toBeDefined();
  expect(detail.find(node => node.attrs.title === runtimeId)).toBeDefined();
  const time = detail.find(node => node.tag === "time");
  expect(time?.attrs.datetime).toBe(created);
  expect(time?.textContent).not.toBe(created);
  const taskLink = detail.find(node => node.tag === "button" && node.attrs.title === taskId);
  expect(taskLink?.textContent).toBe(delegation.taskDetail.task.title);
  taskLink?.dispatchEvent(new Event("click"));
  expect(navigations).toEqual([["work", taskId]]);
});

test("approvals show a human submitter, project and task destination, and keep template history readable", async () => {
  const client = {
    actors: async () => [Actor.parse({ id: runtimeId, name: "reviewer", role: "human", created })],
    workTask: async () => WorkTaskDetail.parse({ ...delegation.taskDetail, task: { ...delegation.taskDetail.task, project: project.id } }),
    workProject: async () => project,
  };
  const navigations: [string, string | undefined][] = [];
  const ctx = { client: client as never, navigate: (section: string, id?: string) => { navigations.push([section, id]); }, changed() {} };
  const dispatch = Proposal.parse(delegation.proposal);
  const handoff = planProposal({ access: "write" });
  const template = Proposal.parse({ ...planProposal({ access: "write" }, true), status: "accepted", decided: created });
  const cards = [dispatch, handoff, template].map(proposal => {
    if (!isWorkProposal(proposal)) throw new Error("Expected a work proposal");
    return proposalCard(proposal, ctx, "approvals") as unknown as ElementStub;
  });
  await Bun.sleep(0);
  const [dispatchCard, handoffCard, templateCard] = cards;
  for (const card of [dispatchCard!, handoffCard!]) {
    expect(card.textContent).toContain("reviewer (person)");
    expect(card.textContent).toContain(project.title);
    const link = card.find(node => node.attrs["data-pad-action"] === "detail");
    expect(link?.textContent).toContain(delegation.taskDetail.task.title);
    link?.dispatchEvent(new Event("click"));
  }
  expect(navigations).toEqual([["work", taskId], ["work", taskId]]);
  expect(dispatchCard?.textContent).toContain(delegation.proposal.operation.args.operation.args.to);
  expect(templateCard?.textContent).toContain("reviewer (person) proposes saving a plan template “Synthetic plan”");
  expect(templateCard?.find(node => node.attrs["data-pad-action"] === "detail")).toBeUndefined();
  expect(templateCard?.find(node => node.attrs["data-pad-action"] === "primary")).toBeUndefined();
  expect(templateCard?.textContent).toContain("Decided");
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

import { test, expect } from "bun:test";
import {
  AssistantChatRequest, AssistantEvent, AssistantMain, CAPABILITIES, CONTRACTS, DECISION_GATE_DEFAULTS, DecisionGateBinding, DecisionGateBindingUpdate,
  Exploration, ExplorationCommand, FOCUS_LIMITS, FocusSnapshot, Id, Notice, NoticeCommand, NoticeList, WORKBENCH_LIMITS, WORKBENCH_TOOLS, WorkbenchAction,
} from "../src/index.ts";

const ulid = "0".repeat(26);
const now = "2026-11-11T18:00:00+08:00";
const request_id = "workbench-request-0001";
const task = { module: "work", id: `task_${ulid}`, label: "XX 优化" } as const;
const note = { module: "knowledge", id: `idea_${ulid}` } as const;
const project = { module: "work", id: `prj_${ulid}` } as const;

test("notices and explorations have their own id prefixes", () => {
  expect(Id.safeParse(`ntc_${ulid}`).success).toBe(true);
  expect(Id.safeParse(`xpl_${ulid}`).success).toBe(true);
});

test("main conversation ensure result", () => {
  expect(AssistantMain.safeParse({ conversation: `conv_${ulid}`, created: true }).success).toBe(true);
  expect(AssistantMain.safeParse({ conversation: `conv_${ulid}` }).success).toBe(false);
});

test("focus snapshot limits selection by graphemes and total size by bytes", () => {
  expect(FocusSnapshot.safeParse({ section: "work", primary: task, selected: [note], selection_text: "只跑两个模型" }).success).toBe(true);
  expect(FocusSnapshot.parse({}).selected).toEqual([]);
  const family = "👨‍👩‍👧‍👦"; // one grapheme, many code units
  expect(FocusSnapshot.safeParse({ selection_text: family.repeat(FOCUS_LIMITS.max_selection_graphemes) }).success).toBe(false); // too many bytes
  expect(FocusSnapshot.safeParse({ selection_text: "字".repeat(FOCUS_LIMITS.max_selection_graphemes) }).success).toBe(true);
  expect(FocusSnapshot.safeParse({ selection_text: "字".repeat(FOCUS_LIMITS.max_selection_graphemes + 1) }).success).toBe(false);
  expect(FocusSnapshot.safeParse({ selected: Array.from({ length: FOCUS_LIMITS.max_selected + 1 }, () => task) }).success).toBe(false);
  expect(FocusSnapshot.safeParse({ section: "settings" }).success).toBe(false);
  expect(FocusSnapshot.safeParse({ page_html: "<div>" }).success).toBe(false);
});

test("chat request accepts focus; unknown fields still rejected", () => {
  expect(AssistantChatRequest.safeParse({ request_id, message: "这个怎么做", focus: { section: "work", primary: task } }).success).toBe(true);
  expect(AssistantChatRequest.safeParse({ request_id, message: "x", focus: { section: "trash" } }).success).toBe(false);
});

test("workbench actions carry sections and ids, not content", () => {
  expect(WorkbenchAction.safeParse({ action: "navigate", section: "work", target: task }).success).toBe(true);
  expect(WorkbenchAction.safeParse({ action: "navigate", section: "settings" }).success).toBe(false);
  expect(WorkbenchAction.safeParse({ action: "navigate", route: "#settings/ai" }).success).toBe(false);
  expect(WorkbenchAction.safeParse({ action: "highlight", refs: [task, note], note: "先做这个" }).success).toBe(true);
  expect(WorkbenchAction.safeParse({ action: "highlight", refs: [] }).success).toBe(false);
  expect(WorkbenchAction.safeParse({ action: "highlight", refs: Array.from({ length: WORKBENCH_LIMITS.max_refs + 1 }, () => task) }).success).toBe(false);
  expect(WorkbenchAction.safeParse({ action: "show", panel: { kind: "refs", refs: [note] } }).success).toBe(true);
  expect(WorkbenchAction.safeParse({ action: "show", panel: { kind: "search", results: [{ title: "Paper", url: "https://arxiv.org/abs/2401.00001" }] } }).success).toBe(true);
  expect(WorkbenchAction.safeParse({ action: "show", panel: { kind: "search", results: [{ title: "x", url: "javascript:alert(1)" }] } }).success).toBe(false);
  expect(WorkbenchAction.safeParse({ action: "show", panel: { kind: "dependency_graph", project } }).success).toBe(true);
  expect(WorkbenchAction.safeParse({ action: "show", panel: { kind: "dependency_graph", project: task } }).success).toBe(false);
  expect(WorkbenchAction.safeParse({ action: "show", panel: { kind: "html", body: "<b>x</b>" } }).success).toBe(false);
  expect(WorkbenchAction.safeParse({ action: "clear" }).success).toBe(true);
});

test("workbench tools are not in the external capability catalog", () => {
  const names = new Set(CAPABILITIES.map((capability: { name: string }) => capability.name));
  for (const tool of WORKBENCH_TOOLS) expect(names.has(tool)).toBe(false);
});

const notice = {
  id: `ntc_${ulid}`, owner: `act_${ulid}`, source: "turn", event: `turn:task_${ulid}:1:review`, level: "important",
  graded: { by: "rule" }, subject: task, title: "XX 优化", summary: "三项中两项对齐", comment: `wmsg_${ulid}`, created: now,
};

test("notices record level and who graded them", () => {
  expect(Notice.safeParse(notice).success).toBe(true);
  expect(Notice.safeParse({ ...notice, level: "digest", graded: { by: "gate", model: "jev-1.14.0", confidence: 0.91 } }).success).toBe(true);
  expect(Notice.safeParse({ ...notice, level: "digest", graded: { by: "fallback", reason: "timeout" } }).success).toBe(true);
  expect(Notice.safeParse({ ...notice, graded: { by: "gate", model: "jev-1.14.0", confidence: 1.2 } }).success).toBe(false);
  expect(Notice.safeParse({ ...notice, level: "urgent" }).success).toBe(false);
  expect(Notice.safeParse({ ...notice, read: now }).success).toBe(true);
});

test("only watchdog notices carry findings", () => {
  const findings = [{ kind: "stalled_turn", subject: { module: "execution", id: `job_${ulid}` }, since: now }];
  expect(Notice.safeParse({ ...notice, source: "watchdog", findings }).success).toBe(true);
  expect(Notice.safeParse({ ...notice, source: "watchdog" }).success).toBe(false);
  expect(Notice.safeParse({ ...notice, findings }).success).toBe(false);
});

test("notice list and read command", () => {
  expect(NoticeList.safeParse({ notices: [notice], unread: 1 }).success).toBe(true);
  expect(NoticeCommand.safeParse({ request_id, op: "read", notices: [`ntc_${ulid}`] }).success).toBe(true);
  expect(NoticeCommand.safeParse({ request_id, op: "read", notices: [] }).success).toBe(false);
  expect(NoticeCommand.safeParse({ request_id, op: "delete", notices: [`ntc_${ulid}`] }).success).toBe(false);
});

test("assistant stream carries ui, topic and notice events", () => {
  const turn = `turn_${ulid}`;
  expect(AssistantEvent.safeParse({ type: "ui", turn, tool: `tool_${ulid}`, action: { action: "clear" } }).success).toBe(true);
  expect(AssistantEvent.safeParse({ type: "topic", turn, anchors: [task, note] }).success).toBe(true);
  expect(AssistantEvent.safeParse({ type: "topic", turn, anchors: [] }).success).toBe(false);
  expect(AssistantEvent.safeParse({ type: "notice", turn, notice }).success).toBe(true);
});

const exploration = {
  id: `xpl_${ulid}`, owner: `act_${ulid}`, target: note, state: "found", budget: { max_tokens: 200000, max_ms: 1800000 },
  used: { tokens: 120000, ms: 600000 }, ai_note: `ain_${ulid}`, notice: `ntc_${ulid}`, revision: 3, created: now, updated: now,
};

test("explorations only target ideas, tasks and projects", () => {
  expect(Exploration.safeParse(exploration).success).toBe(true);
  expect(Exploration.safeParse({ ...exploration, target: task }).success).toBe(true);
  expect(Exploration.safeParse({ ...exploration, target: { module: "knowledge", id: `src_${ulid}` } }).success).toBe(false);
  expect(Exploration.safeParse({ ...exploration, state: "approved" }).success).toBe(false);
  expect(ExplorationCommand.safeParse({ op: "start", request_id, target: note }).success).toBe(true);
  expect(ExplorationCommand.safeParse({ op: "start", request_id, target: note, budget: { max_tokens: 50000 } }).success).toBe(true);
  expect(ExplorationCommand.safeParse({ op: "cancel", request_id, exploration: `xpl_${ulid}`, expected_revision: 3 }).success).toBe(true);
  expect(ExplorationCommand.safeParse({ op: "cancel", request_id, exploration: `xpl_${ulid}` }).success).toBe(false);
});

test("decision gate binds a pinned Jev model to a connection", () => {
  expect(DECISION_GATE_DEFAULTS.model).toBe("jev-1.14.0");
  expect(DecisionGateBinding.safeParse({ purpose: "decision.gate", connection: `aic_${ulid}`, model: "jev-1.14.0", revision: 1 }).success).toBe(true);
  expect(DecisionGateBinding.safeParse({ purpose: "decision.gate", connection: `aic_${ulid}`, model: "jev-latest", revision: 1 }).success).toBe(false);
  expect(DecisionGateBinding.safeParse({ purpose: "decision.gate", connection: `aip_${ulid}`, model: "jev-1.14.0", revision: 1 }).success).toBe(false);
  expect(DecisionGateBindingUpdate.safeParse({ request_id, connection: null }).success).toBe(true);
  expect(DecisionGateBindingUpdate.safeParse({ request_id, connection: `aic_${ulid}`, model: "jev-1.14.0", expected_revision: 1 }).success).toBe(true);
});

test("new contracts are registered for JSON Schema export", () => {
  for (const name of ["focus-snapshot", "workbench-action", "notice", "notice-list", "exploration", "exploration-command", "decision-gate-binding", "assistant-main"])
    expect(name in CONTRACTS).toBe(true);
});

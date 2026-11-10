/**
 * 交接计划（ADR 0032 第 5 节、ADR 0049）：命令、进度显示与编辑器。
 * 计划只回答「一轮交付之后交给谁」：agent 阶段（可打回到某个 agent 阶段）与检查点（轮到你决定）。
 * ADR 0049：同一行的阶段并行，下一行在上一行全部交付后开始；agent 阶段可声明权限与前后钩子；含检查点的计划可走完自动完成。
 * 编辑器只做「一行一行」的列表，不做连线画布；无法按行表示的计划保留各自的 after，只编辑内容。
 * 设置计划不会开始委派；第一轮仍由你点「委派」。
 */
import {
  DEFAULT_HOOK_TIMEOUT_MINUTES, DEFAULT_PLAN_MAX_ROUNDS, HandoffPlan, planPredecessors,
  type PlanHook, type PlanRun, type PlanStage, type PlanTemplate, type StageAccess, type WorkCommandRequest, type WorkTask,
} from "@lumio/schema";
import { errorText, isConflict, type Client } from "./api.ts";
import { engineTargets, newRequestId } from "./commands.ts";
import { autosize, clear, failure, field, h, icon, openDialog, select, toast } from "./dom.ts";
import { drafts } from "./drafts.ts";
import { t } from "./i18n.ts";

type Task = Pick<WorkTask, "id" | "revision">;
export type CheckpointAction = "continue" | "send_back" | "finish" | "hold";

export function planSetCommand(task: Task, plan: HandoffPlan | null, from?: string, requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.task.plan.set", args: { task: task.id, expected_revision: task.revision, plan, ...(from ? { from } : {}) } } };
}
export function checkpointCommand(task: string, stage: string, action: CheckpointAction, options: { backTo?: string; comment?: string } = {}, requestId = newRequestId()): WorkCommandRequest {
  const comment = options.comment?.trim();
  return { request_id: requestId, operation: { op: "work.task.checkpoint", args: {
    task, stage, action, ...(action === "send_back" && options.backTo ? { back_to: options.backTo } : {}), ...(comment ? { comment } : {}) } } };
}
export function templateSaveCommand(name: string, plan: HandoffPlan, template?: string, requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.plan_template.save", args: { ...(template ? { template } : {}), name: name.trim(), plan } } };
}
export function templateDeleteCommand(template: string, requestId = newRequestId()): WorkCommandRequest {
  return { request_id: requestId, operation: { op: "work.plan_template.delete", args: { template } } };
}

/** 可以打回到的阶段：计划里所有 agent 阶段。 */
export const agentStages = (plan: HandoffPlan) => plan.stages.filter((stage): stage is Extract<PlanStage, { kind: "agent" }> => stage.kind === "agent");

/** 阶段的简短名称：agent 阶段写交给谁，检查点写提示。 */
export function stageLabel(stage: PlanStage | undefined, id?: string): string {
  if (!stage) return id === "end" ? t("Plan finished") : id ?? "";
  return stage.kind === "agent" ? t("{0} · {1}", stage.id, stage.agent) : t("Checkpoint: {0}", stage.prompt);
}


// ───────────── 纯函数：行、权限、钩子、进度（可单独测试） ─────────────

type Edge = { id: string; after?: readonly string[] | undefined };

/**
 * 把计划按「行」分组：同一行的阶段有相同的前驱并行执行，下一行的前驱正好是上一行全部阶段。
 * 不能这样表示时返回 undefined（编辑器保留各阶段原来的 after）。
 */
export function planRows(stages: readonly Edge[]): string[][] | undefined {
  const preds = planPredecessors(stages), rows: string[][] = [];
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(value => b.includes(value));
  for (const stage of stages) {
    const mine = preds.get(stage.id) ?? [];
    const last = rows.at(-1);
    if (!last) { if (mine.length) return undefined; rows.push([stage.id]); continue; }
    if (same(mine, last)) rows.push([stage.id]);
    else if (same(mine, preds.get(last[0]!) ?? [])) last.push(stage.id);
    else return undefined;
  }
  return rows;
}

/** 由行生成 after：全是单行时不写 after（与 ADR 0049 之前的线性计划完全相同）。 */
export function rowsAfter(rows: readonly (readonly string[])[]): Map<string, string[]> | undefined {
  if (rows.every(row => row.length === 1)) return undefined;
  return new Map(rows.flatMap((row, index) => row.map(id => [id, index ? [...rows[index - 1]!] : []] as [string, string[]])));
}

/** 把一行命令拆成 argv：空白分隔，支持单引号、双引号与反斜杠转义；不经过 shell。 */
export function parseArgv(text: string): string[] | undefined {
  const argv: string[] = [];
  let current = "", quote: '"' | "'" | undefined, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === "\\" && i + 1 < text.length) { current += text[++i]; started = true; }
    else if (/\s/.test(c)) { if (started || current) argv.push(current); current = ""; started = false; }
    else { current += c; started = true; }
  }
  if (quote) return undefined;
  if (started || current) argv.push(current);
  return argv.filter(value => value.length);
}
export function formatArgv(argv: readonly string[]): string {
  return argv.map(value => /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, "\\$1")}"`).join(" ");
}

/** 阶段权限的一句话说明，用于进度、提议卡片与批准页。 */
export function permissionSummary(stage: PlanStage): string {
  if (stage.kind !== "agent") return "";
  const access = stage.access ?? "write";
  const parts = [access === "read" ? t("read only") : access === "full" ? t("full access, no sandbox") : t("edits working directory")];
  if (stage.git) parts.push(t("Git writes"));
  if (stage.secrets?.length) parts.push(t("secrets: {0}", stage.secrets.join(", ")));
  return parts.join(t(", "));
}
export const hookText = (hook: PlanHook | undefined) => hook ? formatArgv(hook.argv) + (hook.timeout_minutes ? t(" (up to {0} min)", hook.timeout_minutes) : "") : "";

/** 已交付的阶段：run.done，旧数据按 stage 之前的线性前缀推算（ADR 0049 修订记录）。 */
export function doneStages(run: PlanRun): Set<string> {
  if (run.done) return new Set(run.done);
  const index = run.stage === "end" ? run.plan.stages.length : run.plan.stages.findIndex(stage => stage.id === run.stage);
  return new Set(run.plan.stages.slice(0, index < 0 ? 0 : index).map(stage => stage.id));
}
export type StageState = "done" | "current" | "next";
export function stageStates(run: PlanRun): Map<string, StageState> {
  const done = doneStages(run), active = new Set(run.active ?? (run.stage === "end" ? [] : [run.stage]));
  return new Map(run.plan.stages.map(stage => [stage.id, done.has(stage.id) ? "done" : active.has(stage.id) ? "current" : "next"]));
}

/** 内置角色：只预填说明与权限，不是契约（ADR 0049 第 6 节）。 */
export type Role = "implement" | "review" | "deploy" | "merge" | "trial";
export const ROLES: Role[] = ["implement", "review", "deploy", "merge", "trial"];
export const roleLabel = (role: Role) => ({
  implement: t("Implement"), review: t("Code review"), deploy: t("Deploy for trial"), merge: t("Merge"), trial: t("Trial checkpoint"),
})[role];

/** 编辑中的一步。字符串字段直接对应输入框。 */
export interface DraftStage {
  kind: "agent" | "checkpoint"; id: string; agent: string; instruction: string; back_to: string; prompt: string;
  access: StageAccess; git: boolean; secrets: string; before: string; after_hook: string;
  before_timeout?: number; after_timeout?: number;
  /** 无法按行表示时保留原来的 after。 */
  after?: string[];
}
const blank = (kind: DraftStage["kind"], id: string): DraftStage => ({ kind, id, agent: "", instruction: "", back_to: "", prompt: "", access: "write", git: false, secrets: "", before: "", after_hook: "" });

export function roleDraft(role: Role, id: string, agent: string, backTo = ""): DraftStage {
  if (role === "trial") return { ...blank("checkpoint", id), prompt: t("Trial passed? Continue to merge.") };
  const stage = { ...blank("agent", id), agent };
  if (role === "implement") return { ...stage, git: true, instruction: t("Implement the task description in a new branch from the latest main, run the project's checks, push and open a PR. Report the PR link.") };
  if (role === "review") return { ...stage, access: "read", back_to: backTo, instruction: t("Review the PR from the previous step. If changes are needed, explain them and send the work back.") };
  if (role === "deploy") return { ...stage, access: "full", instruction: t("Deploy this PR for a local trial following the repository's deployment docs. Report what to try.") };
  return { ...stage, git: true, before: "gh pr checks --watch", instruction: t("Merge the PR after its checks pass, then update the local instance from main as the repository describes.") };
}

export function toDraft(stage: PlanStage, keepAfter = false): DraftStage {
  const after = keepAfter && stage.after ? { after: [...stage.after] } : {};
  if (stage.kind === "checkpoint") return { ...blank("checkpoint", stage.id), prompt: stage.prompt, ...after };
  return { ...blank("agent", stage.id), agent: stage.agent, instruction: stage.instruction, back_to: stage.back_to ?? "",
    access: stage.access ?? "write", git: stage.git ?? false, secrets: (stage.secrets ?? []).join(", "),
    before: stage.hooks?.before ? formatArgv(stage.hooks.before.argv) : "", after_hook: stage.hooks?.after ? formatArgv(stage.hooks.after.argv) : "",
    before_timeout: stage.hooks?.before?.timeout_minutes, after_timeout: stage.hooks?.after?.timeout_minutes, ...after };
}

/** 编辑结果 → 计划；argv 解析失败时返回出错的步骤编号。 */
export function draftPlan(rows: readonly (readonly DraftStage[])[], options: { maxRounds?: number; finish?: "review" | "auto" } = {}): { plan: HandoffPlan } | { problem: string } {
  const flat = rows.flat(), byRow = rowsAfter(rows.map(row => row.map(stage => stage.id.trim())));
  const stages: PlanStage[] = [];
  for (const [index, stage] of flat.entries()) {
    const id = stage.id.trim(), after = stage.after ?? byRow?.get(id);
    const edge = after ? { after } : {};
    if (stage.kind === "checkpoint") { stages.push({ kind: "checkpoint", id, prompt: stage.prompt.trim(), ...edge }); continue; }
    const hook = (text: string, timeout?: number): PlanHook | undefined | false => {
      if (!text.trim()) return undefined;
      const argv = parseArgv(text);
      return argv?.length ? { argv, ...(timeout && timeout !== DEFAULT_HOOK_TIMEOUT_MINUTES ? { timeout_minutes: timeout } : {}) } : false;
    };
    const before = hook(stage.before, stage.before_timeout), afterHook = hook(stage.after_hook, stage.after_timeout);
    if (before === false || afterHook === false) return { problem: t("Step {0}: the hook command has an unclosed quote.", index + 1) };
    const secrets = stage.secrets.split(/[,\s]+/).map(value => value.trim()).filter(Boolean);
    stages.push({ kind: "agent", id, agent: stage.agent.trim(), instruction: stage.instruction.trim(),
      ...(stage.back_to ? { back_to: stage.back_to } : {}), ...edge,
      ...(stage.access !== "write" ? { access: stage.access } : {}), ...(stage.git ? { git: true } : {}),
      ...(secrets.length ? { secrets } : {}),
      ...(before || afterHook ? { hooks: { ...(before ? { before } : {}), ...(afterHook ? { after: afterHook } : {}) } } : {}) });
  }
  return { plan: { stages, ...(options.maxRounds && options.maxRounds !== DEFAULT_PLAN_MAX_ROUNDS ? { max_rounds: options.maxRounds } : {}),
    ...(options.finish === "auto" ? { finish: "auto" as const } : {}) } as HandoffPlan };
}

/** 校验并给出界面语言的说明；schema 再做最后一道检查（交接图的规则用 schema 的说明）。 */
export function planProblem(plan: HandoffPlan): string | undefined {
  const ids = new Set<string>();
  for (const [index, stage] of plan.stages.entries()) {
    const n = index + 1;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(stage.id)) return t("Step {0}: the ID must start with a letter and use only lowercase letters, digits and -.", n);
    if (ids.has(stage.id)) return t("Step {0}: the ID “{1}” is already used.", n, stage.id);
    ids.add(stage.id);
    if (stage.kind === "agent") {
      if (!/^[a-z0-9][a-z0-9-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(stage.agent)) return t("Step {0}: choose who does this step.", n);
      if (!stage.instruction.trim()) return t("Step {0}: describe what this step should do.", n);
      if (stage.secrets?.some(name => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))) return t("Step {0}: secret names use lowercase letters, digits, _ and -.", n);
    } else if (!stage.prompt.trim()) return t("Step {0}: write the question for this checkpoint.", n);
  }
  if (!plan.stages.length) return t("Add at least one step.");
  if (!plan.stages.some(stage => stage.kind === "agent")) return t("A plan needs at least one agent step.");
  for (const [index, stage] of plan.stages.entries()) {
    if (stage.kind === "agent" && stage.back_to && !plan.stages.some(other => other.kind === "agent" && other.id === stage.back_to)) return t("Step {0}: it can only send work back to an agent step.", index + 1);
  }
  if (plan.finish === "auto" && !plan.stages.some(stage => stage.kind === "checkpoint")) return t("Finishing automatically needs at least one checkpoint, so you approve before the plan can complete the task.");
  const parsed = HandoffPlan.safeParse(plan);
  if (!parsed.success) return t("This plan isn't valid: {0}", parsed.error.issues[0]?.message ?? "");
  return undefined;
}

// ───────────── 进度 ─────────────

function stageItem(stage: PlanStage, state: StageState): HTMLElement {
  return h("div", { class: `plan-step-main plan-cell is-${state}` },
    h("p", { class: "plan-step-title" }, stage.kind === "agent" ? stage.agent : stage.prompt,
      state === "current" ? h("span", { class: "pill pill-ochre" }, t("Now")) : state === "done" ? icon("check") : null),
    h("p", { class: "plan-step-sub" }, stage.kind === "agent"
      ? [stage.instruction.split("\n")[0]!.slice(0, 140), stage.back_to ? t(" · may send back to {0}", stage.back_to) : ""].join("")
      : t("Checkpoint · you decide")),
    stage.kind === "agent" && (stage.access || stage.git || stage.secrets || stage.hooks)
      ? h("p", { class: "plan-step-perm" }, permissionSummary(stage), stage.hooks?.before ? t(" · before: {0}", hookText(stage.hooks.before)) : "",
        stage.hooks?.after ? t(" · after: {0}", hookText(stage.hooks.after)) : "") : null);
}

/** 任务页上的计划进度：已完成、当前（并行时多个）、未开始；同一行的阶段并排；轮数。 */
export function planProgress(task: WorkTask): HTMLElement | null {
  const run = task.plan;
  if (!run) return null;
  const states = stageStates(run), byId = new Map(run.plan.stages.map(stage => [stage.id, stage]));
  const rows = planRows(run.plan.stages) ?? run.plan.stages.map(stage => [stage.id]);
  const max = run.plan.max_rounds ?? DEFAULT_PLAN_MAX_ROUNDS;
  const steps = rows.map(row => {
    const list = row.map(id => byId.get(id)!), rowStates = row.map(id => states.get(id)!);
    const state: StageState = rowStates.every(value => value === "done") ? "done" : rowStates.some(value => value !== "next") ? "current" : "next";
    const first = list[0]!;
    return h("li", { class: `plan-step is-${state}${row.length > 1 ? " is-parallel" : ""}` },
      h("span", { class: "plan-dot", "aria-hidden": "true" }, state === "done" ? icon("check") : icon(first.kind === "agent" ? "bot" : "flag")),
      h("div", { class: "plan-row" },
        row.length > 1 ? h("p", { class: "plan-parallel" }, t("In parallel")) : null,
        ...list.map((stage, index) => stageItem(stage, rowStates[index]!)),
        list.some(stage => stage.after) && !planRows(run.plan.stages) ? h("p", { class: "plan-step-sub" }, t("Starts after: {0}", (first.after ?? []).join(", ") || t("nothing"))) : null));
  });
  const auto = run.plan.finish === "auto";
  steps.push(h("li", { class: `plan-step is-${run.stage === "end" ? "current" : "next"}` },
    h("span", { class: "plan-dot", "aria-hidden": "true" }, icon("check")),
    h("div", { class: "plan-step-main" }, h("p", { class: "plan-step-title" }, auto ? t("Finishes automatically") : t("You review the result"),
      run.stage === "end" ? h("span", { class: "pill pill-ochre" }, t("Now")) : null),
      auto ? h("p", { class: "plan-step-sub" }, t("After you pass a checkpoint, the task is marked done when the remaining steps succeed.")) : null)));
  return h("div", { class: "plan" },
    h("p", { class: `plan-rounds${run.rounds >= max ? " is-limit" : ""}` }, t("{0} of {1} rounds used", run.rounds, max)),
    h("ol", { class: "plan-steps" }, ...steps));
}

// ───────────── 编辑器 ─────────────

/** 只能作为说明的权限：执行者没有沙箱时，只读、禁止 Git 都无法强制（ADR 0049 第 3 节）。 */
export function unenforced(stage: Pick<DraftStage, "kind" | "access" | "git">, sandbox: string | undefined): boolean {
  return stage.kind === "agent" && sandbox === "none" && (stage.access !== "full" || !stage.git);
}

/** 计划编辑器（对话框）。保存成功后调用 saved。 */
export async function openPlanEditor(client: Client, task: WorkTask, saved: () => void, isVisible: () => boolean): Promise<void> {
  const [targets, templates] = await Promise.all([
    client.runtimes().then(engineTargets).catch(() => [] as ReturnType<typeof engineTargets>),
    client.workPlanTemplates().catch(() => [] as PlanTemplate[]),
  ]);
  if (!isVisible()) return;
  const store = drafts(), draftKey = `plan:${task.id}:v2`;
  const draft = store.read<{ rows: DraftStage[][]; free: boolean; rounds: string; from: string; finish: string }>(draftKey);
  const agents = [...new Set([...targets.map(target => target.target), ...(task.plan ? agentStages(task.plan.plan).map(stage => stage.agent) : [])])];
  const sandboxOf = (agent: string) => targets.find(target => target.target === agent)?.sandbox;

  /** free：计划无法按行表示，保留各步骤自己的 after，只能编辑内容。 */
  let free = false;
  const load = (plan: HandoffPlan): DraftStage[][] => {
    const rows = planRows(plan.stages);
    free = !rows;
    const byId = new Map(plan.stages.map(stage => [stage.id, stage]));
    return rows ? rows.map(row => row.map(id => toDraft(byId.get(id)!))) : plan.stages.map(stage => [toDraft(stage, true)]);
  };
  let rows: DraftStage[][] = task.plan ? load(task.plan.plan) : [[roleDraft("implement", "implement", agents[0] ?? "")]];
  if (Array.isArray(draft?.rows)) { rows = draft.rows; free = !!draft.free; }

  const maxRounds = h("input", { type: "number", min: "1", max: "30", step: "1", name: "max-rounds", value: draft?.rounds ?? String(task.plan?.plan.max_rounds ?? DEFAULT_PLAN_MAX_ROUNDS) });
  const finish = select("plan-finish", [["review", t("You review the result")], ["auto", t("Finish automatically")]], draft?.finish ?? task.plan?.plan.finish ?? "review");
  const list = h("ol", { class: "plan-edit-list" });
  const from = select("plan-from", [], task.plan && task.plan.stage !== "end" ? task.plan.stage : undefined);
  const error = h("div", { role: "alert" });
  const datalist = h("datalist", { id: "plan-agents" }, ...agents.map(agent => h("option", { value: agent })));
  let dirty = !!draft;
  const persist = () => { if (dirty) store.write(draftKey, { rows, free, rounds: maxRounds.value, from: from.value, finish: finish.value }); };
  const changed = () => { dirty = true; dialog.dataset.dirty = "true"; persist(); };
  const all = () => rows.flat();

  const nextId = (base: string) => { let n = 1; while (all().some(stage => stage.id === `${base}${n > 1 ? `-${n}` : ""}`)) n++; return `${base}${n > 1 ? `-${n}` : ""}`; };
  const lastAgent = () => all().filter(stage => stage.kind === "agent").at(-1);

  const stageCard = (stage: DraftStage, r: number, c: number, n: number): HTMLElement => {
    const set = <K extends keyof DraftStage>(key: K, value: DraftStage[K]) => { stage[key] = value; changed(); };
    const id = h("input", { class: "plan-id", name: `stage-${n}-id`, value: stage.id, "aria-label": t("Step ID"), autocomplete: "off", spellcheck: "false" });
    id.addEventListener("input", () => set("id", id.value));
    id.addEventListener("change", () => { set("id", id.value.trim().toLowerCase()); render(); });
    const row = rows[r]!;
    const moveRow = (delta: number) => {
      const target = r + delta; if (target < 0 || target >= rows.length) return;
      if (row.length > 1) { row.splice(c, 1); rows.splice(delta > 0 ? r + 1 : r, 0, [stage]); }
      else [rows[r], rows[target]] = [rows[target]!, rows[r]!];
      changed(); render();
    };
    const join = () => { row.splice(c, 1); rows[r - 1]!.push(stage); if (!row.length) rows.splice(r, 1); changed(); render(); };
    const split = () => { row.splice(c, 1); rows.splice(r + 1, 0, [stage]); changed(); render(); };
    const remove = () => { row.splice(c, 1); if (!row.length) rows.splice(r, 1); changed(); render(); };
    const tools = h("div", { class: "plan-edit-tools" },
      !free && r > 0 && row.length === 1 ? h("button", { type: "button", class: "icon-btn", title: t("Run alongside the step above"), "aria-label": t("Run alongside the step above"), onclick: join }, icon("graph")) : null,
      !free && row.length > 1 ? h("button", { type: "button", class: "icon-btn", title: t("Run on its own after this row"), "aria-label": t("Run on its own after this row"), onclick: split }, icon("back")) : null,
      h("button", { type: "button", class: "icon-btn", title: t("Move up"), "aria-label": t("Move up"), disabled: r === 0 && row.length === 1, onclick: () => moveRow(-1) }, icon("down", "icon flip")),
      h("button", { type: "button", class: "icon-btn", title: t("Move down"), "aria-label": t("Move down"), disabled: r === rows.length - 1 && row.length === 1, onclick: () => moveRow(1) }, icon("down")),
      h("button", { type: "button", class: "icon-btn", title: t("Remove step"), "aria-label": t("Remove step"), onclick: remove }, icon("close")));
    let body: HTMLElement;
    if (stage.kind === "agent") {
      const warn = h("p", { class: "field-hint plan-warn" });
      const refreshWarn = () => { warn.textContent = unenforced(stage, sandboxOf(stage.agent)) ? t("{0} has no sandbox, so these permissions are passed to it as instructions only.", stage.agent) : ""; };
      const agent = h("input", { name: `stage-${n}-agent`, value: stage.agent, list: "plan-agents", placeholder: t("engine@device, e.g. codex@mac"), autocomplete: "off", spellcheck: "false" });
      agent.addEventListener("input", () => { set("agent", agent.value.trim()); refreshWarn(); });
      const instruction = autosize(h("textarea", { name: `stage-${n}-instruction`, rows: "2", placeholder: t("What should this step do? e.g. Implement the change and open a PR.") }));
      instruction.value = stage.instruction;
      instruction.addEventListener("input", () => set("instruction", instruction.value));
      const others = all().filter(other => other.kind === "agent" && other !== stage && other.id);
      const back = select(`stage-${n}-back`, [["", t("No — continue to the next step")], ...others.map(other => [other.id, t("Yes — back to {0}", other.id)] as [string, string])], stage.back_to);
      back.addEventListener("change", () => set("back_to", back.value));
      const access = select(`stage-${n}-access`, [["read", t("Read only")], ["write", t("Edit the working directory")], ["full", t("Full access (no sandbox)")]], stage.access);
      access.addEventListener("change", () => { set("access", access.value as StageAccess); refreshWarn(); });
      const git = h("input", { type: "checkbox", name: `stage-${n}-git`, checked: stage.git });
      git.addEventListener("change", () => { set("git", git.checked); refreshWarn(); });
      const secrets = h("input", { name: `stage-${n}-secrets`, value: stage.secrets, placeholder: t("e.g. github-merge"), autocomplete: "off", spellcheck: "false" });
      secrets.addEventListener("input", () => set("secrets", secrets.value));
      const before = h("input", { name: `stage-${n}-before`, value: stage.before, placeholder: t("e.g. gh pr checks --watch"), autocomplete: "off", spellcheck: "false", class: "mono" });
      before.addEventListener("input", () => set("before", before.value));
      const afterHook = h("input", { name: `stage-${n}-after`, value: stage.after_hook, placeholder: t("e.g. bun run check"), autocomplete: "off", spellcheck: "false", class: "mono" });
      afterHook.addEventListener("input", () => set("after_hook", afterHook.value));
      const advanced = !!(stage.access !== "write" || stage.git || stage.secrets || stage.before || stage.after_hook);
      const details = h("details", { class: "plan-perm", open: advanced },
        h("summary", {}, t("Permissions and hooks"), h("span", { class: "muted" }, " · ", permissionSummary(draftPlanStage(stage)))),
        h("div", { class: "plan-perm-grid" },
          field(t("Access"), access),
          h("label", { class: "check-field" }, git, h("span", {}, t("Allow Git writes (fetch, commit, push)"))),
          field(t("Secrets for this step"), secrets, t("Comma-separated names. Only this step receives them.")),
          field(t("Before the agent starts"), before, t("Optional command. If it fails, the step doesn't start and it's your turn.")),
          field(t("After the agent finishes"), afterHook, t("Optional command. If it fails, the round counts as failed."))));
      refreshWarn();
      body = h("div", { class: "plan-edit-body" }, field(t("Who"), agent), warn, field(t("Instruction"), instruction),
        others.length ? field(t("Can it send work back?"), back, t("When this agent reports changes are needed, the plan returns to the chosen step.")) : null,
        details,
        stage.after ? h("p", { class: "field-hint" }, t("Starts after: {0}", stage.after.join(", ") || t("nothing"))) : null);
    } else {
      const prompt = h("input", { name: `stage-${n}-prompt`, value: stage.prompt, maxlength: "200", placeholder: t("Question for you, e.g. Merge it?"), autocomplete: "off" });
      prompt.addEventListener("input", () => set("prompt", prompt.value));
      body = h("div", { class: "plan-edit-body" }, field(t("Question"), prompt, t("The plan stops here until you continue, send back, finish or hold.")),
        stage.after ? h("p", { class: "field-hint" }, t("Starts after: {0}", stage.after.join(", ") || t("nothing"))) : null);
    }
    return h("div", { class: `plan-edit-step is-${stage.kind}` },
      h("header", { class: "plan-edit-head" },
        h("span", { class: "plan-edit-n" }, String(n)),
        icon(stage.kind === "agent" ? "bot" : "flag"),
        h("span", { class: "plan-edit-kind" }, stage.kind === "agent" ? t("Agent step") : t("Checkpoint")),
        id, tools),
      body);
  };

  const render = () => {
    let n = 0;
    clear(list, ...rows.map((row, r) => h("li", { class: `plan-edit-row${row.length > 1 ? " is-parallel" : ""}` },
      row.length > 1 ? h("p", { class: "plan-parallel" }, t("In parallel — the next row starts when all of these are done")) : null,
      h("div", { class: "plan-edit-cells" }, ...row.map((stage, c) => stageCard(stage, r, c, ++n))))));
    const options: Array<[string, string]> = all().filter(stage => stage.id).map(stage => [stage.id, `${stage.id}${stage.kind === "agent" ? ` · ${stage.agent}` : ""}`]);
    const keep = from.value;
    clear(from, ...options.map(([value, label]) => h("option", { value }, label)));
    if (options.some(([value]) => value === keep)) from.value = keep;
    persist();
  };

  const plan = (): HandoffPlan | undefined => {
    const rounds = Number(maxRounds.value);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 30) { clear(error, failure(t("The round limit must be a whole number from 1 to 30."))); return; }
    const built = draftPlan(rows, { maxRounds: rounds, finish: finish.value as "review" | "auto" });
    const problem = "problem" in built ? built.problem : planProblem(built.plan);
    if (problem || !("plan" in built)) { clear(error, failure(problem ?? "")); return; }
    clear(error);
    return HandoffPlan.parse(built.plan);
  };

  const add = (stage: DraftStage) => { rows.push([stage]); changed(); render(); };
  const addAgent = h("button", { type: "button", class: "btn btn-small", onclick: () => {
    add({ ...roleDraft("review", nextId(all().some(s => s.kind === "agent") ? "step" : "implement"), "", lastAgent()?.id ?? ""), access: "write", instruction: "" });
  } }, icon("bot"), t("Agent step"));
  const addCheckpoint = h("button", { type: "button", class: "btn btn-small", onclick: () => add({ ...roleDraft("trial", nextId("check"), ""), prompt: "" }) }, icon("flag"), t("Checkpoint"));
  const role = select("plan-role", [["", t("Add from a role…")], ...ROLES.map(value => [value, roleLabel(value)] as [string, string])]);
  role.addEventListener("change", () => {
    const value = role.value as Role | "";
    role.value = "";
    if (!value) return;
    const prior = lastAgent();
    add(roleDraft(value, nextId(value), value === "review" ? agents.find(agent => agent !== prior?.agent) ?? prior?.agent ?? "" : prior?.agent ?? agents[0] ?? "", prior?.id ?? ""));
  });

  const templateTools = h("div", { class: "plan-templates" });
  const renderTemplates = (items: PlanTemplate[]) => {
    if (!items.length) { clear(templateTools); return; }
    const pick = select("plan-template", [["", t("Start from a template…")], ...items.map(item => [item.id, item.name] as [string, string])]);
    pick.addEventListener("change", () => {
      const chosen = items.find(item => item.id === pick.value);
      if (!chosen || (dirty && !confirm(t("Replace the current steps with “{0}”?", chosen.name)))) { pick.value = ""; return; }
      rows = load(chosen.plan); maxRounds.value = String(chosen.plan.max_rounds ?? DEFAULT_PLAN_MAX_ROUNDS); finish.value = chosen.plan.finish ?? "review";
      changed(); render(); pick.value = "";
    });
    clear(templateTools, pick);
  };
  renderTemplates(templates);

  const saveTemplate = h("button", { type: "button", class: "text-btn", onclick: async () => {
    const value = plan(); if (!value) return;
    const name = prompt(t("Template name"))?.trim();
    if (!name) return;
    try {
      const existing = templates.find(item => item.name === name);
      if (existing && !confirm(t("Replace the template “{0}”?", name))) return;
      const result = await client.workCommand(templateSaveCommand(name.slice(0, 80), value, existing?.id));
      if (result.kind === "template") { const i = templates.findIndex(item => item.id === result.template.id); if (i >= 0) templates[i] = result.template; else templates.push(result.template); renderTemplates(templates); }
      toast(t("Template saved"));
    } catch (cause) { clear(error, failure(errorText(cause))); }
  } }, icon("download"), t("Save as template"));

  const form = h("form", { id: `plan-${newRequestId()}`, class: "form-stack plan-editor" },
    h("p", { class: "muted" }, t("After each delivered round, the plan hands the task to the next step. Steps in the same row run in parallel. Saving doesn't start anything; you still dispatch the first round.")),
    free ? h("p", { class: "field-hint" }, t("This plan's order can't be shown as rows, so each step keeps its own “starts after”. You can still edit the steps.")) : null,
    templateTools, list, datalist,
    h("div", { class: "button-row" }, addAgent, addCheckpoint, role),
    h("div", { class: "plan-edit-foot" },
      field(t("Round limit"), maxRounds, t("When reached, the plan stops and it's your turn.")),
      field(t("When the plan ends"), finish, t("Finishing automatically needs a checkpoint: you approve there, and the task is done when the remaining steps succeed.")),
      field(t("Start from"), from)),
    error);
  const submit = h("button", { type: "submit", form: form.id, class: "btn btn-primary" }, icon("check"), t("Save plan"));
  const clearPlan = task.plan ? h("button", { type: "button", class: "btn btn-quiet", onclick: () => void commit(null) }, t("Remove plan")) : null;
  const dialog = openDialog(task.plan ? t("Edit handoff plan") : t("Add a handoff plan"), form, [saveTemplate, ...(clearPlan ? [clearPlan] : []), submit], { wide: true });
  render();
  if (draft?.from) from.value = draft.from;
  form.addEventListener("input", () => { dirty = true; persist(); });
  form.addEventListener("change", () => { dirty = true; persist(); });
  dialog.addEventListener("close", () => { if (dialog.dataset.dirty === "false") store.remove(draftKey); else persist(); });

  let pending = false, requestId = newRequestId(), previous = "";
  const commit = async (value: HandoffPlan | null) => {
    if (pending) return;
    if (value === null && !confirm(t("Remove the plan from this task? Running rounds are not affected."))) return;
    const key = JSON.stringify([value, from.value]);
    if (previous && previous !== key) requestId = newRequestId();
    previous = key; pending = true; submit.disabled = true;
    try {
      const current = (await client.workTask(task.id)).task;
      if (current.revision !== task.revision) throw Object.assign(new Error("changed"), { conflict: true });
      await client.workCommand(planSetCommand(current, value, value ? from.value || undefined : undefined, requestId));
      dialog.dataset.dirty = "false"; dialog.close();
      toast(value ? t("Plan saved. Dispatch the first round when you're ready.") : t("Plan removed"));
      saved();
    } catch (cause) {
      clear(error, failure(isConflict(cause) || (cause as { conflict?: boolean }).conflict ? t("This task changed while you were editing. Close and reopen the editor.") : errorText(cause)));
    } finally { pending = false; submit.disabled = false; }
  };
  form.addEventListener("submit", event => { event.preventDefault(); const value = plan(); if (value) void commit(value); });
}

/** 编辑中的一步 → 用于摘要显示的阶段（忽略无法解析的钩子）。 */
function draftPlanStage(stage: DraftStage): PlanStage {
  return { kind: "agent", id: stage.id || "x", agent: stage.agent || "x", instruction: "x",
    ...(stage.access !== "write" ? { access: stage.access } : {}), ...(stage.git ? { git: true } : {}),
    ...(stage.secrets.trim() ? { secrets: stage.secrets.split(/[,\s]+/).filter(Boolean) } : {}) };
}

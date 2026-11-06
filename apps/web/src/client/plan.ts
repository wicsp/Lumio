/**
 * 交接计划（ADR 0032 第 5 节）：命令、进度显示与编辑器。
 * 计划只回答「一轮交付之后交给谁」：agent 阶段（可打回到某个 agent 阶段）与检查点（轮到你决定）。
 * 设置计划不会开始委派；第一轮仍由你点「委派」。
 */
import { DEFAULT_PLAN_MAX_ROUNDS, HandoffPlan, type PlanStage, type PlanTemplate, type WorkCommandRequest, type WorkTask } from "@lumio/schema";
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

/** 校验并给出界面语言的说明；schema 再做最后一道检查。 */
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
    } else if (!stage.prompt.trim()) return t("Step {0}: write the question for this checkpoint.", n);
  }
  if (!plan.stages.length) return t("Add at least one step.");
  if (!plan.stages.some(stage => stage.kind === "agent")) return t("A plan needs at least one agent step.");
  for (const [index, stage] of plan.stages.entries()) {
    if (stage.kind === "agent" && stage.back_to && !plan.stages.some(other => other.kind === "agent" && other.id === stage.back_to)) return t("Step {0}: it can only send work back to an agent step.", index + 1);
  }
  if (!HandoffPlan.safeParse(plan).success) return t("This plan isn't valid. Check each step.");
  return undefined;
}

/** 任务页上的计划进度：已完成、当前、未开始；轮数。 */
export function planProgress(task: WorkTask): HTMLElement | null {
  const run = task.plan;
  if (!run) return null;
  const index = run.stage === "end" ? run.plan.stages.length : run.plan.stages.findIndex(stage => stage.id === run.stage);
  const max = run.plan.max_rounds ?? DEFAULT_PLAN_MAX_ROUNDS;
  const steps = run.plan.stages.map((stage, i) => {
    const state = i < index ? "done" : i === index ? "current" : "next";
    return h("li", { class: `plan-step is-${state}` },
      h("span", { class: "plan-dot", "aria-hidden": "true" }, state === "done" ? icon("check") : icon(stage.kind === "agent" ? "bot" : "flag")),
      h("div", { class: "plan-step-main" },
        h("p", { class: "plan-step-title" }, stage.kind === "agent" ? stage.agent : stage.prompt,
          state === "current" ? h("span", { class: "pill pill-ochre" }, t("Now")) : null),
        h("p", { class: "plan-step-sub" }, stage.kind === "agent"
          ? [stage.instruction.split("\n")[0]!.slice(0, 140), stage.back_to ? t(" · may send back to {0}", stage.back_to) : ""].join("")
          : t("Checkpoint · you decide"))));
  });
  steps.push(h("li", { class: `plan-step is-${run.stage === "end" ? "current" : "next"}` },
    h("span", { class: "plan-dot", "aria-hidden": "true" }, icon("check")),
    h("div", { class: "plan-step-main" }, h("p", { class: "plan-step-title" }, t("You review the result"),
      run.stage === "end" ? h("span", { class: "pill pill-ochre" }, t("Now")) : null))));
  return h("div", { class: "plan" },
    h("p", { class: `plan-rounds${run.rounds >= max ? " is-limit" : ""}` }, t("{0} of {1} rounds used", run.rounds, max)),
    h("ol", { class: "plan-steps" }, ...steps));
}

interface DraftStage { kind: "agent" | "checkpoint"; id: string; agent: string; instruction: string; back_to: string; prompt: string }
const toDraft = (stage: PlanStage): DraftStage => stage.kind === "agent"
  ? { kind: "agent", id: stage.id, agent: stage.agent, instruction: stage.instruction, back_to: stage.back_to ?? "", prompt: "" }
  : { kind: "checkpoint", id: stage.id, agent: "", instruction: "", back_to: "", prompt: stage.prompt };
const fromDraft = (stage: DraftStage): PlanStage => stage.kind === "agent"
  ? { kind: "agent", id: stage.id.trim(), agent: stage.agent.trim(), instruction: stage.instruction.trim(), ...(stage.back_to ? { back_to: stage.back_to } : {}) }
  : { kind: "checkpoint", id: stage.id.trim(), prompt: stage.prompt.trim() };

/** 计划编辑器（对话框）。保存成功后调用 saved。 */
export async function openPlanEditor(client: Client, task: WorkTask, saved: () => void): Promise<void> {
  const [targets, templates] = await Promise.all([
    client.runtimes().then(engineTargets).catch(() => []),
    client.workPlanTemplates().catch(() => [] as PlanTemplate[]),
  ]);
  const store = drafts(), draftKey = `plan:${task.id}`;
  const draft = store.read<{stages:DraftStage[];rounds:string;from:string}>(draftKey);
  const agents = [...new Set([...targets.map(target => target.target), ...(task.plan ? agentStages(task.plan.plan).map(stage => stage.agent) : [])])];
  let stages: DraftStage[] = task.plan ? task.plan.plan.stages.map(toDraft) : [
    { kind: "agent", id: "implement", agent: agents[0] ?? "", instruction: "", back_to: "", prompt: "" },
  ];
  if (Array.isArray(draft?.stages)) stages = draft.stages;
  const maxRounds = h("input", { type: "number", min: "1", max: "30", step: "1", name: "max-rounds", value: draft?.rounds ?? String(task.plan?.plan.max_rounds ?? DEFAULT_PLAN_MAX_ROUNDS) });
  const list = h("ol", { class: "plan-edit-list" });
  const from = select("plan-from", [], task.plan && task.plan.stage !== "end" ? task.plan.stage : undefined);
  const error = h("div", { role: "alert" });
  const datalist = h("datalist", { id: "plan-agents" }, ...agents.map(agent => h("option", { value: agent })));
  let dirty = !!draft;
  const persist = () => { if (dirty) store.write(draftKey, {stages, rounds:maxRounds.value, from:from.value}); };

  const nextId = (base: string) => { let n = 1; while (stages.some(stage => stage.id === `${base}${n > 1 ? `-${n}` : ""}`)) n++; return `${base}${n > 1 ? `-${n}` : ""}`; };
  const render = () => {
    clear(list, ...stages.map((stage, index) => {
      const set = <K extends keyof DraftStage>(key: K, value: DraftStage[K]) => { stage[key] = value; dirty = true; dialog.dataset.dirty = "true"; persist(); };
      const id = h("input", { class: "plan-id", name: `stage-${index}-id`, value: stage.id, "aria-label": t("Step ID"), autocomplete: "off", spellcheck: "false" });
      id.addEventListener("input", () => set("id", id.value));
      id.addEventListener("change", () => { set("id", id.value.trim().toLowerCase()); render(); });
      const move = (delta: number) => { const target = index + delta; if (target < 0 || target >= stages.length) return; [stages[index], stages[target]] = [stages[target]!, stages[index]!]; dirty = true; render(); };
      const tools = h("div", { class: "plan-edit-tools" },
        h("button", { type: "button", class: "icon-btn", title: t("Move up"), "aria-label": t("Move up"), disabled: index === 0, onclick: () => move(-1) }, icon("down", "icon flip")),
        h("button", { type: "button", class: "icon-btn", title: t("Move down"), "aria-label": t("Move down"), disabled: index === stages.length - 1, onclick: () => move(1) }, icon("down")),
        h("button", { type: "button", class: "icon-btn", title: t("Remove step"), "aria-label": t("Remove step"), onclick: () => { stages.splice(index, 1); dirty = true; render(); } }, icon("close")));
      let body: HTMLElement;
      if (stage.kind === "agent") {
        const agent = h("input", { name: `stage-${index}-agent`, value: stage.agent, list: "plan-agents", placeholder: t("engine@device, e.g. codex@mac"), autocomplete: "off", spellcheck: "false" });
        agent.addEventListener("input", () => set("agent", agent.value.trim()));
        const instruction = autosize(h("textarea", { name: `stage-${index}-instruction`, rows: "2", placeholder: t("What should this step do? e.g. Implement the change and open a PR.") }));
        instruction.value = stage.instruction;
        instruction.addEventListener("input", () => set("instruction", instruction.value));
        const others = stages.filter(other => other.kind === "agent" && other !== stage && other.id);
        const back = select(`stage-${index}-back`, [["", t("No — continue to the next step")], ...others.map(other => [other.id, t("Yes — back to {0}", other.id)] as [string, string])], stage.back_to);
        back.addEventListener("change", () => set("back_to", back.value));
        body = h("div", { class: "plan-edit-body" }, field(t("Who"), agent), field(t("Instruction"), instruction),
          others.length ? field(t("Can it send work back?"), back, t("When this agent reports changes are needed, the plan returns to the chosen step.")) : null);
      } else {
        const prompt = h("input", { name: `stage-${index}-prompt`, value: stage.prompt, maxlength: "200", placeholder: t("Question for you, e.g. Merge it?"), autocomplete: "off" });
        prompt.addEventListener("input", () => set("prompt", prompt.value));
        body = h("div", { class: "plan-edit-body" }, field(t("Question"), prompt, t("The plan stops here until you continue, send back, finish or hold.")));
      }
      return h("li", { class: `plan-edit-step is-${stage.kind}` },
        h("header", { class: "plan-edit-head" },
          h("span", { class: "plan-edit-n" }, String(index + 1)),
          icon(stage.kind === "agent" ? "bot" : "flag"),
          h("span", { class: "plan-edit-kind" }, stage.kind === "agent" ? t("Agent step") : t("Checkpoint")),
          id, tools),
        body);
    }));
    const options: Array<[string, string]> = stages.filter(stage => stage.id).map(stage => [stage.id, `${stage.id}${stage.kind === "agent" ? ` · ${stage.agent}` : ""}`]);
    const keep = from.value;
    clear(from, ...options.map(([value, label]) => h("option", { value }, label)));
    if (options.some(([value]) => value === keep)) from.value = keep;
    persist();
  };

  const plan = (): HandoffPlan | undefined => {
    const rounds = Number(maxRounds.value);
    const value = { stages: stages.map(fromDraft), ...(rounds && rounds !== DEFAULT_PLAN_MAX_ROUNDS ? { max_rounds: rounds } : {}) } as HandoffPlan;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 30) { clear(error, failure(t("The round limit must be a whole number from 1 to 30."))); return; }
    const problem = planProblem(value);
    if (problem) { clear(error, failure(problem)); return; }
    clear(error);
    return HandoffPlan.parse(value);
  };

  const addAgent = h("button", { type: "button", class: "btn btn-small", onclick: () => {
    const prior = stages.filter(stage => stage.kind === "agent").at(-1);
    stages.push({ kind: "agent", id: nextId(stages.some(s => s.kind === "agent") ? "review" : "implement"), agent: "", instruction: "", back_to: prior?.id ?? "", prompt: "" });
    dirty = true; render();
  } }, icon("bot"), t("Agent step"));
  const addCheckpoint = h("button", { type: "button", class: "btn btn-small", onclick: () => {
    stages.push({ kind: "checkpoint", id: nextId("check"), agent: "", instruction: "", back_to: "", prompt: "" }); dirty = true; render();
  } }, icon("flag"), t("Checkpoint"));

  const templateTools = h("div", { class: "plan-templates" });
  const renderTemplates = (list: PlanTemplate[]) => {
    if (!list.length) { clear(templateTools); return; }
    const pick = select("plan-template", [["", t("Start from a template…")], ...list.map(item => [item.id, item.name] as [string, string])]);
    pick.addEventListener("change", () => {
      const chosen = list.find(item => item.id === pick.value);
      if (!chosen || (dirty && !confirm(t("Replace the current steps with “{0}”?", chosen.name)))) { pick.value = ""; return; }
      stages = chosen.plan.stages.map(toDraft); maxRounds.value = String(chosen.plan.max_rounds ?? DEFAULT_PLAN_MAX_ROUNDS); dirty = true; render(); pick.value = "";
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
    h("p", { class: "muted" }, t("After each delivered round, the plan hands the task to the next step. Saving doesn't start anything; you still dispatch the first round.")),
    templateTools, list, datalist,
    h("div", { class: "button-row" }, addAgent, addCheckpoint),
    h("div", { class: "plan-edit-foot" },
      field(t("Round limit"), maxRounds, t("When reached, the plan stops and it's your turn.")),
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

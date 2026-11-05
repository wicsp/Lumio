/**
 * 「需要你处理」的一张卡片（ADR 0030、0032）：等你回答 / 等你验收 / 执行失败 / 交接计划的检查点。
 * 今日、任务页和执行详情共用。每个操作都先读任务的当前版本再提交，冲突时说明而不覆盖。
 * 「我自己来」把任务交回给你（原因 todo）：提醒消失，任务仍在你手里。
 */
import type { WorkAttention } from "@lumio/schema";
import { errorText, isConflict, type Client, type HubExtras } from "./api.ts";
import { answerCommand, engineTargets, formatTime, newRequestId } from "./commands.ts";
import { agentStages, checkpointCommand, type CheckpointAction } from "./plan.ts";
import { finishCommand, handCommand } from "./turn.ts";
import { autosize, clear, failure, h, icon, openMenu, select, toast } from "./dom.ts";
import { ago } from "./format.ts";
import { t } from "./i18n.ts";
import type { Navigate } from "./navigation.ts";

export interface AttentionContext {
  client: Client;
  hub: HubExtras;
  navigate: Navigate;
  /** 处理完成后调用：调用方刷新列表或页面。 */
  changed(): void;
}

const KIND: Record<WorkAttention["kind"], { label: string; glyph: string; tone: string }> = {
  question: { label: "Waiting for your answer", glyph: "help", tone: "ochre" },
  review: { label: "Ready for your review", glyph: "check", tone: "green" },
  failed: { label: "Run failed", glyph: "alert", tone: "red" },
};

/** where：today 显示任务标题；task 在任务页里，不重复标题；job 在执行详情里。 */
export function attentionCard(item: WorkAttention, ctx: AttentionContext, where: "today" | "task" | "job" = "today"): HTMLElement {
  const kind = KIND[item.kind];
  // 有交接计划时，继续的一定是计划里这一阶段的 agent，不让人改。
  const planned = item.stage !== undefined;
  let target = planned ? undefined : item.agent;
  const card = h("article", { class: `attn attn-${kind.tone}`, "data-task": item.task, "data-round": String(item.round) });
  const status = h("div", { role: "status", class: "attn-status" });
  const error = h("div", { role: "alert" });
  const actions = h("div", { class: "attn-actions" });
  let busy = false;

  const run = async (work: () => Promise<string>) => {
    if (busy) return;
    busy = true; card.classList.add("is-busy"); clear(error);
    try {
      const done = await work();
      clear(card, h("p", { class: "attn-done" }, icon("check"), done));
      card.classList.add("is-done");
      ctx.changed();
    } catch (cause) {
      clear(error, failure(isConflict(cause) ? t("This task changed since this card was shown. Refresh and try again.") : errorText(cause)));
    } finally { busy = false; card.classList.remove("is-busy"); }
  };
  const currentTask = async () => (await ctx.client.workTask(item.task)).task;

  // 回答框：等你回答时直接显示；验收与失败时点按钮后展开。
  const composer = (button: string, required: boolean, placeholder: string) => {
    const text = autosize(h("textarea", { rows: "2", placeholder, "aria-label": placeholder }));
    const chip = h("button", { type: "button", class: "attn-target", title: t("Change who continues") }, icon("bot"), h("span", {}, ""));
    const renderChip = () => { (chip.lastChild as HTMLElement).textContent = planned ? t("Continue with the plan's agent") : target ? t("Continue with {0}", target) : t("Choose who continues"); };
    if (planned) chip.disabled = true;
    renderChip();
    chip.addEventListener("click", async () => {
      try {
        const targets = engineTargets(await ctx.client.runtimes());
        openMenu(chip, targets.map(x => ({ value: x.target, label: x.label, selected: x.target === target, icon: icon("bot") })), value => { target = value; renderChip(); });
      } catch (cause) { clear(error, failure(errorText(cause))); }
    });
    const submit = h("button", { type: "submit", class: "btn btn-primary btn-small" }, icon("send"), button);
    const form = h("form", { class: "attn-composer" }, text, h("div", { class: "attn-composer-foot" }, chip, submit));
    let requestId = newRequestId(), previous = "";
    text.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); form.requestSubmit(); } });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const answer = text.value.trim();
      if (required && !answer) { text.focus(); return; }
      if (!target && !planned) { chip.click(); return; }
      if (previous && previous !== `${target}\n${answer}`) requestId = newRequestId();
      previous = `${target}\n${answer}`;
      void run(async () => {
        const task = await currentTask();
        await ctx.client.workCommand(answer ? answerCommand(task, target, answer, requestId)
          : { request_id: requestId, operation: { op: "work.task.dispatch", args: { task: task.id, ...(target ? { to: target } : {}), expected_revision: task.revision } } });
        const who = target ?? item.agent ?? t("the agent");
        toast(t("Dispatched to {0}", who));
        return t("Sent. {0} is continuing.", who);
      });
    });
    return { form, focus: () => text.focus() };
  };

  const seen = h("button", { type: "button", class: "btn btn-quiet btn-small", title: t("Clear this reminder; the task stays with you as a to-do") }, t("I'll handle it"));
  seen.addEventListener("click", () => void run(async () => {
    await ctx.client.workCommand(handCommand(await currentTask(), "human"));
    return t("It's yours now. The reminder is cleared.");
  }));

  // 交接计划的检查点，或计划走完后的验收（ADR 0032 第 5 节）。
  const checkpoint = (stage: string) => {
    const decide = (action: CheckpointAction, done: string, options: { backTo?: string; comment?: string } = {}) => void run(async () => {
      await ctx.client.workCommand(checkpointCommand(item.task, stage, action, options));
      return done;
    });
    const end = stage === "end";
    const go = h("button", { type: "button", class: "btn btn-primary btn-small" }, icon("play"), t("Continue"));
    go.addEventListener("click", () => decide("continue", t("Continuing with the next step.")));
    const finish = h("button", { type: "button", class: `btn btn-small${end ? " btn-primary" : ""}` }, icon("check"), t("Mark done"));
    finish.addEventListener("click", () => decide("finish", t("Task marked done.")));
    const hold = h("button", { type: "button", class: "btn btn-quiet btn-small" }, icon("pause"), t("Put on hold"));
    hold.addEventListener("click", () => decide("hold", t("Put on hold.")));
    const back = h("button", { type: "button", class: "btn btn-small" }, icon("undo"), t("Send back…"));
    back.addEventListener("click", () => void (async () => {
      try {
        const task = await currentTask();
        const stages = task.plan ? agentStages(task.plan.plan) : [];
        if (!stages.length) { clear(error, failure(t("This task no longer has a plan. Refresh and try again."))); return; }
        const to = select("back-to", stages.map(value => [value.id, t("{0} ({1})", value.id, value.agent)] as [string, string]), stages.at(-2)?.id ?? stages[0]!.id);
        const text = autosize(h("textarea", { rows: "2", placeholder: t("What should change?"), "aria-label": t("What should change?") }));
        const send = h("button", { type: "submit", class: "btn btn-primary btn-small" }, icon("undo"), t("Send back"));
        const form = h("form", { class: "attn-composer" }, text, h("div", { class: "attn-composer-foot" }, h("label", { class: "attn-back" }, t("Back to"), to), send));
        form.addEventListener("submit", event => {
          event.preventDefault();
          if (!text.value.trim()) { text.focus(); return; }
          decide("send_back", t("Sent back to {0}.", to.value), { backTo: to.value, comment: text.value });
        });
        actions.replaceWith(form); text.focus();
      } catch (cause) { clear(error, failure(errorText(cause))); }
    })());
    actions.append(...(end ? [finish, back, hold] : [go, back, finish, hold]));
  };

  let body: Node | null = null;
  if (item.kind === "question") {
    const answer = composer(t("Answer and continue"), true, t("Your answer…"));
    body = h("div", { class: "attn-body" }, h("p", { class: "attn-question" }, item.question ?? t("The agent is waiting for your input.")), answer.form);
  } else {
    if (item.prompt) body = h("p", { class: "attn-question" }, item.prompt);
    else if (item.summary) body = h("p", { class: "attn-summary" }, item.summary);
    if (item.kind === "review" && (item.prompt || item.stage === "end")) checkpoint(item.stage!);
    else if (item.kind === "review") {
      const done = h("button", { type: "button", class: "btn btn-primary btn-small" }, icon("check"), t("Mark done"));
      done.addEventListener("click", () => void run(async () => {
        await ctx.client.workCommand(finishCommand(await currentTask(), "done"));
        return t("Task marked done.");
      }));
      const feedback = h("button", { type: "button", class: "btn btn-small" }, icon("edit"), t("Add feedback and continue"));
      feedback.addEventListener("click", () => {
        const next = composer(t("Send and continue"), true, t("What should change in the next round?"));
        actions.replaceWith(next.form); next.focus();
      });
      actions.append(done, feedback, seen);
    } else {
      const retry = h("button", { type: "button", class: "btn btn-small" }, icon("refresh"), t("Retry"));
      retry.addEventListener("click", () => {
        const next = composer(t("Retry"), false, t("Optional: anything to change this time?"));
        actions.replaceWith(next.form); next.focus();
      });
      actions.append(retry, seen);
    }
  }

  const meta = [t("Round {0}", item.round), item.agent, ago(item.since)].filter(Boolean).join(t(" · "));
  const label = item.kind === "review" && item.prompt ? t("Checkpoint") : item.kind === "review" && item.stage === "end" ? t("Plan finished · ready for your review") : t(kind.label);
  card.append(
    h("header", { class: "attn-head" },
      h("span", { class: "attn-icon" }, icon(kind.glyph)),
      h("div", { class: "attn-heading" },
        h("p", { class: "attn-kind" }, label),
        where === "today" ? h("button", { type: "button", class: "attn-title", onclick: () => ctx.navigate("work", item.task) }, item.title) : null,
        h("p", { class: "attn-meta", title: formatTime(item.since) }, meta)),
      where !== "job" ? h("button", { type: "button", class: "text-btn attn-report", onclick: () => ctx.navigate("execution", item.job) }, t("View run")) : null),
    ...[body, item.kind === "question" ? null : actions, status, error].filter((node): node is Node => node !== null));
  return card;
}

/** 按任务查当前的提醒（任务页、执行详情用）；旧 Hub 没有接口时返回 undefined。 */
export async function attentionFor(hub: HubExtras, task: string): Promise<WorkAttention | undefined> {
  return (await hub.attention())?.find(item => item.task === task);
}

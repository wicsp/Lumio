/**
 * 「需要你处理」的一张卡片（ADR 0030）：等你回答 / 等你验收 / 执行失败。
 * 今日、任务页和执行详情共用。每个操作都先读任务的当前版本再提交，冲突时说明而不覆盖。
 */
import type { WorkAttention } from "@lumio/schema";
import { errorText, isConflict, type Client, type HubExtras } from "./api.ts";
import { acknowledgeCommand, answerCommand, engineTargets, formatTime, newRequestId, workPatchCommand } from "./commands.ts";
import { autosize, clear, failure, h, icon, openMenu, toast } from "./dom.ts";
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
  let target = item.agent;
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
    const renderChip = () => { (chip.lastChild as HTMLElement).textContent = target ? t("Continue with {0}", target) : t("Choose who continues"); };
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
      if (!target) { chip.click(); return; }
      if (previous && previous !== `${target}\n${answer}`) requestId = newRequestId();
      previous = `${target}\n${answer}`;
      void run(async () => {
        const task = await currentTask();
        await ctx.client.workCommand(answer ? answerCommand(task, target, answer, requestId)
          : { request_id: requestId, operation: { op: "work.task.dispatch", args: { task: task.id, to: target, expected_revision: task.revision } } });
        toast(t("Dispatched to {0}", target!));
        return t("Sent. {0} is continuing.", target!);
      });
    });
    return { form, focus: () => text.focus() };
  };

  const seen = h("button", { type: "button", class: "btn btn-quiet btn-small", title: t("Clear this reminder without changing the task") }, t("Seen"));
  seen.addEventListener("click", () => void run(async () => {
    await ctx.client.workCommand(acknowledgeCommand(item.task, item.round));
    return t("Marked as seen.");
  }));

  let body: Node | null = null;
  if (item.kind === "question") {
    const answer = composer(t("Answer and continue"), true, t("Your answer…"));
    body = h("div", { class: "attn-body" }, h("p", { class: "attn-question" }, item.question ?? t("The agent is waiting for your input.")), answer.form);
  } else {
    if (item.summary) body = h("p", { class: "attn-summary" }, item.summary);
    if (item.kind === "review") {
      const done = h("button", { type: "button", class: "btn btn-primary btn-small" }, icon("check"), t("Mark done"));
      done.addEventListener("click", () => void run(async () => {
        const task = await currentTask();
        const request = workPatchCommand(task, { status: "done" });
        if (request) await ctx.client.workCommand(request);
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
  card.append(
    h("header", { class: "attn-head" },
      h("span", { class: "attn-icon" }, icon(kind.glyph)),
      h("div", { class: "attn-heading" },
        h("p", { class: "attn-kind" }, t(kind.label)),
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

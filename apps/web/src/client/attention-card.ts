/**
 * 「需要你处理」的一张卡片（ADR 0030、0032）：等你回答 / 等你验收 / 执行失败 / 交接计划的检查点。
 * 今日、任务页和执行详情共用。每个操作都先读任务的当前版本再提交，冲突时说明而不覆盖。
 * 「我自己来」把任务交回给你（原因 todo）：提醒消失，任务仍在你手里。
 * 权限申请（ADR 0049 第 3 节，H1-9）：等你回答且这一轮的结果带 permission 时，卡片换成批准表单：
 * 只能勾选申请里有的项，选择只给下一轮还是这个任务（有计划时为这一步）以后都给；拒绝就写明原因并继续。
 *
 * 汇报：Today 先显示开头几行，「展开完整汇报」就地读出全文，操作按钮始终紧跟在汇报下面；
 * 任务详情直接显示全文，决定按钮放进详情底部固定的栏里，与讨论输入框在一起，滚到哪里都能决定。
 */
import type { Job, WorkAttention } from "@lumio/schema";
import { errorText, isConflict, type Client, type HubExtras } from "./api.ts";
import { answerCommand, engineTargets, formatTime, grantCommand, itemsPermission, newRequestId, permissionItemLabel, permissionItems, type PermissionItem } from "./commands.ts";
import type { StagePermissions } from "@lumio/schema";
import { helperMissingNotice } from "./privileged-helper.ts";
import { agentStages, checkpointCommand, type CheckpointAction } from "./plan.ts";
import { finishCommand, handCommand } from "./turn.ts";
import { autosize, clear, failure, h, icon, openMenu, select, toast } from "./dom.ts";
import { speechButton } from "./speech-input.ts";
import { ago } from "./format.ts";
import { textDraft } from "./drafts.ts";
import { t } from "./i18n.ts";
import type { Navigate } from "./navigation.ts";
import { renderMarkdown } from "./utils/markdown.ts";

export interface AttentionContext {
  client: Client;
  hub: HubExtras;
  navigate: Navigate;
  /** 处理完成后调用：调用方刷新列表或页面。 */
  changed(): void;
  /** Today：展开了完整汇报的卡片（按轮次记），重画后保持展开。 */
  expanded?: Set<string>;
  /**
   * 任务详情：决定按钮放进底部固定栏 bar；需要写字的回答、意见与带修改重试交给讨论输入框（reply 聚焦它）。
   * 没有可继续的 agent 时不要传，卡片退回自带输入框的形式。
   */
  docked?: { bar: HTMLElement; reply(kind: WorkAttention["kind"]): void };
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
  const card = h("article", { class: `attn attn-${kind.tone}`, "data-pad-row": `round:${item.task}:${item.round}:${item.stage ?? ""}`, tabindex: "0", "data-task": item.task, "data-round": String(item.round) });
  const docked = where === "task" ? ctx.docked : undefined;
  const status = h("div", { role: "status", class: "attn-status" });
  const error = h("div", { role: "alert" });
  const actions = h("div", { class: "attn-actions" });
  let busy = false;

  const run = async (work: () => Promise<string>) => {
    if (busy) return;
    busy = true; card.classList.add("is-busy"); docked?.bar.classList.add("is-busy"); clear(error);
    try {
      const done = await work();
      clear(card, h("p", { class: "attn-done" }, icon("check"), done));
      card.classList.add("is-done");
      if (docked) clear(docked.bar);
      ctx.changed();
    } catch (cause) {
      clear(error, failure(isConflict(cause) ? t("This task changed since this card was shown. Refresh and try again.") : errorText(cause)));
    } finally { busy = false; card.classList.remove("is-busy"); docked?.bar.classList.remove("is-busy"); }
  };
  /** 交给讨论输入框写字（只在任务详情里）。 */
  const reply = docked ? () => docked.reply(item.kind) : undefined;
  const currentTask = async () => (await ctx.client.workTask(item.task)).task;

  // 回答框：等你回答时直接显示；验收与失败时点按钮后展开。
  const composer = (button: string, required: boolean, placeholder: string) => {
    const text = autosize(h("textarea", { rows: "2", placeholder, "aria-label": placeholder }));
    const capture = textDraft(text, `answer:${item.task}:${item.round}`);
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
    const submit = h("button", { type: "submit", class: "btn btn-primary btn-small", "data-pad-action": "primary" }, icon("send"), button);
    const form = h("form", { class: "attn-composer", "data-pad-input": "answer" }, text, h("div", { class: "attn-composer-foot" }, chip, speechButton(text), submit));
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
        text.value = ""; capture();
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
    const go = h("button", { type: "button", class: "btn btn-primary btn-small", "data-pad-action": "primary" }, icon("play"), t("Continue"));
    go.addEventListener("click", () => decide("continue", t("Continuing with the next step.")));
    const finish = h("button", { type: "button", class: `btn btn-small${end ? " btn-primary" : ""}`, "data-pad-action": end ? "primary" : "finish" }, icon("check"), t("Mark done"));
    finish.addEventListener("click", () => decide("finish", t("Task marked done.")));
    const hold = h("button", { type: "button", class: "btn btn-quiet btn-small", "data-pad-action": "hold" }, icon("pause"), t("Put on hold"));
    hold.addEventListener("click", () => decide("hold", t("Put on hold.")));
    const back = h("button", { type: "button", class: "btn btn-small", "data-pad-action": "reject" }, icon("undo"), t("Send back…"));
    back.addEventListener("click", () => void (async () => {
      try {
        const task = await currentTask();
        const stages = task.plan ? agentStages(task.plan.plan) : [];
        if (!stages.length) { clear(error, failure(t("This task no longer has a plan. Refresh and try again."))); return; }
        const to = select("back-to", stages.map(value => [value.id, t("{0} ({1})", value.id, value.agent)] as [string, string]), stages.at(-2)?.id ?? stages[0]!.id);
        const text = autosize(h("textarea", { rows: "2", placeholder: t("What should change?"), "aria-label": t("What should change?") }));
        textDraft(text, `checkpoint:${item.task}:${stage}`);
        const send = h("button", { type: "submit", class: "btn btn-primary btn-small", "data-pad-action": "primary" }, icon("undo"), t("Send back"));
        const form = h("form", { class: "attn-composer", "data-pad-input": "answer" }, text, h("div", { class: "attn-composer-foot" }, h("label", { class: "attn-back" }, t("Back to"), to), speechButton(text), send));
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

  let body: HTMLElement | null = null;
  const question = (source: string) => {
    const content = h("div", { class: "attn-question markdown" });
    content.innerHTML = renderMarkdown(source);
    return content;
  };
  // 读这一轮的 Job：完整汇报、权限申请与管理员助手提示都来自它（读取失败时保持摘要）。
  const job = ctx.client.job(item.job);
  job.catch(() => undefined);
  if (item.kind === "question") {
    if (reply) {
      const answer = h("button", { type: "button", class: "btn btn-primary btn-small", "data-pad-action": "primary" }, icon("send"), t("Answer…"));
      answer.addEventListener("click", reply);
      actions.append(answer, seen);
      body = h("div", { class: "attn-body" }, question(item.question ?? t("The agent is waiting for your input.")));
    } else {
      const answer = composer(t("Answer and continue"), true, t("Your answer…"));
      body = h("div", { class: "attn-body" }, question(item.question ?? t("The agent is waiting for your input.")), answer.form);
    }
  } else {
    const report = reportView(item, job, where === "today" ? ctx.expanded ?? new Set() : undefined);
    body = report || item.prompt ? h("div", { class: "attn-body" }, report, item.prompt ? question(item.prompt) : null) : null;
    if (item.kind === "review" && (item.prompt || item.stage === "end")) checkpoint(item.stage!);
    else if (item.kind === "review") {
      const done = h("button", { type: "button", class: "btn btn-primary btn-small", "data-pad-action": "primary" }, icon("check"), t("Mark done"));
      done.addEventListener("click", () => void run(async () => {
        await ctx.client.workCommand(finishCommand(await currentTask(), "done"));
        return t("Task marked done.");
      }));
      const feedback = h("button", { type: "button", class: "btn btn-small", "data-pad-action": "reject" }, icon("edit"), t("Add feedback and continue"));
      feedback.addEventListener("click", () => {
        if (reply) { reply(); return; }
        const next = composer(t("Send and continue"), true, t("What should change in the next round?"));
        actions.replaceWith(next.form); next.focus();
      });
      actions.append(done, feedback, seen);
    } else if (reply) {
      // 任务详情：直接重试交给原来的 agent；要改点什么就在下面的输入框写，再「交给 … 继续」。
      const retry = h("button", { type: "button", class: "btn btn-primary btn-small", "data-pad-action": "primary" }, icon("refresh"), t("Retry"));
      retry.addEventListener("click", () => void run(async () => {
        const task = await currentTask();
        await ctx.client.workCommand({ request_id: newRequestId(), operation: { op: "work.task.dispatch", args: { task: task.id, ...(item.agent ? { to: item.agent } : {}), expected_revision: task.revision } } });
        const who = item.agent ?? t("the agent");
        toast(t("Dispatched to {0}", who));
        return t("Sent. {0} is continuing.", who);
      }));
      const change = h("button", { type: "button", class: "btn btn-small", "data-pad-action": "reject" }, icon("edit"), t("Retry with changes…"));
      change.addEventListener("click", reply);
      actions.append(retry, change, seen);
    } else {
      const retry = h("button", { type: "button", class: "btn btn-small", "data-pad-action": "primary" }, icon("refresh"), t("Retry"));
      retry.addEventListener("click", () => {
        const next = composer(t("Retry"), false, t("Optional: anything to change this time?"));
        actions.replaceWith(next.form); next.focus();
      });
      actions.append(retry, seen);
    }
  }

  /** 权限申请：理由取自汇报（agent 在申请前写明为什么需要）。 */
  function permissionRequest(requested: StagePermissions, reason?: string): HTMLElement {
    const items = permissionItems(requested);
    const boxes = items.map(value => ({ value, box: h("input", { type: "checkbox", checked: true, name: `grant-${value}` }) }));
    const scope = select("grant-scope", [["next_round", t("Only the next round")], ["task", planned ? t("This step, from now on") : t("This task, from now on")]], "next_round");
    const approve = h("button", { type: "submit", class: "btn btn-primary btn-small", "data-pad-action": "primary", "data-pad-hold": requested.access === "full" }, icon("check"), t("Approve and continue"));
    for (const { box } of boxes) box.addEventListener("change", () => {
      approve.toggleAttribute("data-pad-hold", boxes.some(({ value, box }) => value === "full" && box.checked));
    });
    const refuse = h("button", { type: "button", class: "btn btn-small", "data-pad-action": "reject" }, icon("close"), t("Refuse…"));
    const form = h("form", { class: "attn-composer attn-grant" },
      h("p", { class: "attn-grant-title" }, t("{0} is asking for:", item.agent ?? t("The agent"))),
      h("ul", { class: "attn-grant-items" }, ...boxes.map(({ value, box }) => h("li", {}, h("label", { class: "check-field" }, box, h("span", {}, permissionItemLabel(value)))))),
      h("label", { class: "attn-back" }, t("For"), scope),
      h("p", { class: "field-hint" }, t("Approving continues the same session with the new permission. Choose only what you are comfortable with.")),
      h("div", { class: "attn-composer-foot" }, refuse, approve));
    let requestId = newRequestId(), previous = "";
    form.addEventListener("submit", event => {
      event.preventDefault();
      const chosen = boxes.filter(({ box }) => box.checked).map(({ value }) => value) as PermissionItem[];
      if (!chosen.length) { clear(error, failure(t("Choose at least one permission, or refuse."))); return; }
      const key = `${chosen.join(",")}|${scope.value}`;
      if (previous && previous !== key) requestId = newRequestId();
      previous = key;
      void run(async () => {
        await ctx.client.workCommand(grantCommand(await currentTask(), itemsPermission(chosen), scope.value as "next_round" | "task", requestId));
        toast(t("Permission approved"));
        return t("Approved. {0} is continuing with the new permission.", item.agent ?? t("the agent"));
      });
    });
    refuse.addEventListener("click", () => {
      const next = composer(t("Refuse and continue"), true, t("Why not, and what should it do instead?"));
      form.replaceWith(next.form); next.focus();
    });
    return h("div", { class: "attn-body" }, reason ? question(reason) : null, form);
  }

  // 读这一轮的结果：带权限申请时换成批准表单；机器没装管理员助手时附上安装提示（读取失败时保持原样）。
  void job.then(job => {
    const missing = job.result?.privileged_unavailable;
    if (missing) {
      const notice = helperMissingNotice(item.agent, missing.program);
      if (body && card.contains(body)) body.after(notice);
      else if (card.contains(actions)) actions.before(notice);
    }
    const requested = item.kind === "question" && job.status === "waiting_for_human" ? job.result?.permission : undefined;
    if (!requested || !body || !card.contains(body)) return;
    const next = permissionRequest(requested, job.result?.report);
    body.replaceWith(next); body = next;
    label.textContent = t("Asking for permission");
    // 批准表单在卡片里；底部栏只留一句指引。
    if (docked) clear(docked.bar, h("p", { class: "attn-bar-hint" }, t("Approve or refuse the request above.")));
  }, () => undefined);

  const meta = [t("Round {0}", item.round), item.agent, ago(item.since)].filter(Boolean).join(t(" · "));
  const label = h("p", { class: "attn-kind" }, item.kind === "review" && item.prompt ? t("Checkpoint") : item.kind === "review" && item.stage === "end" ? t("Plan finished · ready for your review") : t(kind.label));
  if (docked) {
    // 底部固定栏：这件事是什么 + 决定按钮。卡片里只留内容。
    docked.bar.setAttribute("data-pad-row", `round-bar:${item.task}:${item.round}:${item.stage ?? ""}`);
    clear(docked.bar, h("div", { class: "attn-bar-head" }, h("span", { class: `attn-bar-icon attn-${kind.tone}` }, icon(kind.glyph)),
      h("span", { class: "attn-bar-label" }, label.textContent), h("span", { class: "attn-bar-meta" }, meta)), actions, error);
  }
  card.append(
    h("header", { class: "attn-head" },
      h("span", { class: "attn-icon" }, icon(kind.glyph)),
      h("div", { class: "attn-heading" },
        label,
        where === "today" ? h("button", { type: "button", class: "attn-title", "data-pad-action": "detail", onclick: () => ctx.navigate("work", item.task) }, item.title) : null,
        h("p", { class: "attn-meta", title: formatTime(item.since) }, meta)),
      where !== "job" ? h("button", { type: "button", class: "text-btn attn-report", "data-pad-action": "detail", onclick: () => ctx.navigate("execution", item.job) }, t("View run")) : null),
    ...[body as Node | null, docked || item.kind === "question" && !reply ? null : actions, status, docked ? null : error].filter((node): node is Node => node !== null));
  return card;
}

/** Hub 给的摘要最多 500 个字符；到了这个长度说明后面还有。 */
const SUMMARY_LIMIT = 500;

/**
 * 汇报：expanded 给出时（Today）先显示第一段（agent 被要求先写结论，PR #244），后面还有内容时可就地展开全文并记住；
 * 不给时（任务详情、执行详情）直接显示全文。全文来自这一轮的 Job；读取失败或没有全文时保留摘要。
 * 检查点的摘要就是给人的提示（已单独显示），这时不重复摘要，只提供展开这一轮的汇报。
 */
function reportView(item: WorkAttention, job: Promise<Job>, expanded?: Set<string>): HTMLElement | null {
  const key = `${item.task}:${item.round}`;
  const summary = item.summary && item.summary !== item.prompt ? item.summary.trim() : "";
  const lead = summary.split(/\n\s*\n/)[0]!.trim();
  const full = h("div", { class: "attn-report-full markdown" });
  const short = lead ? h("div", { class: "attn-summary markdown" }) : null;
  if (short) short.innerHTML = renderMarkdown(lead);
  const fill = (value: Job) => {
    const text = value.result?.report || value.result?.error;
    if (!text) return false;
    full.innerHTML = renderMarkdown(text);
    return true;
  };
  if (!expanded) {
    full.hidden = true;
    void job.then(value => {
      if (!fill(value)) return;
      if (short) short.replaceWith(full);
      full.hidden = false;
    }, () => undefined);
    return short ? h("div", { class: "attn-digest" }, short) : full;
  }
  const more = !short || lead.length < summary.length || summary.length >= SUMMARY_LIMIT;
  const host = h("div", { class: "attn-digest" }, short);
  if (!more) return host;
  const toggle = h("button", { type: "button", class: "text-btn attn-expand", "aria-expanded": "false" }, t("Read full report"));
  let filled = false, shown = false;
  const show = async (open: boolean) => {
    if (open) {
      toggle.disabled = true;
      try { filled ||= fill(await job); }
      catch { toggle.disabled = false; return; }
      toggle.disabled = false;
      // 没有全文（旧 Runtime 或只有摘要）：摘要就是全部，不再提供展开。
      if (!filled) { toggle.hidden = true; return; }
      if (short) short.replaceWith(full); else toggle.before(full);
      expanded.add(key);
    } else {
      if (short) full.replaceWith(short); else full.remove();
      expanded.delete(key);
    }
    shown = open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? t("Show less") : t("Read full report");
  };
  toggle.addEventListener("click", () => void show(!shown));
  host.append(toggle);
  if (expanded.has(key)) void show(true);
  return host;
}

/** 按任务查当前的提醒（任务页、执行详情用）；旧 Hub 没有接口时返回 undefined。 */
export async function attentionFor(hub: HubExtras, task: string): Promise<WorkAttention | undefined> {
  return (await hub.attention())?.find(item => item.task === task);
}

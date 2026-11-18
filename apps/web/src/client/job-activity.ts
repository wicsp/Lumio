import type { JobAction, JobActivityEvent, JobActivityRecord, JobLiveView } from "@lumio/schema";
import { errorText, type Client } from "./api.ts";
import { confirmDialog, clear, h } from "./dom.ts";
import { formatTime, newRequestId } from "./commands.ts";
import { ago } from "./format.ts";
import { t } from "./i18n.ts";

const phases = {
  preparing: "Preparing execution", before_hook: "Running the before hook", engine: "Agent running",
  after_hook: "Running the after hook", finishing: "Finishing execution",
};
const actions = {
  queued: "Waiting to deliver", delivered: "Sent to the Runtime", applied: "Applied by the agent",
  rejected: "Decision rejected", expired: "Decision expired", unknown: "Decision outcome unknown",
};
const events = {
  started: "Agent started", responded: "Agent responded", plan_updated: "Agent updated its plan", retrying: "Agent is retrying",
};
const closed = {
  answered: "Answer sent", approved: "Approval sent", denied: "Request declined", expired: "Request expired",
  cancelled: "Request stopped", unknown: "Request outcome unknown",
};
const toolStates = { completed: "Finished {0}", failed: "Failed {0}", declined: "Declined {0}", unknown: "Outcome unknown for {0}" };
const isLive = (view: JobLiveView) => ["queued", "assigned", "running"].includes(view.status);

export function jobActivitySummary(view: JobLiveView): string {
  if (view.stop_requested) return t("Waiting for the Runtime to confirm it stopped");
  if (view.connected === false) return [t("Runtime disconnected"),
    view.last_heartbeat ? t("Last heartbeat {0}", ago(view.last_heartbeat)) : null].filter(Boolean).join(" · ");
  if (view.pending) return t("Waiting for you");
  if (view.connected && !view.phase && !view.started && !view.last_heartbeat
    && (view.status === "queued" || view.status === "assigned")) return t("Waiting to run");
  const tool = view.active_tools.at(-1);
  const parts = [
    tool ? t("Running {0}", tool.label) : view.phase ? t(phases[view.phase]) : view.assigned ? t("Runtime received the run")
      : view.status === "queued" ? t("Waiting for the Runtime") : t("Activity details unavailable"),
    view.started && isLive(view) ? t("Started {0}", ago(view.started)) : null,
    view.last_activity ? t("Last activity {0}", ago(view.last_activity)) : null,
    view.last_heartbeat && isLive(view) ? t("Last heartbeat {0}", ago(view.last_heartbeat)) : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function eventText(event: JobActivityEvent) {
  switch (event.type) {
    case "phase": return t(phases[event.phase]);
    case "tool_started": return t("Started {0}", event.tool.label);
    case "tool_finished": return t(toolStates[event.outcome], event.tool.label);
    case "engine": return t(events[event.activity]);
    case "error": return t("Agent activity error");
    case "omitted": return t("Some activity was omitted");
    case "request_opened": return t("Agent requested your input");
    case "request_closed": return t(closed[event.outcome]);
  }
}
function timelineRow(record: JobActivityRecord) {
  const { event } = record;
  const files = event.type === "tool_finished" || event.type === "tool_started" ? event.tool.files : undefined;
  return h("li", { class: "job-activity-event" }, h("time", { datetime: event.at }, formatTime(event.at)),
    h("div", {}, eventText(event), files?.length ? h("ul", {}, ...files.map(path => h("li", { class: "mono" }, path))) : null));
}

export function jobActivityBadge(client: Client, job: string, initial: string): HTMLElement {
  const badge = h("span", { class: "job-activity-badge" }, initial);
  const poll = async () => {
    if (!badge.isConnected) return;
    if (document.visibilityState === "hidden" || badge.closest("[hidden]")) {
      setTimeout(poll, 2000);
      return;
    }
    try {
      const view = await client.jobLive(job);
      if (!badge.isConnected) return;
      badge.textContent = jobActivitySummary(view);
      if (isLive(view)) setTimeout(poll, 2000);
    } catch { /* leave the ordinary job state visible on an older Hub */ }
  };
  queueMicrotask(poll);
  return badge;
}

export function jobActivityPanel(client: Client, job: string, workdir: string, engine: string): HTMLElement {
  const state = h("p", { class: "muted", role: "status" });
  const notices = h("p", { class: "muted", hidden: true });
  const controls = h("div", { class: "job-activity-controls" });
  const log = h("ol", { class: "job-activity-timeline" });
  const element = h("section", { class: "section job-activity" }, h("div", { class: "section-head" }, h("h3", {}, t("Run activity"))),
    state, notices, controls, log);
  let after = 0, controlKey = "", busy = false, lastState = "", failed = 0, finishedPolls = 0;
  let lastSubmission: { payload: string; id: string } | undefined;
  const noticesText = (message: string) => { notices.textContent = message; notices.hidden = !message; };

  function renderControls(view: JobLiveView) {
    const prompt = view.pending;
    const key = JSON.stringify([view.target, prompt?.id, view.capability?.steer, view.receipts, view.stop_requested]);
    if (controlKey === key || busy) return;
    controlKey = key;
    const receipt = view.receipts[0];
    const waiting = view.receipts.some(r => r.state === "queued" || r.state === "delivered");
    const receiptLine = receipt ? h("p", { class: "muted", role: "status" }, t(actions[receipt.state])) : null;
    if ((!prompt && !(view.target && view.capability?.steer)) || view.stop_requested) { clear(controls, receiptLine); return; }
    const target = prompt?.target ?? view.target!;
    const issue = h("p", { role: "alert", class: "muted", hidden: true });
    let submitting = false;
    const submit = async (action: JobAction) => {
      if (submitting || waiting) return;
      const { request_id: _id, ...body } = action;
      const payload = JSON.stringify(body);
      if (lastSubmission?.payload !== payload) lastSubmission = { payload, id: action.request_id };
      submitting = busy = true;
      controls.querySelectorAll("button").forEach(button => button.disabled = true);
      issue.hidden = true;
      try {
        const r = await client.jobAction(job, { ...action, request_id: lastSubmission.id });
        issue.textContent = t(actions[r.state]);
        issue.hidden = false;
      } catch (cause) {
        issue.textContent = errorText(cause);
        issue.hidden = false;
        controls.querySelectorAll("button").forEach(button => button.disabled = false);
      } finally { busy = submitting = false; }
    };
    const button = (label: string, click: () => void) => h("button", { type: "button", class: "btn btn-small", disabled: waiting, onclick: click }, t(label));
    if (prompt?.kind === "approval") {
      const deny = button("Decline", () => void submit({ action: "deny", target, prompt_id: prompt.id, request_id: newRequestId() }));
      const approve = button("Approve once", () => void (async () => {
        if (!await confirmDialog({ title: t("Approve this tool once?"), message: prompt.preview, confirm: t("Approve once") })) return;
        await submit({ action: "approve", target, prompt_id: prompt.id, request_id: newRequestId() });
      })());
      clear(controls, h("div", { class: "notice job-activity-request" }, h("div", {},
        h("strong", {}, t("Waiting for your approval")), h("p", {}, [engine, prompt.tool, workdir, prompt.sandbox === "os" ? t("OS sandbox") : t("No sandbox")].join(" · ")),
        h("pre", { class: "code-block" }, prompt.preview), prompt.reason ? h("p", {}, prompt.reason) : null,
        h("p", { class: "muted" }, t("Expires at {0}", formatTime(prompt.expires))),
        h("div", { class: "button-row" }, prompt.can_approve ? approve : null, deny), receiptLine, issue)));
      return;
    }
    if (prompt?.kind === "question") {
      const form = h("form", { class: "form-stack" });
      const read: (() => string[])[] = [];
      for (const question of prompt.questions) {
        if (question.options.length) {
          const fields = question.options.map(option => h("input", { type: question.multiple ? "checkbox" : "radio", name: question.id, value: option }));
          form.append(h("fieldset", {}, h("legend", {}, question.text), ...fields.map((input, i) => h("label", { class: "check-field" }, input, question.options[i]!))));
          read.push(() => fields.filter(input => input.checked).map(input => input.value));
        } else {
          const field = h("textarea", { rows: 2, maxlength: 2000, required: true });
          form.append(h("label", {}, h("span", {}, question.text), field));
          read.push(() => [field.value.trim()].filter(Boolean));
        }
      }
      form.append(h("div", { class: "button-row" }, h("button", { class: "btn btn-primary btn-small", type: "submit", disabled: waiting }, t("Answer agent")),
        button("Decline", () => void submit({ action: "deny", target, prompt_id: prompt.id, request_id: newRequestId() }))));
      form.addEventListener("submit", e => {
        e.preventDefault();
        const answers = prompt.questions.map((question, i) => ({ question: question.id, values: read[i]!() }));
        if (answers.some(answer => !answer.values.length)) {
          issue.textContent = t("Answer every question"); issue.hidden = false; return;
        }
        void submit({ action: "answer", target, prompt_id: prompt.id, answers, request_id: newRequestId() });
      });
      clear(controls, h("div", { class: "notice job-activity-request" }, h("div", {}, h("strong", {}, t("Agent has a question")),
        h("p", { class: "muted" }, t("Expires at {0}", formatTime(prompt.expires))), form, receiptLine, issue)));
      return;
    }
    const text = h("textarea", { rows: 2, maxlength: 4000, required: true, "aria-label": t("Send a correction") });
    const form = h("form", { class: "form-stack" }, h("label", {}, h("span", {}, t("Send a correction")), text),
      h("button", { type: "submit", class: "btn btn-small", disabled: waiting }, t("Send to current round")), receiptLine, issue);
    form.addEventListener("submit", e => {
      e.preventDefault();
      if (text.value.trim()) void submit({ action: "steer", target, text: text.value.trim(), request_id: newRequestId() });
    });
    clear(controls, form);
  }

  const poll = async () => {
    if (!element.isConnected) return;
    if (document.visibilityState === "hidden" || element.closest("[hidden]")) { setTimeout(poll, 1500); return; }
    let interval = 1250;
    try {
      const live = await client.jobLive(job);
      const page = await client.jobEvents(job, { after });
      if (!element.isConnected) return;
      failed = 0;
      const summary = jobActivitySummary(live);
      if (lastState !== summary) { state.textContent = summary; lastState = summary; }
      if (page.gap) { clear(log); noticesText(t("Earlier activity is no longer available")); }
      if (page.events.length) {
        const rows = page.events.map(timelineRow).reverse();
        log.prepend(...rows);
        while (log.childElementCount > 200) log.lastElementChild?.remove();
      }
      after = page.next_after;
      renderControls(live);
      if (page.has_more) interval = 0;
      else if (!isLive(live) && ++finishedPolls > 3) return;
    } catch (cause) {
      if (++failed === 1) state.textContent = t("Activity details unavailable");
      if (cause && typeof cause === "object" && "status" in cause && cause.status === 404) return;
      interval = 3000;
    }
    if (element.isConnected) setTimeout(poll, interval);
  };
  queueMicrotask(poll);
  return element;
}

/**
 * 任务 / 项目详情。
 * - 属性：点一下就改，立即带 revision 保存；冲突时不覆盖，提示载入最新内容。
 * - 标题、正文、讨论各自独立保存；正文默认显示渲染结果，点击进入编辑。
 * - 派活是单独的明确动作；修改负责人不会派活；运行成功也不会自动完成任务。
 */
import { PROJECT_STATUSES, TASK_STATUSES, type WorkProject, type WorkTask, type WorkTaskDetail, type WorkCommandRequest } from "@lumio/schema";
import { errorText, isConflict, type Client, type HubExtras } from "../api.ts";
import { attentionCard, attentionFor } from "../attention-card.ts";
import { commentCommand, dispatchCommand, engineTargets, formatTime, newRequestId, workPatchCommand } from "../commands.ts";
import { autosize, clear, failure, field, h, icon, openDialog, openMenu, select, statusIcon, toast, type MenuItem } from "../dom.ts";
import { ago, assigneeLabel, dateInputValue, dueLabel, isoFromDateInput } from "../format.ts";
import { PROJECT_LABELS, TASK_LABELS } from "../labels.ts";
import { renderMarkdown } from "../utils/markdown.ts";
import { InlineTitle } from "../inline-title.ts";
import type { Navigate } from "../navigation.ts";
import { t, tParts } from "../i18n.ts";

export type EditableWork = WorkTask | WorkProject;
const BARE_AGENTS = ["pi", "codex", "claude-code"];

export interface EditorHooks {
  changed(): void;
  reload(): void;
  back(): void;
  navigate: Navigate;
  openProject(id: string): void;
}

export class WorkEditor {
  private record: EditableWork;
  private title: InlineTitle;
  private note = h("div", { class: "conflict", role: "alert" });
  private props = h("div", { class: "props" });
  private bodyHost = h("div", {});
  private bodyDraft?: HTMLTextAreaElement;
  private commentDraft?: HTMLTextAreaElement;
  private busy = false;
  private active = true;
  private showAdvanced = false;
  private updated = h("p", { class: "detail-sub" });

  constructor(private root: HTMLElement, private client: Client, private hub: HubExtras, input: WorkProject | WorkTaskDetail, private projects: WorkProject[], private hooks: EditorHooks) {
    this.record = "task" in input ? input.task : input;
    const isTask = this.record.type === "task";
    this.title = new InlineTitle(this.record.title, title => this.saveTitle(title));
    const rec = this.record;
    this.showAdvanced = rec.type === "task" && !!(rec.workdir || rec.model || rec.timeout_minutes);
    const project = rec.type === "task" && rec.project ? projects.find(p => p.id === rec.project) : undefined;
    const crumbs = h("div", { class: "detail-crumbs" },
      h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Back to list"), onclick: () => hooks.back() }, icon("back")),
      isTask ? (project ? h("button", { type: "button", onclick: () => hooks.openProject(project.id) }, icon("folder"), project.title) : h("span", {}, t("No project"))) : h("span", {}, t("Projects")),
      h("div", { class: "detail-actions" },
        h("button", { type: "button", class: "icon-btn", title: t("Copy ID"), "aria-label": t("Copy ID"), onclick: () => void navigator.clipboard?.writeText(this.record.id).then(() => toast(t("ID copied"))) }, icon("link")),
        isTask && h("button", { type: "button", class: "btn btn-primary btn-small", onclick: () => void this.dispatch() }, icon("play"), t("Dispatch"))));

    const attention = h("div", { class: "attn-slot" });
    const detail = h("div", { class: "detail" }, crumbs, h("div", { class: "detail-head" }, this.title.element, this.updated), attention, this.note, this.props,
      h("div", { class: "divider" }), this.bodyHost);
    root.append(detail);
    this.renderMeta();
    this.renderProps();
    this.renderBody();
    if ("task" in input) {
      // 这个任务需要你处理时（ADR 0030），把卡片放在标题下面。
      void attentionFor(hub, input.task.id).then(item => {
        if (item && this.active) attention.append(attentionCard(item, { client, hub, navigate: hooks.navigate, changed: () => { hooks.changed(); hooks.reload(); } }, "task"));
      }).catch(() => { /* 旧 Hub：没有这个接口 */ });
      detail.append(this.executions(input), this.comments(input));
      if (input.task.dependencies.length || input.task.parent) detail.append(h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h3", {}, t("Relationships"))),
        h("p", { class: "muted" }, input.task.parent ? t("Parent task {0}", input.task.parent) : ""),
        input.task.dependencies.length ? h("p", { class: "muted" }, t("Blocked by: {0}", input.task.dependencies.join(t(", ")))) : null));
      if (input.task.references.length) detail.append(h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h3", {}, t("References")), h("span", { class: "count" }, input.task.references.length)),
        h("ul", {}, ...input.task.references.map(ref => h("li", {}, ref.label ?? ref.id)))));
    }
  }

  dispose(): void { this.active = false; }
  get dirty(): boolean {
    return this.title.dirty || (!!this.bodyDraft && this.bodyDraft.value !== this.record.description) || !!this.commentDraft?.value.trim();
  }
  canLeave(): boolean {
    if (this.busy) return false;
    return !this.dirty || confirm(t("You have unsaved changes that will be lost. Leave anyway?"));
  }

  private renderMeta(): void {
    const by = this.record.updated_by;
    this.updated.textContent = t("Updated {0}", ago(this.record.updated)); this.updated.title = formatTime(this.record.updated);
    // 最近修改者（ADR 0029）：agent 改的要让人一眼看出来。
    if (by) void actorName(this.client, by).then(name => {
      if (name && this.active && this.record.updated_by === by) this.updated.textContent = t("Updated {0} by {1}", ago(this.record.updated), name);
    });
  }

  // ───────────── 属性 ─────────────

  private renderProps(): void {
    const r = this.record;
    const rows: Node[] = [];
    const row = (label: string, iconName: string, value: Node) => rows.push(h("div", { class: "prop-label" }, icon(iconName), label), h("div", { class: "prop-value" }, value));
    const labels = r.type === "task" ? TASK_LABELS : PROJECT_LABELS;

    const statusBtn = h("button", { type: "button", class: "prop-btn" }, statusIcon(r.status), h("span", {}, labels[r.status] ?? r.status));
    statusBtn.addEventListener("click", () => openMenu(statusBtn,
      (r.type === "task" ? TASK_STATUSES : PROJECT_STATUSES).map(s => ({ value: s, label: labels[s]!, icon: statusIcon(s), selected: s === r.status })),
      value => void this.patch({ status: value }, statusBtn, t("Status changed to “{0}”", labels[value]))));
    row(t("Status"), "clock", statusBtn);

    if (r.type === "task") {
      const who = h("button", { type: "button", class: "prop-btn", title: t("Changing the assignee doesn't dispatch anything") }, icon(r.assignee === "human" ? "user" : "bot"), h("span", {}, assigneeLabel(r.assignee)));
      who.addEventListener("click", () => void this.pickAssignee(who));
      row(t("Assignee"), "user", who);

      const project = this.projects.find(p => p.id === r.project);
      const projectBtn = h("button", { type: "button", class: `prop-btn${project ? "" : " placeholder-value"}` }, icon("folder"), h("span", {}, project?.title ?? t("None")));
      projectBtn.addEventListener("click", () => openMenu(projectBtn,
        [{ value: "", label: t("No project"), selected: !r.project }, ...this.projects.map(p => ({ value: p.id, label: p.title, icon: icon("folder"), selected: p.id === r.project }))],
        value => void this.patch({ project: value || null }, projectBtn, t("Project updated")), { filter: this.projects.length > 6, placeholder: t("Find a project") }));
      row(t("Project"), "folder", projectBtn);
      row(t("Due"), "calendar", this.dateInput("due", r.due));

      if (this.showAdvanced) {
        row(t("Working directory"), "terminal", this.textInput("workdir", r.workdir, t("~ (runtime's home directory)")));
        row(t("Model"), "bot", this.textInput("model", r.model, t("Use the engine's default model")));
        row(t("Time limit"), "clock", this.textInput("timeout_minutes", r.timeout_minutes?.toString(), t("120 minutes"), "number"));
      } else rows.push(h("button", { type: "button", class: "text-btn advanced-toggle", onclick: () => { this.showAdvanced = true; this.renderProps(); } }, t("+ Run settings (working directory, model, time limit)")));
    } else {
      row(t("Goal"), "check", this.textInput("goal", r.goal, t("What should this phase achieve?")));
      row(t("Due"), "calendar", this.dateInput("deadline", r.deadline));
      row(t("Repository"), "link", this.textInput("repo", r.repo, t("Path or URL")));
    }
    if (r.tags.length) row(t("Tags"), "more", h("span", { class: "button-row" }, ...r.tags.map(tag => h("span", { class: "pill" }, tag))));
    clear(this.props, ...rows);
  }

  private textInput(key: string, value: string | undefined, placeholder: string, type = "text"): HTMLInputElement {
    const input = h("input", { class: "prop-input", name: `prop-${key}`, type, placeholder, autocomplete: "off", ...(type === "number" ? { min: "1", step: "1" } : {}) });
    input.value = value ?? "";
    const commit = () => {
      const raw = input.value.trim();
      const next = !raw ? null : type === "number" ? Number(raw) : raw;
      if (type === "number" && next !== null && (!Number.isInteger(next) || (next as number) < 1)) { toast(t("Enter a whole number of minutes"), "error"); input.value = value ?? ""; return; }
      void this.patch({ [key]: next }, input, t("Saved"));
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); input.blur(); }
      if (event.key === "Escape") { input.value = value ?? ""; input.blur(); }
    });
    return input;
  }

  private dateInput(key: "due" | "deadline", value: string | undefined): HTMLElement {
    const input = h("input", { class: "prop-input", type: "date", name: `prop-${key}` });
    input.value = dateInputValue(value);
    input.addEventListener("change", () => void this.patch({ [key]: isoFromDateInput(input.value) }, input, input.value ? t("Due date set") : t("Due date cleared")));
    const due = dueLabel(value);
    return h("span", { class: "button-row" }, input, due?.overdue && this.record.status !== "done" ? h("span", { class: "pill pill-red" }, t("Overdue")) : null);
  }

  private async pickAssignee(anchor: HTMLElement): Promise<void> {
    if (this.record.type !== "task") return;
    const current = this.record.assignee;
    const items: MenuItem[] = [{ value: "human", label: t("Me"), icon: icon("user"), selected: current === "human" }];
    const seen = new Set(["human"]);
    const add = (value: string, hint?: string) => { if (seen.has(value)) return; seen.add(value); items.push({ value, label: value, hint, icon: icon("bot"), selected: current === value }); };
    try {
      for (const target of engineTargets(await this.client.runtimes())) add(target.target, target.online ? undefined : t("Offline"));
    } catch { /* 执行器列表暂不可用时，仍可选择本机 agent */ }
    for (const agent of BARE_AGENTS) add(agent, t("on the Hub's device"));
    add(current);
    if (!this.active || !anchor.isConnected) return;
    openMenu(anchor, items, value => void this.patch({ assignee: value }, anchor, value === "human" ? t("Assigned to you") : t("Assigned to {0} (not dispatched yet)", value)), { filter: true, placeholder: t("Find a runtime") });
  }

  private async patch(patch: Record<string, unknown>, control: HTMLElement, done: string): Promise<void> {
    if (this.busy) return;
    const request = workPatchCommand(this.record, patch);
    if (!request) return;
    this.setBusy(true); control.classList.add("prop-saving");
    try {
      await this.commit(request);
      toast(done);
    } catch (cause) {
      this.showFailure(cause);
    } finally {
      control.classList.remove("prop-saving");
      this.setBusy(false);
      if (this.active) this.renderProps();
    }
  }

  private async commit(request: WorkCommandRequest): Promise<void> {
    clear(this.note);
    const result = await this.client.workCommand(request);
    if (result.kind !== "task" && result.kind !== "project") throw new Error("unexpected result");
    this.record = result.kind === "task" ? result.task : result.project;
    this.renderMeta();
    this.hooks.changed();
  }

  private setBusy(value: boolean): void { this.busy = value; this.title.setBusy(value); }

  private showFailure(cause: unknown): void {
    const text = isConflict(cause) ? t("This was updated somewhere else, and your changes didn't overwrite it. Download your draft, then load the latest version.") : t("{0} Your changes are still on the page; if the connection dropped, check whether they were saved.", errorText(cause));
    clear(this.note, failure(text), h("div", { class: "button-row" },
      h("button", { type: "button", class: "btn btn-small", onclick: () => this.exportDraft() }, icon("download"), t("Download draft")),
      h("button", { type: "button", class: "btn btn-small", onclick: () => {
        if (!this.dirty || confirm(t("Loading the latest version discards your unsaved changes. Continue?"))) {
          if (this.bodyDraft) this.bodyDraft.value = this.record.description;
          if (this.commentDraft) this.commentDraft.value = "";
          this.title.discard();
          this.hooks.reload();
        }
      } }, icon("refresh"), t("Load latest"))));
    this.note.scrollIntoView({ block: "nearest" });
  }

  private exportDraft(): void {
    const r = this.record;
    const fields = r.type === "task" ? t("Status: {0}\nAssignee: {1}\nProject: {2}\nWorking directory: {3}\nModel: {4}\nTime limit: {5}", r.status, r.assignee, r.project ?? "", r.workdir ?? "", r.model ?? "", r.timeout_minutes ?? "") : t("Status: {0}\nGoal: {1}", r.status, r.goal ?? "");
    const blob = new Blob([t("# {0}\n\n{1}\n\n---\n{2}\n\nUnposted comment:\n{3}", this.title.value, this.bodyDraft?.value ?? r.description, fields, this.commentDraft?.value ?? "")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    h("a", { href: url, download: `lumio-draft-${r.id}.md` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async saveTitle(title: string): Promise<string> {
    this.setBusy(true);
    try {
      const request = workPatchCommand(this.record, { title });
      if (request) await this.commit(request);
      toast(t("Title saved"));
      return this.record.title;
    } catch (cause) { this.showFailure(cause); throw cause; }
    finally { this.setBusy(false); }
  }

  // ───────────── 正文 ─────────────

  private renderBody(): void {
    if (this.bodyDraft) { this.renderBodyEditor(this.bodyDraft.value); return; }
    const has = this.record.description.trim().length > 0;
    const view = h("div", { class: "body-view markdown", role: "button", tabindex: "0", title: t("Click to edit the description") });
    if (has) view.innerHTML = renderMarkdown(this.record.description); // renderMarkdown 已转义全部原文
    else view.append(h("p", { class: "body-empty" }, t("Add a description: background, approach or definition of done…")));
    view.addEventListener("click", event => { if (!(event.target as Element).closest("a")) this.renderBodyEditor(this.record.description); });
    view.addEventListener("keydown", event => { if (event.key === "Enter" && event.target === view) { event.preventDefault(); this.renderBodyEditor(this.record.description); } });
    clear(this.bodyHost, view);
  }

  private renderBodyEditor(value: string): void {
    const area = this.bodyDraft ?? autosize(h("textarea", { name: "edit-description", placeholder: t("Markdown supported"), "aria-label": t("Description") }));
    area.value = value;
    this.bodyDraft = area;
    const save = h("button", { type: "button", class: "btn btn-primary btn-small", onclick: () => void this.saveBody() }, t("Save"), h("kbd", {}, "⌘↵"));
    const cancel = h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => {
      if (area.value === this.record.description || confirm(t("Discard changes to the description?"))) { this.bodyDraft = undefined; this.renderBody(); }
    } }, t("Cancel"));
    area.onkeydown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void this.saveBody(); }
      if (event.key === "Escape") { event.preventDefault(); cancel.click(); }
    };
    clear(this.bodyHost, h("div", { class: "body-editor" }, area, h("div", { class: "button-row" }, save, cancel, h("span", { class: "field-hint" }, t("Markdown · Esc to cancel")))));
    area.focus();
  }

  private async saveBody(): Promise<void> {
    if (this.busy || !this.bodyDraft) return;
    const description = this.bodyDraft.value;
    if (description === this.record.description) { this.bodyDraft = undefined; this.renderBody(); return; }
    this.setBusy(true);
    try {
      const request = workPatchCommand(this.record, { description });
      if (request) await this.commit(request);
      this.bodyDraft = undefined;
      this.renderBody();
      toast(t("Description saved"));
    } catch (cause) { this.showFailure(cause); }
    finally { this.setBusy(false); }
  }

  // ───────────── 执行 ─────────────

  private executions(input: WorkTaskDetail): HTMLElement {
    const runs = input.executions.slice().sort((a, b) => b.round - a.round);
    return h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h3", {}, t("Execution")), h("span", { class: "count" }, runs.length || ""),
        h("div", { class: "detail-actions" }, h("button", { type: "button", class: "btn btn-small", onclick: () => void this.dispatch() }, icon("play"), runs.length ? t("Next round") : t("Dispatch")))),
      runs.length
        ? h("div", { class: "runs" }, ...runs.map(run => h("button", { type: "button", class: "run", onclick: () => this.hooks.navigate("execution", run.job) },
            statusIcon(run.applied ? "done" : "running"), h("span", { class: "run-round" }, t("Round {0}", run.round)),
            h("span", { class: "muted" }, run.applied ? t("Progress recorded") : t("Waiting for result")),
            h("span", { class: "row-meta" }, h("span", { title: formatTime(run.created) }, ago(run.created)), icon("chevron")))))
        : h("p", { class: "muted" }, t("Not dispatched yet. When you're ready, click Dispatch and choose a runtime for this round. A successful run doesn't complete the task automatically.")));
  }

  private async dispatch(): Promise<void> {
    if (this.record.type !== "task" || this.busy) return;
    if (this.dirty) { clear(this.note, failure(t("Save or cancel your edits before dispatching this round."))); this.note.scrollIntoView({ block: "nearest" }); return; }
    this.setBusy(true);
    try {
      const targets = engineTargets(await this.client.runtimes());
      if (!this.active || !this.root.isConnected) return;
      const task = this.record;
      const preferred = targets.find(t => t.target === task.assignee)?.target ?? targets.find(t => t.online)?.target ?? "";
      const target = select("dispatch-target", [["", t("Choose a runtime and engine")], ...targets.map(x => [x.target, x.label] as [string, string])], preferred);
      target.required = true;
      const formId = `dispatch-${newRequestId()}`, error = h("div", { role: "alert" });
      const form = h("form", { id: formId, class: "form-stack" },
        h("p", {}, ...tParts("“{0}” will be handed to the runtime as currently saved.", h("strong", {}, task.title))),
        field(t("Target"), target),
        h("dl", { class: "meta-grid" }, h("div", {}, h("dt", {}, t("Working directory")), h("dd", {}, task.workdir ?? "~")), h("div", {}, h("dt", {}, t("Time limit")), h("dd", {}, t("{0} min", task.timeout_minutes ?? 120)))),
        !targets.length && h("div", { class: "notice" }, icon("alert"), h("span", {}, t("No device with a registered engine yet. Run lumio runtime add in a terminal to connect one."))),
        error);
      const submit = h("button", { type: "submit", form: formId, class: "btn btn-primary", disabled: !targets.length }, icon("play"), t("Confirm dispatch"));
      const dialog = openDialog(t("Dispatch a new round"), form, [submit]);
      let pending = false, requestId = newRequestId(), previousTarget = "";
      form.addEventListener("submit", async event => {
        event.preventDefault();
        if (pending) return;
        if (previousTarget && previousTarget !== target.value) requestId = newRequestId();
        previousTarget = target.value; pending = true; submit.disabled = true;
        try {
          await this.client.workCommand(dispatchCommand(task, target.value, requestId));
          dialog.close();
          toast(t("Dispatched to {0}", target.value));
          if (this.active) { this.hooks.changed(); this.hooks.reload(); }
        } catch (cause) {
          clear(error, failure(t("{0} Check the runs to see whether it was dispatched.", errorText(cause))));
          submit.disabled = false; pending = false;
        }
      });
    } catch (cause) { if (this.active) this.showFailure(cause); }
    finally { this.setBusy(false); }
  }

  // ───────────── 讨论 ─────────────

  private comments(input: WorkTaskDetail): HTMLElement {
    const entry = (comment: { body: string; created: string }) => {
      const body = h("div", { class: "markdown" });
      body.innerHTML = renderMarkdown(comment.body);
      return h("article", { class: "comment" }, h("span", { class: "comment-avatar", "aria-hidden": "true" }, icon("user")),
        h("div", {}, h("p", { class: "comment-meta", title: formatTime(comment.created) }, ago(comment.created)), body));
    };
    const timeline = h("div", { class: "timeline" }, ...input.comments.map(entry));
    const count = h("span", { class: "count" }, input.comments.length || "");
    const text = autosize(h("textarea", { name: "comment", rows: "1", placeholder: t("Add thoughts, feedback, or questions for the next round…"), "aria-label": t("Discussion") }));
    this.commentDraft = text;
    const error = h("div", { role: "alert" });
    const submit = h("button", { type: "submit", class: "btn btn-primary btn-small" }, t("Comment"));
    const form = h("form", { class: "composer" }, text, h("div", { class: "composer-foot" }, h("span", { class: "hint" }, t("⌘↵ to post · Markdown supported")), submit));
    text.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); form.requestSubmit(); } });
    let requestId = newRequestId(), previous = "";
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (this.busy || !text.value.trim()) return;
      this.setBusy(true); submit.disabled = true; clear(error);
      if (previous && previous !== text.value) requestId = newRequestId();
      previous = text.value;
      try {
        const result = await this.client.workCommand(commentCommand(input.task.id, text.value, requestId));
        if (result.kind !== "comment") throw new Error("unexpected result");
        timeline.append(entry(result.comment));
        count.textContent = String(timeline.childElementCount);
        text.value = ""; text.dispatchEvent(new Event("input"));
        requestId = newRequestId(); previous = "";
      } catch (cause) {
        clear(error, failure(t("{0} Your input is kept; refresh to check whether it was posted.", errorText(cause))));
      } finally { this.setBusy(false); submit.disabled = false; }
    });
    return h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, t("Discussion")), count),
      timeline, form, error);
  }
}

let actorNames: Promise<Map<string, string>> | undefined;
/** 身份 ID → 名称（只读一次；失败时下次再试）。 */
function actorName(client: Client, id: string): Promise<string | undefined> {
  actorNames ??= client.actors().then(list => new Map(list.map(actor => [actor.id, actor.name])), () => { actorNames = undefined; return new Map<string, string>(); });
  return actorNames.then(map => map.get(id));
}

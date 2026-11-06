/**
 * 任务 / 项目详情。
 * - 属性：点一下就改，立即带 revision 保存；冲突时不覆盖，提示载入最新内容。
 * - 标题与正文实时编辑、串行自动保存；讨论保留草稿，显式发布。
 * - 任务没有状态和负责人（ADR 0032）：显示「轮到谁」，用交回 / 完成 / 取消 / 重新打开改变它。
 * - 委派是单独的明确动作；一轮成功也不会自动完成任务。有交接计划时，下一轮交给计划里写明的 agent。
 * - 讨论、轮次和交接记录按时间合并成一条时间线。
 */
import { PROJECT_STATUSES, type WorkProject, type WorkTask, type WorkTaskDetail, type WorkCommandRequest } from "@lumio/schema";
import { errorText, isConflict, type Client, type HubExtras } from "../api.ts";
import { attentionCard, attentionFor } from "../attention-card.ts";
import { answerCommand, commentCommand, dispatchCommand, engineTargets, formatTime, newRequestId, workPatchCommand } from "../commands.ts";
import { autosize, clear, failure, field, h, icon, openDialog, openMenu, select, statusIcon, toast, type MenuItem } from "../dom.ts";
import { ago, dateInputValue, dueLabel, isoFromDateInput } from "../format.ts";
import { PROJECT_LABELS } from "../labels.ts";
import { checkpointCommand, openPlanEditor, planProgress, stageLabel } from "../plan.ts";
import { MessageRail } from "../side-rail.ts";
import { TURN_ACTION_DONE, TURN_ACTION_ICONS, TURN_ACTION_LABELS, TURN_GROUPS, TURN_GROUP_LABELS, reasonLabel, turnActionCommand, turnActions, turnGroup, turnIcon, turnText, type TurnAction } from "../turn.ts";
import { renderMarkdown } from "../utils/markdown.ts";
import { referenceInput } from "../reference-input.ts";
import { WorkSave, type WorkDraft } from "../work-save.ts";
import { drafts, textDraft } from "../drafts.ts";
import type { Navigate } from "../navigation.ts";
import { t, tParts } from "../i18n.ts";

export type EditableWork = WorkTask | WorkProject;

export interface EditorHooks {
  changed(): void;
  reload(): void;
  back(): void;
  navigate: Navigate;
  openProject(id: string): void;
  /** 在这个项目里新建任务（项目页用）。 */
  newTask?(project: string): void;
}

export class WorkEditor {
  private record: EditableWork;
  private title: HTMLTextAreaElement;
  private titleResize?: ResizeObserver;
  private writer: WorkSave;
  private bodyDraft?: HTMLTextAreaElement;
  private disposeBodyReferences?: () => void;
  private disposeReferences?: () => void;
  private store = drafts();
  private recovery: ReturnType<ReturnType<typeof drafts>["claim"]>;
  private timer?: ReturnType<typeof setTimeout>;
  private saveStatus = h("div", { class: "note-save-status work-save-status", role: "status", hidden: true });
  private note = h("div", { class: "conflict", role: "alert" });
  private props = h("div", { class: "props" });
  private bodyHost = h("div", {});
  private commentDraft?: HTMLTextAreaElement;
  private messageNav?: MessageRail;
  private busy = false;
  private active = true;
  private showAdvanced = false;
  private updated = h("p", { class: "detail-sub" });

  constructor(private root: HTMLElement, private dock: HTMLElement, private client: Client, private hub: HubExtras, input: WorkProject | WorkTaskDetail, private projects: WorkProject[], private hooks: EditorHooks) {
    this.record = "task" in input ? input.task : input;
    const isTask = this.record.type === "task";
    this.recovery = this.store.claim(`work:${this.record.id}`);
    this.writer = new WorkSave(this.record, client, () => this.saved());
    const draft = this.recovery.read<WorkDraft>();
    if (draft?.base?.id === this.record.id && typeof draft.title === "string" && typeof draft.description === "string") {
      this.writer.base = draft.base; this.writer.title = draft.title; this.writer.description = draft.description; this.writer.pending = draft.pending; this.writer.properties = draft.properties ?? {};
    }
    // A wrapping single-paragraph title: long titles stay readable on narrow screens; Enter never inserts a line break.
    this.title = h("textarea", { class: "reader-title note-title work-title", rows: "1", "aria-label": t("Title"), maxlength: 500 });
    this.title.value = this.writer.title;
    const fitTitle = () => { this.title.style.height = "auto"; this.title.style.height = `${this.title.scrollHeight}px`; };
    this.titleResize = new ResizeObserver(fitTitle);
    this.titleResize.observe(this.title);
    this.title.addEventListener("input", event => {
      if (/[\r\n]/.test(this.title.value)) this.title.value = this.title.value.replace(/[\r\n]+/g, " ");
      fitTitle();
      this.changed((event as InputEvent).isComposing);
    });
    this.title.addEventListener("compositionstart", () => clearTimeout(this.timer));
    this.title.addEventListener("compositionend", () => this.changed(false));
    this.title.addEventListener("blur", () => void this.flush());
    this.title.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); this.title.blur(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void this.flush(); }
    });
    const rec = this.record;
    const project = rec.type === "task" && rec.project ? projects.find(p => p.id === rec.project) : undefined;
    this.showAdvanced = rec.type === "task" && !!(rec.workdir || rec.model || rec.timeout_minutes || project?.workdir);
    const crumbs = h("div", { class: "detail-crumbs" },
      h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Back to list"), onclick: () => hooks.back() }, icon("back")),
      isTask ? (project ? h("button", { type: "button", onclick: () => hooks.openProject(project.id) }, icon("folder"), project.title) : h("span", {}, t("No project"))) : h("span", {}, t("Projects")),
      h("div", { class: "detail-actions" },
        h("button", { type: "button", class: "icon-btn", title: t("Copy ID"), "aria-label": t("Copy ID"), onclick: () => void navigator.clipboard?.writeText(this.record.id).then(() => toast(t("ID copied"))) }, icon("link")),
        rec.type === "task" && !rec.plan && this.planButton(rec),
        isTask && h("button", { type: "button", class: "btn btn-primary btn-small", onclick: () => void this.dispatch() }, icon("play"), t("Delegate"))));

    const attention = h("div", { class: "attn-slot" });
    const detail = h("div", { class: "detail" }, crumbs, h("div", { class: "detail-head" }, this.title, this.updated), attention, this.note, this.props,
      h("div", { class: "divider" }), this.bodyHost, this.saveStatus);
    root.append(detail);
    this.renderMeta();
    this.renderProps();
    this.renderBody();
    this.saved();
    if (this.writer.dirty) void this.flush();
    if ("task" in input) {
      // 这个任务需要你处理时（ADR 0030），把卡片放在标题下面。
      void attentionFor(hub, input.task.id).then(item => {
        if (item && this.active) attention.append(attentionCard(item, { client, hub, navigate: hooks.navigate, changed: () => { hooks.changed(); hooks.reload(); } }, "task"));
      }).catch(() => { /* 旧 Hub：没有这个接口 */ });
      if (input.task.plan) detail.append(this.planSection(input.task));
      detail.append(this.timeline(input));
      if (input.task.dependencies.length || input.task.parent) detail.append(h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h3", {}, t("Relationships"))),
        h("p", { class: "muted" }, input.task.parent ? t("Parent task {0}", input.task.parent) : ""),
        input.task.dependencies.length ? h("p", { class: "muted" }, t("Blocked by: {0}", input.task.dependencies.join(t(", ")))) : null));
      if (input.task.references.length) detail.append(h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h3", {}, t("References")), h("span", { class: "count" }, input.task.references.length)),
        h("ul", {}, ...input.task.references.map(ref => h("li", {}, ref.label ?? ref.id)))));
    } else detail.append(this.projectTasks(input));
  }

  dispose(): void { this.canLeave(); this.active = false; this.titleResize?.disconnect(); clearTimeout(this.timer); this.disposeBodyReferences?.(); this.disposeReferences?.(); this.messageNav?.dispose(); }
  get dirty(): boolean { return this.writer.dirty; }
  get isBusy(): boolean { return this.busy; }
  canLeave(): boolean { this.persist(); void this.flush(); return true; }
  async beforeLeave(): Promise<boolean> { this.persist(); await this.flush(); return true; }
  private persist(): void {
    if (this.writer.dirty) this.recovery.write(this.writer.snapshot);
    else this.recovery.remove();
  }
  private changed(composing: boolean): void {
    this.writer.change(this.title.value, this.bodyDraft?.value ?? this.writer.description);
    clearTimeout(this.timer);
    if (!composing && !this.writer.error) this.timer = setTimeout(() => void this.flush(), 800);
  }
  private async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.busy || this.writer.error) return !this.writer.dirty;
    return this.writer.save();
  }
  private saved(): void {
    this.persist();
    if (!this.active) return;
    const changed = this.record.revision !== this.writer.base.revision;
    this.record = this.writer.base;
    this.saveStatus.hidden = !this.writer.error && !(this.writer.dirty && !this.store.persistent);
    this.saveStatus.textContent = this.writer.error ? t("Draft saved on this device") : "";
    if (this.writer.dirty && !this.store.persistent) this.saveStatus.textContent = t("Browser storage unavailable; keep this page open until saved.");
    if (changed) { this.renderMeta(); this.hooks.changed(); }
    if (this.writer.error) this.showFailure(this.writer.error);
    else clear(this.note);
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
    if (r.type === "task") {
      // 轮到谁（ADR 0032）：一句话说明；点开是可做的交接与结局操作。
      const turnBtn = h("button", { type: "button", class: "prop-btn", title: t("Who has the task now") }, turnIcon(turnGroup(r)), h("span", {}, turnText(r)));
      turnBtn.addEventListener("click", () => this.pickTurn(turnBtn));
      row(t("Turn"), "clock", turnBtn);
      const job = r.turn.reason === "working" ? r.turn.job : undefined;
      if (job) row(t("Current round"), "execution", h("button", { type: "button", class: "prop-btn", onclick: () => this.hooks.navigate("execution", job) }, icon("execution"), h("span", {}, t("View run"))));
    } else {
      const statusBtn = h("button", { type: "button", class: "prop-btn" }, statusIcon(r.status), h("span", {}, PROJECT_LABELS[r.status] ?? r.status));
      statusBtn.addEventListener("click", () => openMenu(statusBtn,
        PROJECT_STATUSES.map(s => ({ value: s, label: PROJECT_LABELS[s]!, icon: statusIcon(s), selected: s === r.status })),
        value => void this.patch({ status: value }, statusBtn, t("Status changed to “{0}”", PROJECT_LABELS[value]))));
      row(t("Status"), "clock", statusBtn);
    }

    if (r.type === "task") {
      const project = this.projects.find(p => p.id === r.project);
      const projectBtn = h("button", { type: "button", class: `prop-btn${project ? "" : " placeholder-value"}` }, icon("folder"), h("span", {}, project?.title ?? t("None")));
      projectBtn.addEventListener("click", () => openMenu(projectBtn,
        [{ value: "", label: t("No project"), selected: !r.project }, ...this.projects.map(p => ({ value: p.id, label: p.title, icon: icon("folder"), selected: p.id === r.project }))],
        value => void this.patch({ project: value || null }, projectBtn, t("Project updated")), { filter: this.projects.length > 6, placeholder: t("Find a project") }));
      row(t("Project"), "folder", projectBtn);
      row(t("Due"), "calendar", this.dateInput("due", r.due));

      if (this.showAdvanced) {
        // 没有自己的目录时，委派那一刻用项目的工作目录（ADR 0033）。
        const inherited = this.projects.find(p => p.id === r.project)?.workdir;
        row(t("Working directory"), "terminal", this.textInput("workdir", r.workdir, inherited ? t("From project: {0}", inherited) : t("~ (runtime's home directory)")));
        row(t("Model"), "bot", this.textInput("model", r.model, t("Use the engine's default model")));
        row(t("Time limit"), "clock", this.textInput("timeout_minutes", r.timeout_minutes?.toString(), t("120 minutes"), "number"));
      } else rows.push(h("button", { type: "button", class: "text-btn advanced-toggle", onclick: () => { this.showAdvanced = true; this.renderProps(); } }, t("+ Run settings (working directory, model, time limit)")));
    } else {
      row(t("Goal"), "check", this.textInput("goal", r.goal, t("What should this phase achieve?")));
      row(t("Due"), "calendar", this.dateInput("deadline", r.deadline));
      row(t("Working directory"), "terminal", this.textInput("workdir", r.workdir, t("~ (runtime's home directory)")));
      row(t("Repository"), "link", this.textInput("repo", r.repo, t("URL or path, for reference")));
    }
    if (r.tags.length) row(t("Tags"), "more", h("span", { class: "button-row" }, ...r.tags.map(tag => h("span", { class: "pill" }, tag))));
    clear(this.props, ...rows);
  }

  private textInput(key: string, value: string | undefined, placeholder: string, type = "text"): HTMLInputElement {
    const input = h("input", { class: "prop-input", name: `prop-${key}`, type, placeholder, autocomplete: "off", ...(type === "number" ? { min: "1", step: "1" } : {}) });
    input.value = key in this.writer.properties ? String(this.writer.properties[key] ?? "") : value ?? "";
    const commit = () => {
      const raw = input.value.trim();
      const next = !raw ? null : type === "number" ? Number(raw) : raw;
      if (type === "number" && next !== null && (!Number.isInteger(next) || (next as number) < 1)) { this.writer.property(key, raw); this.writer.error = {code:"INVALID",message:t("Enter a whole number of minutes")}; this.saved(); return; }
      this.writer.property(key, next);
      clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush(), 800);
    };
    input.addEventListener("input", event => { commit(); if ((event as InputEvent).isComposing) clearTimeout(this.timer); });
    input.addEventListener("compositionstart", () => clearTimeout(this.timer));
    input.addEventListener("compositionend", commit);
    input.addEventListener("blur", () => { commit(); void this.flush(); });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); input.blur(); }
      if (event.key === "Escape") input.blur();
    });
    return input;
  }

  private dateInput(key: "due" | "deadline", value: string | undefined): HTMLElement {
    const input = h("input", { class: "prop-input", type: "date", name: `prop-${key}` });
    input.value = dateInputValue(value);
    input.addEventListener("change", () => void this.patch({ [key]: isoFromDateInput(input.value) }, input, input.value ? t("Due date set") : t("Due date cleared")));
    const due = dueLabel(value);
    return h("span", { class: "button-row" }, input, due?.overdue && (this.record.type === "task" ? this.record.outcome === "open" : this.record.status !== "done") ? h("span", { class: "pill pill-red" }, t("Overdue")) : null);
  }

  private pickTurn(anchor: HTMLElement): void {
    if (this.record.type !== "task") return;
    openMenu(anchor, turnActions(this.record).map(action => ({ value: action, label: TURN_ACTION_LABELS[action], icon: icon(TURN_ACTION_ICONS[action]) })),
      value => void this.turnAction(value as TurnAction, anchor));
  }

  /** 交回 / 完成 / 取消 / 重新打开。交给外部要先说明在等什么；完成或取消会停掉正在进行的一轮。 */
  private async turnAction(action: TurnAction, control: HTMLElement): Promise<void> {
    if (this.busy || this.record.type !== "task" || !(await this.flush())) return;
    let note: string | undefined;
    if (action === "external") {
      note = prompt(t("What are you waiting for?"))?.trim();
      if (!note) return;
    }
    if (this.record.turn.reason === "working" && action !== "external" && !confirm(t("An agent is still working on this task. Stop its round and continue?"))) return;
    this.setBusy(true); control.classList.add("prop-saving");
    try {
      await this.commit(turnActionCommand(this.record, action, note));
      toast(TURN_ACTION_DONE[action]);
      this.hooks.reload();
    } catch (cause) { this.showFailure(cause); }
    finally { control.classList.remove("prop-saving"); this.setBusy(false); if (this.active) this.renderProps(); }
  }

  private async patch(patch: Record<string, unknown>, control: HTMLElement, done: string): Promise<void> {
    if (this.busy || !(await this.flush())) return;
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
    this.writer.accept(this.record);
    this.renderMeta();
    this.hooks.changed();
  }

  private setBusy(value: boolean): void { this.busy = value; if (!value && this.writer.dirty && !this.writer.error) this.timer = setTimeout(() => void this.flush(), 0); }

  private showFailure(cause: unknown): void {
    const conflict = isConflict(cause);
    clear(this.note, failure(conflict ? t("This was changed elsewhere. Your draft is kept.") : errorText(cause)), h("div", { class: "button-row" },
      h("button", { type: "button", class: "btn btn-small", onclick: () => this.exportDraft() }, icon("download"), t("Download draft")),
      h("button", { type: "button", class: "btn btn-small", onclick: async () => {
        if (!conflict) { await this.writer.save(); return; }
        try {
          const latest = this.record.type === "task" ? (await this.client.workTask(this.record.id)).task : await this.client.workProject(this.record.id);
          if (!this.active) return;
          const comparison = h("section", { class: "note-conflict" }, h("h3", {}, t("Latest saved version")), h("strong", {}, latest.title), h("pre", {}, latest.description),
            h("p", {}, t("Merge any changes into your draft below, then resume saving.")),
            h("button", { type: "button", class: "btn", onclick: () => { this.writer.rebase(latest); void this.writer.save(); } }, t("I have merged; resume saving")));
          this.note.append(comparison);
        } catch (error) { this.note.append(failure(errorText(error))); }
      } }, conflict ? t("Compare saved version") : t("Retry same save"))));
  }

  private exportDraft(): void {
    const r = this.record;
    const fields = r.type === "task" ? t("Turn: {0}\nProject: {1}\nWorking directory: {2}\nModel: {3}\nTime limit: {4}", turnText(r), r.project ?? "", r.workdir ?? "", r.model ?? "", r.timeout_minutes ?? "") : t("Status: {0}\nGoal: {1}", r.status, r.goal ?? "");
    const blob = new Blob([t("# {0}\n\n{1}\n\n---\n{2}\n\nUnposted comment:\n{3}", this.title.value, this.writer.description, fields, this.commentDraft?.value ?? "")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    h("a", { href: url, download: `lumio-draft-${r.id}.md` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private renderBody(): void {
    this.disposeBodyReferences?.(); this.disposeBodyReferences = undefined;
    this.bodyDraft = undefined;
    const view = h("div", { class: "body-view markdown", role: "button", tabindex: "0", "aria-label": t("Description"), title: t("Click to edit the description") });
    if (this.writer.description.trim()) view.innerHTML = renderMarkdown(this.writer.description);
    else view.append(h("p", { class: "body-empty" }, t("Add a description: background, approach or definition of done…")));
    view.addEventListener("click", event => {
      if ((event.target as Element).closest("a,button") || !window.getSelection()?.isCollapsed) return;
      this.editBody();
    });
    view.addEventListener("keydown", event => { if (event.target === view && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); this.editBody(); } });
    clear(this.bodyHost, view);
  }

  private editBody(): void {
    if (this.bodyDraft) return;
    const height = this.bodyHost.getBoundingClientRect().height;
    const area = h("textarea", { name: "edit-description", rows: "1", class: "work-description-input", "aria-label": t("Description"), placeholder: t("Add a description: background, approach or definition of done…") });
    // Enter without a layout jump; grow only as the user changes the content.
    area.style.height = `${height}px`;
    area.style.minHeight = `${height}px`;
    area.style.maxHeight = `max(${height}px, 45vh)`;
    area.addEventListener("input", () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight}px`; });
    area.value = this.writer.description; this.bodyDraft = area;
    area.addEventListener("input", event => this.changed((event as InputEvent).isComposing));
    area.addEventListener("compositionstart", () => clearTimeout(this.timer));
    area.addEventListener("compositionend", () => this.changed(false));
    area.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void this.flush(); }
      if (event.key === "Escape") { event.preventDefault(); area.blur(); }
    });
    area.addEventListener("blur", () => {
      if (!this.active || this.bodyDraft !== area) return;
      this.changed(false); void this.flush(); this.renderBody();
    });
    clear(this.bodyHost, h("div", { class: "body-editor work-description-editor" }, area));
    this.disposeBodyReferences = referenceInput(area, this.client, () => this.title.value);
    area.focus({ preventScroll: true }); area.setSelectionRange(area.value.length, area.value.length);
  }

  /** 一轮实际会用的工作目录：任务 → 项目 → ~（ADR 0033）。 */
  private effectiveWorkdir(task: WorkTask): string {
    if (task.workdir) return task.workdir;
    const inherited = this.projects.find(p => p.id === task.project)?.workdir;
    return inherited ? t("{0} (from project)", inherited) : "~";
  }

  // ───────────── 项目里的任务 ─────────────

  private projectTasks(project: WorkProject): HTMLElement {
    const body = h("div", {}, h("p", { class: "muted" }, t("Loading…")));
    const add = h("button", { type: "button", class: "btn btn-small", onclick: () => this.hooks.newTask?.(project.id) }, icon("plus"), t("New task in this project"));
    void this.client.workTasks({ project: project.id }).then(tasks => {
      if (!this.active) return;
      if (!tasks.length) { clear(body, h("p", { class: "muted" }, t("No tasks in this project yet."))); return; }
      const groups = TURN_GROUPS.map(group => [group, tasks.filter(task => turnGroup(task) === group)] as const).filter(([, list]) => list.length);
      clear(body, ...groups.map(([group, list]) => h("div", { class: "project-task-group" },
        h("p", { class: "project-task-head" }, turnIcon(group), TURN_GROUP_LABELS[group], h("span", { class: "count" }, list.length)),
        h("div", { class: "runs" }, ...list.map(task => h("button", { type: "button", class: "run", onclick: () => this.hooks.navigate("work", task.id) },
          turnIcon(turnGroup(task)), h("span", { class: "run-round" }, task.title),
          group === "todo" || group === "done" || group === "cancelled" ? null : h("span", { class: "muted" }, turnText(task)),
          h("span", { class: "row-meta" }, icon("chevron"))))))));
    }).catch(cause => { if (this.active) clear(body, failure(errorText(cause))); });
    return h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, t("Tasks")), h("div", { class: "detail-actions" }, add)), body);
  }

  // ───────────── 交接计划 ─────────────

  private planButton(task: WorkTask): HTMLButtonElement {
    const working = task.turn.reason === "working";
    return h("button", { type: "button", class: "btn btn-small", disabled: working || task.outcome !== "open",
      title: working ? t("Wait for the current round to finish before changing the plan") : "",
      onclick: () => void this.editPlan() },
      icon(task.plan ? "edit" : "plus"), task.plan ? t("Edit plan") : t("Add a plan"));
  }

  private async editPlan(): Promise<void> {
    if (this.busy || !(await this.flush()) || !this.active || this.root.closest("[hidden]")) return;
    const task = this.record;
    if (task.type !== "task" || task.outcome !== "open" || task.turn.reason === "working") return;
    await openPlanEditor(this.client, task, () => { this.hooks.changed(); this.hooks.reload(); },
      () => this.active && !this.root.closest("[hidden]")).catch(cause => this.showFailure(cause));
  }

  private planSection(task: WorkTask): HTMLElement {
    return h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h3", {}, t("Handoff plan")), h("div", { class: "detail-actions" }, this.planButton(task))),
      planProgress(task));
  }

  // ───────────── 委派 ─────────────

  private async dispatch(): Promise<void> {
    if (this.record.type !== "task" || this.busy) return;
    if (!(await this.flush())) return;
    const task = this.record;
    if (task.outcome !== "open") { toast(t("Reopen the task before delegating it."), "error"); return; }
    if (task.turn.reason === "working") { toast(t("{0} is still working on this task.", task.turn.holder), "error"); return; }
    if (task.turn.holder === "nobody") { toast(t("This task is on hold. Choose “I'll handle it” first."), "error"); return; }
    const run = task.plan;
    const stage = run && run.stage !== "end" ? run.plan.stages.find(value => value.id === run.stage) : undefined;
    if (run && stage?.kind !== "agent") { this.planStop(task, run.stage); return; }
    this.setBusy(true);
    try {
      const targets = engineTargets(await this.client.runtimes());
      if (!this.active || this.root.closest("[hidden]")) return;
      const fixed = stage?.kind === "agent" ? stage.agent : undefined;
      const options = fixed ? [[fixed, targets.find(x => x.target === fixed)?.label ?? fixed] as [string, string]] : targets.map(x => [x.target, x.label] as [string, string]);
      const preferred = fixed ?? targets.find(x => x.online)?.target ?? "";
      const target = select("dispatch-target", fixed ? options : [["", t("Choose a runtime and engine")], ...options], preferred);
      target.required = true; target.disabled = !!fixed;
      const formId = `dispatch-${newRequestId()}`, error = h("div", { role: "alert" });
      const form = h("form", { id: formId, class: "form-stack" },
        h("p", {}, ...tParts("“{0}” will be handed to the runtime as currently saved.", h("strong", {}, task.title))),
        field(t("Target"), target, fixed ? t("Set by the plan step “{0}”.", stage!.id) : undefined),
        h("dl", { class: "meta-grid" }, h("div", {}, h("dt", {}, t("Working directory")), h("dd", {}, this.effectiveWorkdir(task))), h("div", {}, h("dt", {}, t("Time limit")), h("dd", {}, t("{0} min", task.timeout_minutes ?? 120)))),
        !targets.length && !fixed && h("div", { class: "notice" }, icon("alert"), h("span", {}, t("No device with a registered engine yet. Run lumio runtime add in a terminal to connect one."))),
        error);
      const submit = h("button", { type: "submit", form: formId, class: "btn btn-primary", disabled: !targets.length && !fixed }, icon("play"), t("Confirm"));
      const dialog = openDialog(t("Delegate a new round"), form, [submit]);
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

  /** 计划停在检查点或已经走完：委派按钮改为「继续」或说明。 */
  private planStop(task: WorkTask, stage: string): void {
    const step = task.plan?.plan.stages.find(value => value.id === stage);
    const error = h("div", { role: "alert" });
    const end = stage === "end";
    const body = h("div", { class: "form-stack" },
      h("p", {}, end ? t("The plan is finished. Edit the plan to run more steps, or remove it to delegate freely.") : t("The plan is waiting at a checkpoint: {0}", stageLabel(step, stage))), error);
    const go = h("button", { type: "button", class: "btn btn-primary", disabled: end }, icon("play"), t("Continue"));
    const dialog = openDialog(t("Delegate a new round"), body, end ? [] : [go]);
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        await this.client.workCommand(checkpointCommand(task.id, stage, "continue"));
        dialog.close(); toast(t("Continuing with the next step."));
        if (this.active) { this.hooks.changed(); this.hooks.reload(); }
      } catch (cause) { clear(error, failure(errorText(cause))); go.disabled = false; }
    });
  }

  // ───────────── 时间线：讨论、轮次、交接 ─────────────

  private timeline(input: WorkTaskDetail): HTMLElement {
    const names = new Map<string, string>();
    const who = (id: string, el: HTMLElement) => { el.textContent = names.get(id) ?? ""; void actorName(this.client, id).then(name => { if (name) { names.set(id, name); el.textContent = name; } }); };
    const comment = (value: { author: string; body: string; created: string }) => {
      const body = h("div", { class: "markdown" });
      body.innerHTML = renderMarkdown(value.body);
      const author = h("span", { class: "comment-author" });
      who(value.author, author);
      return h("article", { class: "comment" }, h("span", { class: "comment-avatar", "aria-hidden": "true" }, icon("user")),
        h("div", {}, h("p", { class: "comment-meta", title: formatTime(value.created) }, author, " ", ago(value.created)), body));
    };
    const event = (glyph: string, text: string, at: string, job?: string, by?: string) => {
      const actor = h("span", { class: "tl-by" });
      if (by) who(by, actor);
      return h("div", { class: "tl-event" }, h("span", { class: "tl-icon", "aria-hidden": "true" }, icon(glyph)),
        h("span", { class: "tl-text" }, text, by ? h("span", { class: "tl-sep" }, " · ") : null, actor),
        job ? h("button", { type: "button", class: "text-btn tl-run", onclick: () => this.hooks.navigate("execution", job) }, t("View run")) : null,
        h("span", { class: "tl-time", title: formatTime(at) }, ago(at)));
    };
    const items: Array<{ at: string; order: number; node: () => HTMLElement }> = [];
    const plan = input.task.plan?.plan;
    input.turns.forEach((change, index) => {
      if (index === 0 && JSON.stringify(change.from) === JSON.stringify(change.to) && change.outcome !== "done" && change.outcome !== "cancelled") return;
      const [glyph, text] = describeTurn(change, plan);
      items.push({ at: change.at, order: 1, node: () => event(glyph, text, change.at, change.to.reason === "working" ? change.to.job : undefined, change.by) });
    });
    const delegated = new Set(input.turns.map(change => change.to.job).filter(Boolean));
    for (const run of input.executions) {
      if (!delegated.has(run.job)) items.push({ at: run.created, order: 1, node: () => event("play", t("Round {0} started", run.round), run.created, run.job) });
    }
    for (const value of input.comments) items.push({ at: value.created, order: 0, node: () => comment(value) });
    items.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);

    const list = h("div", { class: "timeline" }, ...items.map(item => item.node()));
    this.messageNav = new MessageRail(this.root, list, ".comment", t("Jump to a message"), (index, excerpt) => t("Message {0}: {1}", index + 1, excerpt));
    this.root.after(this.messageNav.element);
    const count = h("span", { class: "count" }, input.comments.length || "");
    const text = autosize(h("textarea", { name: "comment", rows: "1", placeholder: t("Add thoughts, feedback, or questions for the next round…"), "aria-label": t("Discussion") }));
    this.commentDraft = text;
    this.disposeReferences = referenceInput(text, this.client, () => this.title.value);
    const captureComment = textDraft(text, `comment:${input.task.id}`);
    const error = h("div", { role: "alert" });
    const submit = h("button", { type: "submit", class: "btn btn-primary btn-small" }, t("Comment"));
    // 评论并交给 agent 继续：评论与委派在同一事务（ADR 0030）；继续的是计划当前步骤或上一轮的 agent。
    const next = continueTarget(input);
    const onward = next ? h("button", { type: "button", class: "btn btn-small", title: t("Post the comment and delegate the next round in one step") }, icon("play"), t("Comment and continue with {0}", next)) : null;
    const form = h("form", { class: "composer" }, text, h("div", { class: "composer-foot" }, h("span", { class: "hint" }, t("⌘↵ to post · Markdown supported")), onward, submit));
    text.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); form.requestSubmit(); } });
    let requestId = newRequestId(), previous = "";
    onward?.addEventListener("click", async () => {
      if (this.busy || !text.value.trim()) { text.focus(); return; }
      if (this.record.type !== "task" || !(await this.flush())) return;
      this.setBusy(true); onward.disabled = submit.disabled = true; clear(error);
      if (previous && previous !== `continue\n${text.value}`) requestId = newRequestId();
      previous = `continue\n${text.value}`;
      try {
        await this.client.workCommand(answerCommand(this.record, undefined, text.value, requestId));
        text.value = ""; captureComment(); this.commentDraft = undefined;
        toast(t("Dispatched to {0}", next!));
        this.hooks.changed(); this.hooks.reload();
      } catch (cause) {
        clear(error, failure(t("{0} Your input is kept; refresh to check whether it was posted.", errorText(cause))));
      } finally { this.setBusy(false); onward.disabled = submit.disabled = false; }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (this.busy || !text.value.trim()) return;
      this.setBusy(true); submit.disabled = true; clear(error);
      if (previous && previous !== text.value) requestId = newRequestId();
      previous = text.value;
      try {
        const result = await this.client.workCommand(commentCommand(input.task.id, text.value, requestId));
        if (result.kind !== "comment") throw new Error("unexpected result");
        list.append(comment(result.comment));
        count.textContent = String(Number(count.textContent || 0) + 1);
        text.value = ""; text.dispatchEvent(new Event("input"));
        requestId = newRequestId(); previous = "";
      } catch (cause) {
        clear(error, failure(t("{0} Your input is kept; refresh to check whether it was posted.", errorText(cause))));
      } finally { this.setBusy(false); submit.disabled = false; }
    });
    this.dock.hidden = false;
    this.dock.append(form, error);
    return h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, t("Activity")), count), list);
  }
}

/** 一条交接记录的说明（时间线用）。 */
export function describeTurn(change: WorkTaskDetail["turns"][number], plan?: { stages: Array<{ id: string; kind: string; prompt?: string }> }): [string, string] {
  if (change.outcome === "done") return ["check", t("Marked done")];
  if (change.outcome === "cancelled") return ["close", t("Cancelled")];
  if (change.outcome === "open") return ["refresh", t("Reopened")];
  const to = change.to, from = change.from;
  const stage = to.stage ? plan?.stages.find(value => value.id === to.stage) : undefined;
  if (to.reason === "working") return ["play", to.stage ? t("Delegated to {0} (round {1}, step {2})", to.holder, to.round ?? "?", to.stage) : t("Delegated to {0} (round {1})", to.holder, to.round ?? "?")];
  if (to.holder === "external") return ["clock", to.note ? t("Waiting on others: {0}", to.note) : t("Waiting on others")];
  if (to.holder === "nobody") return ["pause", t("Put on hold")];
  const agent = from.reason === "working" ? from.holder : undefined;
  switch (to.reason) {
    case "answer": return ["help", agent ? t("{0} asked a question", agent) : t("Waiting for your answer")];
    case "failed": return ["alert", to.note ? t("Round failed: {0}", to.note) : t("Round failed")];
    case "review":
      if (stage?.kind === "checkpoint") return ["flag", t("Checkpoint: {0}", stage.prompt ?? to.stage)];
      if (to.stage === "end") return ["check", t("Plan finished · your turn to review")];
      return ["check", to.note ? t("Your turn to review: {0}", to.note) : agent ? t("{0} delivered · your turn to review", agent) : t("Your turn to review")];
    default: return ["user", agent ? t("Round cancelled · back to you") : t("Your turn · {0}", reasonLabel(to.reason))];
  }
}

let actorNames: Promise<Map<string, string>> | undefined;
/** 身份 ID → 名称（只读一次；失败时下次再试）。 */
function actorName(client: Client, id: string): Promise<string | undefined> {
  actorNames ??= client.actors().then(list => new Map(list.map(actor => [actor.id, actor.name.startsWith("work-system-") ? "Lumio" : actor.name])), () => { actorNames = undefined; return new Map<string, string>(); });
  return actorNames.then(map => map.get(id));
}

/** 「评论并继续」交给谁：计划当前的 agent 步骤，否则最近一轮的 agent；不能继续时返回 undefined。 */
export function continueTarget(input: WorkTaskDetail): string | undefined {
  const task = input.task;
  if (task.outcome !== "open" || task.turn.reason === "working" || task.turn.holder === "nobody") return undefined;
  if (task.plan) {
    const stage = task.plan.stage === "end" ? undefined : task.plan.plan.stages.find(value => value.id === task.plan!.stage);
    return stage?.kind === "agent" ? stage.agent : undefined;
  }
  return input.turns.filter(change => change.to.reason === "working").at(-1)?.to.holder;
}

/**
 * 项目与任务（ADR 0026、0032）：任务按「轮到谁」分组，项目按状态分组；右侧详情。
 * 列表上可直接交回、完成、取消（带 revision）；新建在对话框里完成，新建不会委派。
 */
import { knowledgeReferences, referenceConsequence } from "../resources.ts";
import type { WorkProject, WorkTask, WorkTaskDetail } from "@lumio/schema";
import { PROJECT_STATUSES } from "@lumio/schema";
import { errorText, isConflict, type Client, type HubExtras } from "../api.ts";
import { newRequestId, projectCreateCommand, taskCreateCommand } from "../commands.ts";
import { autosize, clear, debounce, empty, failure, field, h, icon, loading, openDialog, openMenu, placeholder, select, statusIcon, toast } from "../dom.ts";
import { drafts } from "../drafts.ts";
import { confirmDelete, deletableRow } from "../trash-actions.ts";
import { dueLabel } from "../format.ts";
import { PROJECT_LABELS } from "../labels.ts";
import { TURN_GROUPS, TURN_GROUP_LABELS, isBlocked, turnGroup, turnIcon, turnText, type TurnGroup } from "../turn.ts";
import { allTags, blockingTitles } from "../task-structure.ts";
import { listKeys, markSelected } from "../list-keys.ts";
import type { Navigate } from "../navigation.ts";
import { WorkEditor } from "./work-editor.ts";
import { taskTurnMenu } from "../turn-menu.ts";
import { t } from "../i18n.ts";

type Mode = "tasks" | "projects";
const PROJECT_ORDER = ["active", "planning", "paused", "done"] as const;
const FOLDED_BY_DEFAULT = new Set(["done", "cancelled", "hold"]);

export class WorkPane {
  private split = h("div", { class: "split" });
  private list = h("div", { class: "list-scroll" });
  private detail = h("section", { class: "detail-pane", "aria-live": "polite" });
  private dock = h("div", { class: "thread-dock", hidden: true });
  private detailLayout = h("div", { class: "detail-pane work-detail-layout" }, h("div", { class: "message-layout" }, this.detail), this.dock);
  private query = h("input", { type: "search", name: "work-search", placeholder: t("Search tasks"), autocomplete: "off" });
  private statusFilter = "";
  private projectFilter = "";
  private tagFilter = "";
  private tagButton = h("button", { type: "button", class: "filter-btn" });
  private statusButton = h("button", { type: "button", class: "filter-btn" });
  private projectButton = h("button", { type: "button", class: "filter-btn" });
  private projects: WorkProject[] = [];
  private tasks: WorkTask[] = [];
  private folded = new Set(FOLDED_BY_DEFAULT);
  private selected?: string;
  private editor?: WorkEditor;
  private displayed?: WorkTaskDetail | WorkProject;
  private listGeneration = 0;
  private detailGeneration = 0;
  private active = true;
  private unbindKeys: () => void;

  constructor(private root: HTMLElement, private client: Client, private hub: HubExtras, private mode: Mode, initialId: string | undefined, private navigate: Navigate, private changed: () => void) {
    this.query.placeholder = mode === "tasks" ? t("Search tasks") : t("Search projects");
    this.statusButton.addEventListener("click", () => this.pickStatusFilter());
    this.projectButton.addEventListener("click", () => this.pickProjectFilter());
    this.tagButton.addEventListener("click", () => this.pickTagFilter());
    this.query.addEventListener("input", debounce(() => void this.load(), 200));
    this.query.addEventListener("keydown", event => { if (event.key === "Escape" && this.query.value) { this.query.value = ""; void this.load(); } });
    root.append(
      h("header", { class: "bar" },
        h("h1", { class: "bar-title" }, t("Work")),
        h("div", { class: "segmented", role: "group", "aria-label": t("View") },
          h("button", { type: "button", "data-pad-row": "work:tasks", "aria-pressed": String(mode === "tasks"), onclick: () => navigate("work", "tasks") }, t("Tasks")),
          h("button", { type: "button", "data-pad-row": "work:projects", "aria-pressed": String(mode === "projects"), onclick: () => navigate("work", "projects") }, t("Projects"))),
        h("span", { class: "bar-spacer" }),
        h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: (event: Event) => { spin(event); void this.load(); if (this.selected) void this.open(this.selected, true); } }, icon("refresh")),
        h("button", { type: "button", class: "btn btn-primary", title: t("New (C)"), onclick: () => this.create() }, icon("plus"), h("span", { class: "hide-narrow" }, t("New")))),
      this.split);
    this.split.append(
      h("div", { class: "list-pane" },
        h("div", { class: "list-tools" }, h("label", { class: "search-box" }, icon("search"), this.query), this.statusButton, this.projectButton, this.tagButton),
        this.list),
      this.detailLayout);
    this.renderFilters();
    this.showPlaceholder();
    this.unbindKeys = listKeys(this.list, id => void this.open(id));
    void this.load().then(() => {
      if (initialId && this.active && !this.selected) void this.open(initialId);
    });
  }

  dispose(): void { this.active = false; this.listGeneration++; this.detailGeneration++; this.editor?.dispose(); this.unbindKeys(); }
  get dirty(): boolean { return this.editor?.dirty ?? false; }
  /** 静默刷新列表；详情只在没有未保存内容、焦点不在详情里时重新载入。 */
  private closeDetail(): void {
    this.detailGeneration++; this.editor?.dispose(); this.editor = undefined; this.displayed = undefined;
    this.clearDock();
    this.selected = undefined; markSelected(this.list, undefined); this.showPlaceholder();
  }

  liveRefresh(): void {
    void this.load(true);
    if (this.selected && this.canRefreshDetail()) void this.open(this.selected, true, true);
  }
  private canRefreshDetail(): boolean {
    return !this.root.hidden && !!this.editor && !this.editor.dirty && !this.editor.isBusy
      && !this.detailLayout.contains(document.activeElement)
      && !this.editor.hasUnsentComment
      && !this.detailLayout.querySelector(".is-busy");
  }
  beforeLeave(): Promise<boolean> { return this.editor?.beforeLeave() ?? Promise.resolve(true); }
  canLeave(): boolean { return this.editor?.canLeave() ?? true; }
  intent(name: string): void {
    if (name === "new" || name === "new-project") this.create();
    if (name.startsWith("delegate:")) void this.delegateFromList(name.slice("delegate:".length));
  }

  private async delegateFromList(id: string): Promise<void> {
    if (this.mode !== "tasks") return;
    const focus = document.activeElement;
    await this.open(id);
    if (!this.active || this.root.hidden || this.selected !== id || document.activeElement !== focus
      || document.querySelector("dialog[open]")) return;
    this.detail.querySelector<HTMLButtonElement>('[data-pad-action="delegate"]:not(:disabled)')?.click();
  }

  // ───────────── 列表 ─────────────

  private renderFilters(): void {
    const label = this.mode === "tasks" ? TURN_GROUP_LABELS[this.statusFilter as TurnGroup] : PROJECT_LABELS[this.statusFilter];
    const glyph = this.mode === "tasks" ? turnIcon(this.statusFilter as TurnGroup) : statusIcon(this.statusFilter);
    clear(this.statusButton, this.statusFilter ? glyph : icon("down"), this.statusFilter ? label! : this.mode === "tasks" ? t("Turn") : t("Status"));
    this.statusButton.classList.toggle("is-set", !!this.statusFilter);
    this.projectButton.hidden = this.mode !== "tasks";
    const project = this.projects.find(p => p.id === this.projectFilter);
    clear(this.projectButton, icon("folder"), project?.title ?? t("Projects"));
    this.projectButton.classList.toggle("is-set", !!project);
    this.tagButton.hidden = this.mode !== "tasks";
    clear(this.tagButton, icon("flag"), this.tagFilter ? `#${this.tagFilter}` : t("Tags"));
    this.tagButton.classList.toggle("is-set", !!this.tagFilter);
  }

  /** 按标签筛选（ADR 0039）：候选来自已载入的任务，标签主要由 AI 维护，人只需要挑。 */
  private pickTagFilter(): void {
    const tags = allTags(this.tasks);
    if (this.tagFilter && !tags.includes(this.tagFilter)) tags.unshift(this.tagFilter);
    openMenu(this.tagButton, [{ value: "", label: t("All tags"), selected: !this.tagFilter },
      ...tags.map(tag => ({ value: tag, label: `#${tag}`, selected: this.tagFilter === tag }))],
      value => { this.tagFilter = value; this.renderFilters(); void this.load(); }, { filter: tags.length > 6, placeholder: t("Find a tag") });
  }

  private pickStatusFilter(): void {
    const items = this.mode === "tasks"
      ? TURN_GROUPS.map(group => ({ value: group as string, label: TURN_GROUP_LABELS[group], icon: turnIcon(group), selected: this.statusFilter === group }))
      : PROJECT_STATUSES.map(s => ({ value: s as string, label: PROJECT_LABELS[s]!, icon: statusIcon(s), selected: this.statusFilter === s }));
    openMenu(this.statusButton, [{ value: "", label: this.mode === "tasks" ? t("Everyone") : t("All statuses"), selected: !this.statusFilter }, ...items],
      value => { this.statusFilter = value; this.renderFilters(); void this.load(); });
  }

  private pickProjectFilter(): void {
    // Finished projects stay out of the filter (unless one is the current filter, so it can be seen and cleared).
    const choices = this.projects.filter(p => p.status !== "done" || p.id === this.projectFilter);
    openMenu(this.projectButton, [{ value: "", label: t("All projects"), selected: !this.projectFilter },
      ...choices.map(p => ({ value: p.id, label: p.title, icon: icon("folder"), selected: this.projectFilter === p.id }))],
      value => { this.projectFilter = value; this.renderFilters(); void this.load(); }, { filter: choices.length > 6, placeholder: t("Find a project") });
  }

  private async load(quiet = false): Promise<void> {
    const generation = ++this.listGeneration;
    if (!this.list.childElementCount) clear(this.list, loading());
    try {
      const projects = await this.client.workProjects();
      if (generation !== this.listGeneration || !this.active) return;
      this.projects = projects; this.renderFilters();
      const q = this.query.value.trim();
      if (this.mode === "projects") {
        const tasks = await this.client.workTasks();
        if (generation !== this.listGeneration || !this.active) return;
        this.tasks = tasks;
        const visible = projects.filter(p => (!this.statusFilter || p.status === this.statusFilter) && (!q || p.title.toLowerCase().includes(q.toLowerCase())));
        this.renderGroups(PROJECT_ORDER, visible, p => p.status, p => this.projectRow(p), PROJECT_LABELS, statusIcon,
          q || this.statusFilter ? t("No matching projects") : t("No projects yet. A project groups the tasks behind one goal."));
        return;
      }
      const all = await this.client.workTasks({ project: this.projectFilter || undefined, query: q || undefined });
      if (generation !== this.listGeneration || !this.active) return;
      this.tasks = all;
      const tasks = all.filter(task => (!this.statusFilter || turnGroup(task) === this.statusFilter) && (!this.tagFilter || task.tags.includes(this.tagFilter)));
      this.renderGroups(TURN_GROUPS, tasks, turnGroup, t => this.taskRow(t), TURN_GROUP_LABELS, group => turnIcon(group as TurnGroup),
        q || this.statusFilter || this.projectFilter || this.tagFilter ? t("No matching tasks. Try another search or clear the filters.") : t("No tasks yet. Press C to create the first one."));
    } catch (error) {
      if (!quiet && generation === this.listGeneration && this.active) clear(this.list, failure(errorText(error), () => this.load()));
    }
  }

  private renderGroups<T extends WorkTask | WorkProject>(order: readonly string[], items: T[], groupOf: (item: T) => string, row: (item: T) => HTMLElement, labels: Record<string, string>, glyph: (group: string) => SVGSVGElement, emptyText: string): void {
    if (!items.length) { clear(this.list, empty(emptyText, this.mode === "tasks" ? { label: t("New task"), run: () => this.create() } : { label: t("New project"), run: () => this.create() })); return; }
    const groups = order.map(status => [status, items.filter(i => groupOf(i) === status)] as const).filter(([, list]) => list.length);
    clear(this.list, ...groups.map(([status, list]) => {
      const group = h("section", { class: `group${this.folded.has(status) && !this.statusFilter ? " collapsed" : ""}` });
      const head = h("button", { type: "button", class: "group-head", "data-pad-row": `group:${status}`, "aria-expanded": String(!group.classList.contains("collapsed")), onclick: () => {
        const collapsed = group.classList.toggle("collapsed");
        head.setAttribute("aria-expanded", String(!collapsed));
        if (collapsed) this.folded.add(status); else this.folded.delete(status);
      } }, icon("chevron", "icon caret"), glyph(status), labels[status] ?? status, h("span", { class: "count" }, list.length));
      group.append(head, h("div", { class: "group-body" }, ...list.map(row)));
      return group;
    }));
    markSelected(this.list, this.selected);
  }

  private taskRow(task: WorkTask): HTMLElement {
    const due = dueLabel(task.due);
    const group = turnGroup(task);
    const project = !this.projectFilter && task.project ? this.projects.find(p => p.id === task.project)?.title : undefined;
    const statusBtn = h("button", { type: "button", class: "status-btn", "data-pad-action": "more", title: turnText(task), "aria-label": t("Change who has it (now: {0})", turnText(task)),
      onclick: (event: Event) => { event.stopPropagation(); this.quickTurn(task, statusBtn); } }, turnIcon(group));
    // 不是轮到你的待办时，副标题说明轮到谁（agent、外部、搁置、需要你处理的原因）。
    const holder = group === "todo" || group === "blocked" || group === "done" || group === "cancelled" ? undefined : turnText(task);
    const sub = [project && h("span", { class: "project-chip" }, icon("folder", "icon"), project),
      holder && h("span", { class: `who-chip${group === "needs" ? " is-needs" : ""}` }, icon(group === "agents" ? "bot" : group === "external" ? "clock" : group === "hold" ? "pause" : "alert"), holder),
      task.plan && h("span", { class: "who-chip", title: t("Has a handoff plan") }, icon("route")),
      // 被阻塞（ADR 0039）：叠加在轮到谁之上；悬停列出还没完成的前置。
      isBlocked(task) && h("span", { class: "who-chip is-blocked", title: t("Waiting on: {0}", blockingTitles(task, new Map(this.tasks.map(item => [item.id, item]))).join(t(", "))) },
        icon("link"), t("Waiting on {0}", task.blocked_by!.length))].filter(Boolean) as HTMLElement[];
    const row = h("div", { class: `row t-${group}`, "data-id": task.id, "data-pad-menu": true,
      "data-pad-delegate": task.outcome === "open" && task.turn.reason !== "working" && task.turn.holder !== "nobody" && !isBlocked(task), role: "button", tabindex: "0",
      onclick: () => void this.open(task.id), onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter" && event.target === event.currentTarget) void this.open(task.id); } },
      statusBtn,
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, task.title), sub.length ? h("span", { class: "row-sub" }, ...sub) : null),
      h("span", { class: "row-meta" },
        due && task.outcome === "open" && h("span", { class: `due${due.overdue ? " overdue" : due.soon ? " soon" : ""}`, title: t("Due") }, due.text)));
    row.addEventListener("lumio-task-menu", () => this.quickTurn(task, row, [{ label: t("Delete"), run: () => void this.deleteWork(task) }]));
    return deletableRow(row, task.title, () => void this.deleteWork(task));
  }

  private projectRow(project: WorkProject): HTMLElement {
    const related = this.tasks.filter(t => t.project === project.id && t.outcome !== "cancelled");
    const done = related.filter(t => t.outcome === "done").length;
    const fill = h("span", { class: "progress-fill" });
    fill.style.width = `${related.length ? Math.round((done / related.length) * 100) : 0}%`;
    const row = h("div", { class: `row ${project.status}`, "data-id": project.id, "data-pad-menu": true, role: "button", tabindex: "0", onclick: () => void this.open(project.id),
      onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter") void this.open(project.id); } },
      statusIcon(project.status),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, project.title), project.goal && h("span", { class: "row-sub" }, project.goal)),
      h("span", { class: "row-meta" }, related.length ? h("span", { class: "progress", title: t("{0} of {1} done", done, related.length) }, fill) : null, related.length ? `${done}/${related.length}` : t("No tasks")));
    row.addEventListener("lumio-task-menu", () => {
      openMenu(row, [{ value: "delete", label: t("Delete"), icon: icon("trash") }], () => void this.deleteWork(project));
    });
    return deletableRow(row, project.title, () => void this.deleteWork(project));
  }

  private async deleteWork(item: WorkTask | WorkProject): Promise<void> {
    const editor = this.selected === item.id ? this.editor : undefined;
    // If this record is open, save pending edits and use the saved revision.
    const record = editor ? await editor.prepareDelete() : item;
    if (!record) return;

    const consequences: string[] = [];
    if (record.type === "task" && record.turn.reason === "working") {
      consequences.push(t("{0} is working on this task. That round will be stopped first; its run record is kept.", record.turn.holder));
    }
    if (record.type === "task") consequences.push(...referenceConsequence(await knowledgeReferences(this.client, record.id)));
    if (record.type === "project") {
      const tasks = await this.client.workTasks({ project: record.id }).catch(() => undefined);
      consequences.push(tasks === undefined ? t("Tasks in this project will be kept and moved to No project.")
        : tasks.length ? t("Its {0} tasks will be kept and moved to No project. Restoring the project puts them back.", tasks.length) : t("This project has no tasks."));
    }
    if (!this.active || this.root.hidden || document.querySelector("dialog[open]")) return;
    if (editor?.dirty || editor?.isBusy || editor !== (this.selected === record.id ? this.editor : undefined)) return;
    const store = drafts();
    confirmDelete(this.client, {
      title: record.type === "task" ? t("Delete this task?") : t("Delete this project?"),
      name: record.title,
      consequences,
      run: async requestId => {
        const result = await this.client.workCommand(record.type === "task"
          ? { request_id: requestId, operation: { op: "work.task.delete", args: { task: record.id, expected_revision: record.revision } } }
          : { request_id: requestId, operation: { op: "work.project.delete", args: { project: record.id, expected_revision: record.revision } } });
        if (result.kind !== "trashed") throw new Error("unexpected result");
        return result.item;
      },
      deleted: () => {
        if (this.active && this.selected === record.id) {
          this.closeDetail();
          if (!this.root.hidden) history.replaceState(null, "", `#work/${this.mode}`);
        }
        store.remove(`work:${record.id}`);
        store.remove(`comment:${record.id}`);
        if (this.active) { this.changed(); void this.load(); }
      },
      restored: restored => {
        if (!this.active) return;
        this.changed(); void this.load();
        if (editor && !this.root.hidden && !this.selected) this.navigate("work", restored.id);
      },
    });
  }

  private quickTurn(task: WorkTask, anchor: HTMLElement, extra?: { label: string; run(): void }[]): void {
    taskTurnMenu(this.client, task, anchor, async () => {
      this.changed();
      await this.load();
      if (this.selected === task.id && !this.editor?.dirty) void this.open(task.id, true);
    }, () => { void this.load(); }, extra);
  }

  // ───────────── 详情 ─────────────

  private showPlaceholder(): void {
    this.split.classList.remove("has-detail");
    this.clearDock();
    clear(this.detail, placeholder(this.mode === "tasks" ? "work" : "folder", this.mode === "tasks" ? t("Select a task to see details. Use J / K to move between tasks.") : t("Select a project to see its goal and progress.")));
  }

  private clearDock(): void {
    this.dock.hidden = true;
    clear(this.dock);
  }

  async open(id: string, quiet = false, live = false): Promise<void> {
    if (!quiet && id === this.selected && this.editor) return;
    if (!quiet && (!(await this.beforeLeave()) || !this.active)) return;
    if (id.startsWith("prj_") !== (this.mode === "projects")) { this.navigate("work", id); return; }
    const generation = ++this.detailGeneration;
    this.selected = id; markSelected(this.list, id);
    // 更新 URL 以触发 workbench 的 readSubject，标记通知为已读
    if (!quiet && !this.root.hidden) {
      const hash = `#work/${encodeURIComponent(id)}`;
      if (location.hash !== hash) history.replaceState(null, "", hash);
    }
    this.split.classList.add("has-detail");
    if (!quiet) { this.editor?.dispose(); this.editor = undefined; this.clearDock(); clear(this.detail, loading()); }
    try {
      const object = id.startsWith("task_") ? await this.client.workTask(id) : await this.client.workProject(id);
      if (!this.active || generation !== this.detailGeneration) return;
      if (live && !this.canRefreshDetail()) return;
      if (live && JSON.stringify(object) === JSON.stringify(this.displayed)) {
        if ("task" in object) void this.editor?.refreshRelatedTasks(() => this.canRefreshDetail());
        return;
      }
      const scroll = this.detail.scrollTop;
      this.editor?.dispose();
      this.clearDock();
      clear(this.detail);
      this.displayed = object;
      this.editor = new WorkEditor(this.detail, this.dock, this.client, this.hub, object, this.projects, {
        changed: () => { this.changed(); void this.load(); },
        reload: () => void this.open(id, true),
        back: () => { if (this.canLeave()) this.closeDetail(); },
        navigate: this.navigate,
        openProject: projectId => this.navigate("work", projectId),
        newTask: projectId => this.create("tasks", projectId),
        newSubtask: (parent, projectId) => this.create("tasks", projectId, parent),
      });
      if (quiet) this.detail.scrollTop = scroll;
    } catch (error) {
      if (!live && this.active && generation === this.detailGeneration) {
        this.editor?.dispose(); this.editor = undefined;
        this.clearDock();
        clear(this.detail, failure(errorText(error), () => this.open(id, true)));
      }
    }
  }

  // ───────────── 新建 ─────────────

  /** kind 缺省跟随当前视图；从项目页新建任务时带 preset，创建后回到该项目。 */
  /** parent：从任务详情新建子任务时预填父任务，创建后回到父任务。 */
  private create(kind: Mode = this.mode, preset?: string, parent?: string): void {
    const isTask = kind === "tasks";
    const title = h("input", { name: "title", required: true, placeholder: isTask ? t("What needs to get done?") : t("Project name"), autocomplete: "off" });
    const description = autosize(h("textarea", { name: "description", rows: "4", placeholder: isTask ? t("Background, approach or definition of done (optional, Markdown)") : t("Project background (optional, Markdown)") }));
    const goal = h("input", { name: "goal", placeholder: t("What should this phase achieve?"), autocomplete: "off" });
    const project = select("project", [["", t("No project")], ...this.projects.filter(p => p.status !== "done" || p.id === preset).map(p => [p.id, p.title] as [string, string])], preset ?? this.projectFilter);
    const workdir = h("input", { name: "workdir", placeholder: t("~ (runtime's home directory)"), autocomplete: "off", spellcheck: "false" });
    const error = h("div", { class: "form-message", role: "alert" });
    const formId = `create-${newRequestId()}`;
    const form = h("form", { id: formId, class: "form-stack" },
      field(isTask ? t("Title") : t("Name"), title),
      isTask ? field(t("Project"), project) : field(t("Goal"), goal),
      isTask ? null : field(t("Working directory"), workdir, t("Tasks in this project run here unless they set their own.")),
      field(t("Description"), description), error);
    const save = h("button", { type: "submit", form: formId, class: "btn btn-primary" }, isTask ? t("Create task") : t("Create project"), h("kbd", {}, "⌘↵"));
    const parentTitle = parent ? this.tasks.find(task => task.id === parent)?.title ?? parent : undefined;
    if (parentTitle) form.prepend(h("p", { class: "muted" }, t("Subtask of “{0}”", parentTitle)));
    const dialog = openDialog(parent ? t("New subtask") : isTask ? t("New task") : t("New project"), form, [save], { draftKey: `new-${isTask ? "task" : "project"}:${preset ?? ""}:${parent ?? ""}` });
    form.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); form.requestSubmit(); } });
    let pending = false, prior = dialog.dataset.previous ?? "", requestId = dialog.dataset.requestId ?? newRequestId();
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (pending) return;
      pending = true; save.disabled = true; clear(error);
      // 同样的内容重试时复用 request_id，Hub 据此去重；内容变了才换新的。
      const key = JSON.stringify([title.value, description.value, project.value, goal.value, workdir.value]);
      if (prior && key !== prior) requestId = newRequestId();
      prior = key; dialog.dataset.previous = prior; dialog.dataset.requestId = requestId;
      try {
        const request = isTask
          ? taskCreateCommand({ title: title.value, description: description.value, project: project.value || undefined, parent }, requestId)
          : projectCreateCommand({ title: title.value, description: description.value, goal: goal.value, workdir: workdir.value }, requestId);
        const result = await this.client.workCommand(request);
        if (!this.active) return;
        dialog.dataset.dirty = "false"; dialog.close();
        toast(isTask ? t("Task created") : t("Project created"));
        this.changed();
        if (parent && result.kind === "task") { await this.load(); await this.open(parent, true); }
        else if (preset && result.kind === "task") { await this.load(); await this.open(preset, true); }
        else if (result.kind === "task" || result.kind === "project") { await this.load(); await this.open(result.kind === "task" ? result.task.id : result.project.id); }
      } catch (cause) {
        clear(error, failure(t("{0} Your input is kept; if the connection dropped, refresh the list to check whether it was created.", errorText(cause))));
      } finally { pending = false; save.disabled = false; }
    });
    title.focus();
  }
}

function spin(event: Event): void {
  const button = event.currentTarget as HTMLElement;
  button.classList.remove("spin"); void button.offsetWidth; button.classList.add("spin");
}

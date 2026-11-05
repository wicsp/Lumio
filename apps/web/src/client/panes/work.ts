/**
 * 项目与任务（ADR 0026、0032）：任务按「轮到谁」分组，项目按状态分组；右侧详情。
 * 列表上可直接交回、完成、取消（带 revision）；新建在对话框里完成，新建不会委派。
 */
import type { WorkProject, WorkTask } from "@lumio/schema";
import { PROJECT_STATUSES } from "@lumio/schema";
import { errorText, isConflict, type Client, type HubExtras } from "../api.ts";
import { newRequestId, projectCreateCommand, taskCreateCommand } from "../commands.ts";
import { autosize, clear, debounce, empty, failure, field, h, icon, loading, openDialog, openMenu, placeholder, select, statusIcon, toast } from "../dom.ts";
import { dueLabel } from "../format.ts";
import { PROJECT_LABELS } from "../labels.ts";
import { TURN_ACTION_DONE, TURN_ACTION_ICONS, TURN_ACTION_LABELS, TURN_GROUPS, TURN_GROUP_LABELS, turnActionCommand, turnActions, turnGroup, turnIcon, turnText, type TurnAction, type TurnGroup } from "../turn.ts";
import { listKeys, markSelected } from "../list-keys.ts";
import type { Navigate } from "../navigation.ts";
import { WorkEditor } from "./work-editor.ts";
import { t } from "../i18n.ts";

type Mode = "tasks" | "projects";
const PROJECT_ORDER = ["active", "planning", "paused", "done"] as const;
const FOLDED_BY_DEFAULT = new Set(["done", "cancelled", "hold"]);

export class WorkPane {
  private mode: Mode = "tasks";
  private split = h("div", { class: "split" });
  private list = h("div", { class: "list-scroll" });
  private detail = h("section", { class: "detail-pane", "aria-live": "polite" });
  private query = h("input", { type: "search", name: "work-search", placeholder: t("Search tasks"), autocomplete: "off" });
  private statusFilter = "";
  private projectFilter = "";
  private statusButton = h("button", { type: "button", class: "filter-btn" });
  private projectButton = h("button", { type: "button", class: "filter-btn" });
  private segTasks = h("button", { type: "button", "aria-pressed": "true", onclick: () => this.switchMode("tasks") }, t("Tasks"));
  private segProjects = h("button", { type: "button", "aria-pressed": "false", onclick: () => this.switchMode("projects") }, t("Projects"));
  private projects: WorkProject[] = [];
  private tasks: WorkTask[] = [];
  private folded = new Set(FOLDED_BY_DEFAULT);
  private selected?: string;
  private editor?: WorkEditor;
  private listGeneration = 0;
  private detailGeneration = 0;
  private active = true;
  private unbindKeys: () => void;

  constructor(root: HTMLElement, private client: Client, private hub: HubExtras, initialId: string | undefined, private navigate: Navigate, private changed: () => void) {
    this.statusButton.addEventListener("click", () => this.pickStatusFilter());
    this.projectButton.addEventListener("click", () => this.pickProjectFilter());
    this.query.addEventListener("input", debounce(() => void this.load(), 200));
    this.query.addEventListener("keydown", event => { if (event.key === "Escape" && this.query.value) { this.query.value = ""; void this.load(); } });
    root.append(
      h("header", { class: "bar" },
        h("h1", { class: "bar-title" }, t("Projects & tasks")),
        h("div", { class: "segmented", role: "group", "aria-label": t("View") }, this.segTasks, this.segProjects),
        h("span", { class: "bar-spacer" }),
        h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: (event: Event) => { spin(event); void this.load(); if (this.selected) void this.open(this.selected, true); } }, icon("refresh")),
        h("button", { type: "button", class: "btn btn-primary", title: t("New (C)"), onclick: () => this.create() }, icon("plus"), h("span", { class: "hide-narrow" }, t("New")))),
      this.split);
    this.split.append(
      h("div", { class: "list-pane" },
        h("div", { class: "list-tools" }, h("label", { class: "search-box" }, icon("search"), this.query), this.statusButton, this.projectButton),
        this.list),
      this.detail);
    this.renderFilters();
    this.showPlaceholder();
    this.unbindKeys = listKeys(this.list, id => void this.open(id));
    void this.load().then(() => {
      if (!initialId || !this.active) return;
      if (initialId.startsWith("prj_") && this.mode !== "projects") this.switchMode("projects", initialId);
      else void this.open(initialId);
    });
  }

  dispose(): void { this.active = false; this.listGeneration++; this.detailGeneration++; this.editor?.dispose(); this.unbindKeys(); }
  get dirty(): boolean { return this.editor?.dirty ?? false; }
  canLeave(): boolean { return this.editor?.canLeave() ?? true; }
  intent(name: string): void {
    if (name === "new") { if (this.mode !== "tasks") this.switchMode("tasks"); this.create(); }
    else if (name === "new-project") { if (this.mode !== "projects") this.switchMode("projects"); this.create(); }
  }

  // ───────────── 列表 ─────────────

  private switchMode(mode: Mode, thenOpen?: string): void {
    if (mode === this.mode || !this.canLeave()) return;
    this.detailGeneration++; this.editor?.dispose(); this.editor = undefined; this.selected = undefined;
    this.mode = mode; this.statusFilter = ""; this.projectFilter = "";
    this.segTasks.setAttribute("aria-pressed", String(mode === "tasks"));
    this.segProjects.setAttribute("aria-pressed", String(mode === "projects"));
    this.query.placeholder = mode === "tasks" ? t("Search tasks") : t("Search projects");
    this.renderFilters(); this.showPlaceholder();
    void this.load().then(() => { if (thenOpen && this.active) void this.open(thenOpen); });
  }

  private renderFilters(): void {
    const label = this.mode === "tasks" ? TURN_GROUP_LABELS[this.statusFilter as TurnGroup] : PROJECT_LABELS[this.statusFilter];
    const glyph = this.mode === "tasks" ? turnIcon(this.statusFilter as TurnGroup) : statusIcon(this.statusFilter);
    clear(this.statusButton, this.statusFilter ? glyph : icon("down"), this.statusFilter ? label! : this.mode === "tasks" ? t("Turn") : t("Status"));
    this.statusButton.classList.toggle("is-set", !!this.statusFilter);
    this.projectButton.hidden = this.mode !== "tasks";
    const project = this.projects.find(p => p.id === this.projectFilter);
    clear(this.projectButton, icon("folder"), project?.title ?? t("Projects"));
    this.projectButton.classList.toggle("is-set", !!project);
  }

  private pickStatusFilter(): void {
    const items = this.mode === "tasks"
      ? TURN_GROUPS.map(group => ({ value: group as string, label: TURN_GROUP_LABELS[group], icon: turnIcon(group), selected: this.statusFilter === group }))
      : PROJECT_STATUSES.map(s => ({ value: s as string, label: PROJECT_LABELS[s]!, icon: statusIcon(s), selected: this.statusFilter === s }));
    openMenu(this.statusButton, [{ value: "", label: this.mode === "tasks" ? t("Everyone") : t("All statuses"), selected: !this.statusFilter }, ...items],
      value => { this.statusFilter = value; this.renderFilters(); void this.load(); });
  }

  private pickProjectFilter(): void {
    openMenu(this.projectButton, [{ value: "", label: t("All projects"), selected: !this.projectFilter },
      ...this.projects.map(p => ({ value: p.id, label: p.title, icon: icon("folder"), selected: this.projectFilter === p.id }))],
      value => { this.projectFilter = value; this.renderFilters(); void this.load(); }, { filter: this.projects.length > 6, placeholder: t("Find a project") });
  }

  private async load(): Promise<void> {
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
      const tasks = this.statusFilter ? all.filter(task => turnGroup(task) === this.statusFilter) : all;
      this.renderGroups(TURN_GROUPS, tasks, turnGroup, t => this.taskRow(t), TURN_GROUP_LABELS, group => turnIcon(group as TurnGroup),
        q || this.statusFilter || this.projectFilter ? t("No matching tasks. Try another search or clear the filters.") : t("No tasks yet. Press C to create the first one."));
    } catch (error) {
      if (generation === this.listGeneration && this.active) clear(this.list, failure(errorText(error), () => this.load()));
    }
  }

  private renderGroups<T extends WorkTask | WorkProject>(order: readonly string[], items: T[], groupOf: (item: T) => string, row: (item: T) => HTMLElement, labels: Record<string, string>, glyph: (group: string) => SVGSVGElement, emptyText: string): void {
    if (!items.length) { clear(this.list, empty(emptyText, this.mode === "tasks" ? { label: t("New task"), run: () => this.create() } : { label: t("New project"), run: () => this.create() })); return; }
    const groups = order.map(status => [status, items.filter(i => groupOf(i) === status)] as const).filter(([, list]) => list.length);
    clear(this.list, ...groups.map(([status, list]) => {
      const group = h("section", { class: `group${this.folded.has(status) && !this.statusFilter ? " collapsed" : ""}` });
      const head = h("button", { type: "button", class: "group-head", "aria-expanded": String(!group.classList.contains("collapsed")), onclick: () => {
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
    const statusBtn = h("button", { type: "button", class: "status-btn", title: turnText(task), "aria-label": t("Change who has it (now: {0})", turnText(task)),
      onclick: (event: Event) => { event.stopPropagation(); this.quickTurn(task, statusBtn); } }, turnIcon(group));
    // 不是轮到你的待办时，副标题说明轮到谁（agent、外部、搁置、需要你处理的原因）。
    const holder = group === "todo" || group === "done" || group === "cancelled" ? undefined : turnText(task);
    const sub = [project && h("span", { class: "project-chip" }, icon("folder", "icon"), project),
      holder && h("span", { class: `who-chip${group === "needs" ? " is-needs" : ""}` }, icon(group === "agents" ? "bot" : group === "external" ? "clock" : group === "hold" ? "pause" : "alert"), holder),
      task.plan && h("span", { class: "who-chip", title: t("Has a handoff plan") }, icon("route"))].filter(Boolean) as HTMLElement[];
    return h("div", { class: `row t-${group}`, "data-id": task.id, role: "button", tabindex: "0",
      onclick: () => void this.open(task.id), onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter" && event.target === event.currentTarget) void this.open(task.id); } },
      statusBtn,
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, task.title), sub.length ? h("span", { class: "row-sub" }, ...sub) : null),
      h("span", { class: "row-meta" },
        due && task.outcome === "open" && h("span", { class: `due${due.overdue ? " overdue" : due.soon ? " soon" : ""}`, title: t("Due") }, due.text)));
  }

  private projectRow(project: WorkProject): HTMLElement {
    const related = this.tasks.filter(t => t.project === project.id && t.outcome !== "cancelled");
    const done = related.filter(t => t.outcome === "done").length;
    const fill = h("span", { class: "progress-fill" });
    fill.style.width = `${related.length ? Math.round((done / related.length) * 100) : 0}%`;
    return h("div", { class: `row ${project.status}`, "data-id": project.id, role: "button", tabindex: "0", onclick: () => void this.open(project.id),
      onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter") void this.open(project.id); } },
      statusIcon(project.status),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, project.title), project.goal && h("span", { class: "row-sub" }, project.goal)),
      h("span", { class: "row-meta" }, related.length ? h("span", { class: "progress", title: t("{0} of {1} done", done, related.length) }, fill) : null, related.length ? `${done}/${related.length}` : t("No tasks")));
  }

  private quickTurn(task: WorkTask, anchor: HTMLElement): void {
    openMenu(anchor, turnActions(task).map(action => ({ value: action, label: TURN_ACTION_LABELS[action], icon: icon(TURN_ACTION_ICONS[action]) })), async value => {
      const action = value as TurnAction;
      let note: string | undefined;
      if (action === "external") { note = prompt(t("What are you waiting for?"))?.trim(); if (!note) return; }
      if (task.turn.reason === "working" && action !== "external" && !confirm(t("An agent is still working on this task. Stop its round and continue?"))) return;
      try {
        await this.client.workCommand(turnActionCommand(task, action, note));
        toast(TURN_ACTION_DONE[action]);
        this.changed();
        await this.load();
        if (this.selected === task.id && !this.editor?.dirty) void this.open(task.id, true);
      } catch (cause) {
        toast(isConflict(cause) ? t("The task changed elsewhere; the list was refreshed") : errorText(cause), "error");
        void this.load();
      }
    });
  }

  // ───────────── 详情 ─────────────

  private showPlaceholder(): void {
    this.split.classList.remove("has-detail");
    clear(this.detail, placeholder(this.mode === "tasks" ? "work" : "folder", this.mode === "tasks" ? t("Select a task to see details. Use J / K to move between tasks.") : t("Select a project to see its goal and progress.")));
  }

  async open(id: string, quiet = false): Promise<void> {
    if (!quiet && id === this.selected && this.editor) return;
    if (!quiet && !this.canLeave()) return;
    if (id.startsWith("prj_") !== (this.mode === "projects")) { this.switchMode(id.startsWith("prj_") ? "projects" : "tasks", id); return; }
    const generation = ++this.detailGeneration;
    this.selected = id; markSelected(this.list, id);
    this.split.classList.add("has-detail");
    if (!quiet) { this.editor?.dispose(); this.editor = undefined; clear(this.detail, loading()); }
    try {
      const object = id.startsWith("task_") ? await this.client.workTask(id) : await this.client.workProject(id);
      if (!this.active || generation !== this.detailGeneration) return;
      const scroll = this.detail.scrollTop;
      this.editor?.dispose();
      clear(this.detail);
      this.editor = new WorkEditor(this.detail, this.client, this.hub, object, this.projects, {
        changed: () => { this.changed(); void this.load(); },
        reload: () => void this.open(id, true),
        back: () => { if (this.canLeave()) { this.detailGeneration++; this.editor?.dispose(); this.editor = undefined; this.selected = undefined; markSelected(this.list, undefined); this.showPlaceholder(); } },
        navigate: this.navigate,
        openProject: projectId => this.switchMode("projects", projectId),
      });
      if (quiet) this.detail.scrollTop = scroll;
    } catch (error) {
      if (this.active && generation === this.detailGeneration) clear(this.detail, failure(errorText(error), () => this.open(id, true)));
    }
  }

  // ───────────── 新建 ─────────────

  private create(): void {
    const isTask = this.mode === "tasks";
    const title = h("input", { name: "title", required: true, placeholder: isTask ? t("What needs to get done?") : t("Project name"), autocomplete: "off" });
    const description = autosize(h("textarea", { name: "description", rows: "4", placeholder: isTask ? t("Background, approach or definition of done (optional, Markdown)") : t("Project background (optional, Markdown)") }));
    const goal = h("input", { name: "goal", placeholder: t("What should this phase achieve?"), autocomplete: "off" });
    const project = select("project", [["", t("No project")], ...this.projects.filter(p => p.status !== "done").map(p => [p.id, p.title] as [string, string])], this.projectFilter);
    const error = h("div", { class: "form-message", role: "alert" });
    const formId = `create-${newRequestId()}`;
    const form = h("form", { id: formId, class: "form-stack" },
      field(isTask ? t("Title") : t("Name"), title),
      isTask ? field(t("Project"), project) : field(t("Goal"), goal),
      field(t("Description"), description), error);
    const save = h("button", { type: "submit", form: formId, class: "btn btn-primary" }, isTask ? t("Create task") : t("Create project"), h("kbd", {}, "⌘↵"));
    const dialog = openDialog(isTask ? t("New task") : t("New project"), form, [save]);
    form.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); form.requestSubmit(); } });
    let pending = false, prior = "", requestId = newRequestId();
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (pending) return;
      pending = true; save.disabled = true; clear(error);
      // 同样的内容重试时复用 request_id，Hub 据此去重；内容变了才换新的。
      const key = JSON.stringify([title.value, description.value, project.value, goal.value]);
      if (prior && key !== prior) requestId = newRequestId();
      prior = key;
      try {
        const request = isTask
          ? taskCreateCommand({ title: title.value, description: description.value, project: project.value || undefined }, requestId)
          : projectCreateCommand({ title: title.value, description: description.value, goal: goal.value }, requestId);
        const result = await this.client.workCommand(request);
        if (!this.active) return;
        dialog.dataset.dirty = "false"; dialog.close();
        toast(isTask ? t("Task created") : t("Project created"));
        this.changed();
        if (result.kind === "task" || result.kind === "project") { await this.load(); await this.open(result.kind === "task" ? result.task.id : result.project.id); }
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

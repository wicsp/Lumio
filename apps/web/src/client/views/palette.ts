import { turnGroup, turnIcon } from "../turn.ts";
/** ⌘K 命令面板：跳转模块、新建、搜索任务/项目/知识。只读查询，不执行写操作。 */
import type { WorkProject, WorkTask } from "@lumio/schema";
import type { Client } from "../api.ts";
import { clear, debounce, h, icon } from "../dom.ts";
import { SECTIONS, type Navigate, type Section } from "../navigation.ts";
import { lang, setLang, t, translated } from "../i18n.ts";
import { LANGS, THEMES } from "../settings.ts";
import { setTheme, themeChoice } from "../theme.ts";

interface Item { key: string; group: string; label: string; shortcut?: string; detail?: string; icon: Node; run: () => void }

const NOTE_TYPE: Record<string, string> = translated({ paper: "Paper", idea: "Idea", experiment: "Experiment", source: "Source", post: "Post", asset: "Asset" });

export class CommandPalette {
  private dialog?: HTMLDialogElement;
  private input = h("input", { type: "text", role: "combobox", "aria-autocomplete": "list", "aria-controls": "command-results",
    "aria-expanded": "false", placeholder: t("Search or jump to"), autocomplete: "off", spellcheck: "false", "aria-label": t("Command palette") });
  private list = h("div", { class: "palette-list", id: "command-results", role: "listbox", "aria-label": t("Search results"), tabindex: "-1" });
  private status = h("p", { class: "palette-status", role: "status" });
  private items: Item[] = [];
  private rows: HTMLButtonElement[] = [];
  private notes: Item[] = [];
  private noteSearch: "idle" | "pending" | "error" = "idle";
  private index = 0;
  private generation = 0;
  private cache?: { tasks: WorkTask[]; projects: WorkProject[]; at: number };
  private prefetching = false;

  constructor(private client: Client, private navigate: Navigate) {
    this.input.addEventListener("input", () => {
      const query = this.input.value.trim();
      const generation = ++this.generation;
      this.notes = [];
      this.noteSearch = query ? "pending" : "idle";
      this.list.scrollTop = 0;
      this.renderStatic();
      if (query) this.search(query, generation);
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "ArrowDown") { event.preventDefault(); this.move(1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); this.move(-1); }
      else if (event.key === "Enter") { event.preventDefault(); this.run(this.items[this.index]); }
    };
    this.input.addEventListener("keydown", onKey);
    this.list.addEventListener("keydown", onKey);
  }

  open(gamepad = false): void {
    if (this.dialog?.open) { this.input.select(); return; }
    this.dialog?.remove();
    this.generation++;
    this.input.value = "";
    this.notes = [];
    this.noteSearch = "idle";
    this.list.scrollTop = 0;
    const dialog = h("dialog", { class: "dialog palette", "aria-label": t("Command palette") },
      h("div", { class: "palette-input" }, icon("search"), this.input,
        h("button", { type: "button", class: "icon-btn palette-close", "aria-label": t("Close"), title: t("Close"),
          onclick: () => dialog.close() }, icon("close"))),
      this.list, this.status);
    this.dialog = dialog;
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (this.dialog !== dialog) return;
      this.dialog = undefined;
      this.input.setAttribute("aria-expanded", "false");
      this.generation++;
    });
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
    dialog.showModal();
    this.renderStatic();
    (gamepad ? this.list : this.input).focus({ preventScroll: true });
    void this.prefetch();
  }

  dispose(): void { this.generation++; this.dialog?.close(); }

  gamepad(step?: number): void {
    if (step) this.move(step);
    else this.run(this.items[this.index]);
  }

  private commands(): Item[] {
    const go = (section: Section, intent?: string) => () => this.navigate(section, undefined, intent);
    return [
      { key: "capture", group: t("Actions"), label: t("Save a link to Inbox"), icon: icon("inbox"), run: go("inbox", "capture") },
      { key: "new-note", group: t("Actions"), label: t("New note"), icon: icon("knowledge"), run: go("knowledge", "new") },
      { key: "new-task", group: t("Actions"), label: t("New task"), icon: icon("plus"), run: go("work", "new") },
      { key: "new-project", group: t("Actions"), label: t("New project"), icon: icon("folder"), run: go("work", "new-project") },
      { key: "ask", group: t("Actions"), label: t("Ask the assistant"), icon: icon("assistant"), run: go("assistant", "new") },
      { key: "new-routine", group: t("Actions"), label: t("New routine"), icon: icon("repeat"), run: go("execution", "new-routine") },
      ...SECTIONS.map(({ key, label, icon: glyph, key2 }) => ({ key, group: t("Go to"), label: t(label), shortcut: key2, icon: icon(glyph), run: go(key) })),
      { key: "settings", group: t("Go to"), label: t("Settings"), icon: icon("settings"), run: go("settings") },
      { key: "trash", group: t("Go to"), label: t("Recently deleted"), icon: icon("trash"), run: go("trash") },
      ...THEMES.filter(([key]) => key !== themeChoice()).map(([key, label, name]) => ({ key: `theme:${key}`, group: t("Settings"), label: `${t("Theme")}: ${t(label)}`, icon: icon(name), run: () => setTheme(key) })),
      ...LANGS.filter(([key]) => key !== lang()).map(([key, label]) => ({ key: `lang:${key}`, group: t("Settings"), label: `${t("Language")}: ${label}`, icon: icon("globe"), run: () => setLang(key) })),
    ];
  }

  private async prefetch(): Promise<void> {
    if (this.prefetching || (this.cache && Date.now() - this.cache.at < 30_000)) return;
    this.prefetching = true;
    try {
      const [tasks, projects] = await Promise.all([this.client.workTasks(), this.client.workProjects()]);
      this.cache = { tasks, projects, at: Date.now() };
      if (this.dialog?.open) this.renderStatic(true);
    } catch { /* 面板仍可用于跳转 */ }
    finally { this.prefetching = false; }
  }

  /** 命令与本地缓存的任务/项目：即时过滤。 */
  private renderStatic(preserveSelection = false): void {
    const selected = preserveSelection ? this.items[this.index]?.key : undefined;
    const q = this.input.value.trim().toLowerCase();
    const match = (text: string) => !q || text.toLowerCase().includes(q);
    const items: Item[] = this.commands().filter(item => match(item.label));
    if (this.cache) {
      const open = this.cache.tasks.filter(t => (q ? t.outcome === "open" : ["needs", "todo"].includes(turnGroup(t))) && match(t.title));
      items.push(...open.slice(0, q ? 8 : 5).map(task => ({ key: task.id, group: q ? t("Tasks") : t("In progress"), label: task.title, detail: this.cache!.projects.find(p => p.id === task.project)?.title,
        icon: turnIcon(turnGroup(task)), run: () => this.navigate("work", task.id) })));
      if (q) items.push(...this.cache.projects.filter(p => match(p.title)).slice(0, 5).map(project => ({ key: project.id, group: t("Projects"), label: project.title, icon: icon("folder"), run: () => this.navigate("work", project.id) })));
    }
    items.push(...this.notes);
    this.items = items;
    this.render(Math.max(0, items.findIndex(item => item.key === selected)));
  }

  private search = debounce(async (query: string, generation: number) => {
    const current = () => generation === this.generation && this.dialog?.open;
    if (!current()) return;
    try {
      const result = await this.client.search(query, { limit: 6 });
      if (!current()) return;
      this.notes = result.hits.filter(hit => NOTE_TYPE[hit.note.type]).map(({ note }) => ({
        key: `note:${note.id ?? note.path}`, group: t("Knowledge"), label: note.title,
        detail: NOTE_TYPE[note.type], icon: icon("knowledge"), run: () => this.navigate("knowledge", note.id ?? note.path),
      }));
      this.noteSearch = "idle";
    } catch {
      if (!current()) return;
      this.noteSearch = "error";
    }
    this.renderStatic(true);
  }, 180);

  private render(index: number): void {
    const groups = new Map<string, HTMLElement>();
    this.rows = this.items.map((item, i) => {
      let group = groups.get(item.group);
      if (!group) {
        const id = `command-group-${groups.size}`;
        group = h("div", { class: "palette-group", role: "group", "aria-labelledby": id }, h("p", { id, class: "palette-group-title" }, item.group));
        groups.set(item.group, group);
      }
      const row = h("button", { id: `command-option-${i}`, type: "button", role: "option", class: "palette-item", tabindex: "-1", "aria-selected": "false",
        onpointermove: () => { if (i !== this.index) this.select(i); }, onclick: () => this.run(item) },
        item.icon, h("span", { class: "label" }, item.label),
        item.detail && h("span", { class: "palette-detail" }, item.detail), item.shortcut && h("kbd", {}, item.shortcut),
        h("span", { class: "palette-accept", "aria-hidden": "true" }, "↵"));
      group.append(row);
      return row;
    });
    clear(this.list, ...groups.values());
    this.input.setAttribute("aria-expanded", String(this.rows.length > 0));
    const message = this.noteSearch === "pending" ? t("Searching…")
      : this.noteSearch === "error" ? t("Could not search notes") : t("No results");
    this.status.textContent = this.items.length ? "" : message;
    this.select(index, true);
  }

  private select(index: number, reveal = false): void {
    const previous = this.rows[this.index];
    previous?.classList.remove("is-active");
    previous?.setAttribute("aria-selected", "false");
    this.index = index;
    const row = this.rows[index];
    row?.classList.add("is-active");
    row?.setAttribute("aria-selected", "true");
    for (const target of [this.input, this.list]) {
      if (row) target.setAttribute("aria-activedescendant", row.id);
      else target.removeAttribute("aria-activedescendant");
    }
    if (reveal) row?.scrollIntoView({ block: "nearest" });
  }

  private move(step: number): void {
    if (!this.items.length) return;
    this.select((this.index + step + this.items.length) % this.items.length, true);
  }

  private run(item: Item | undefined): void {
    if (!item) return;
    this.dialog?.close();
    item.run();
  }
}

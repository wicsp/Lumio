import { turnGroup, turnIcon } from "../turn.ts";
/** ⌘K 命令面板：跳转模块、新建、搜索任务/项目/知识。只读查询，不执行写操作。 */
import type { WorkProject, WorkTask } from "@lumio/schema";
import type { Client } from "../api.ts";
import { clear, debounce, h, icon, statusIcon } from "../dom.ts";
import type { Navigate, Section } from "../navigation.ts";
import { lang, setLang, t, translated } from "../i18n.ts";
import { LANGS, THEMES } from "../settings.ts";
import { setTheme, themeChoice } from "../theme.ts";

interface Item { group: string; label: string; hint?: string; icon: Node; run: () => void }

const NOTE_TYPE: Record<string, string> = translated({ paper: "Paper", idea: "Idea", experiment: "Experiment", source: "Source", post: "Post", asset: "Asset" });

export class CommandPalette {
  private dialog?: HTMLDialogElement;
  private input = h("input", { type: "text", placeholder: t("Search tasks, projects, notes, or type a command…"), autocomplete: "off", spellcheck: "false", "aria-label": t("Command palette") });
  private list = h("div", { class: "palette-list", role: "listbox" });
  private items: Item[] = [];
  private index = 0;
  private generation = 0;
  private cache?: { tasks: WorkTask[]; projects: WorkProject[]; at: number };

  constructor(private client: Client, private navigate: Navigate) {
    this.input.addEventListener("input", () => { this.index = 0; this.renderStatic(); this.search(); });
    this.input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "ArrowDown") { event.preventDefault(); this.move(1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); this.move(-1); }
      else if (event.key === "Enter") { event.preventDefault(); this.run(this.items[this.index]); }
    });
  }

  open(): void {
    if (this.dialog?.open) { this.input.select(); return; }
    this.input.value = "";
    this.index = 0;
    this.dialog = h("dialog", { class: "dialog palette", "aria-label": t("Command palette") },
      h("div", { class: "palette-input" }, icon("search"), this.input),
      this.list,
      h("div", { class: "palette-foot" }, h("span", {}, t("↑↓ select")), h("span", {}, t("↵ open")), h("span", {}, t("esc close"))));
    this.dialog.addEventListener("close", () => { this.dialog?.remove(); this.dialog = undefined; });
    this.dialog.addEventListener("click", event => { if (event.target === this.dialog) this.dialog?.close(); });
    document.body.append(this.dialog);
    this.dialog.showModal();
    this.input.focus();
    this.renderStatic();
    void this.prefetch();
  }

  dispose(): void { this.generation++; this.dialog?.close(); }

  private commands(): Item[] {
    const go = (section: Section, intent?: string) => () => this.navigate(section, undefined, intent);
    return [
      { group: t("Actions"), label: t("New task"), hint: "C", icon: icon("plus"), run: go("work", "new") },
      { group: t("Actions"), label: t("New project"), icon: icon("folder"), run: go("work", "new-project") },
      { group: t("Actions"), label: t("Ask the assistant"), icon: icon("assistant"), run: go("assistant", "new") },
      { group: t("Actions"), label: t("New routine"), icon: icon("repeat"), run: go("execution", "new-routine") },
      ...THEMES.filter(([key]) => key !== themeChoice()).map(([key, label, name]) => ({ group: t("Settings"), label: `${t("Theme")}: ${t(label)}`, icon: icon(name), run: () => setTheme(key) })),
      ...LANGS.filter(([key]) => key !== lang()).map(([key, label]) => ({ group: t("Settings"), label: `${t("Language")}: ${label}`, icon: icon("globe"), run: () => setLang(key) })),
      { group: t("Go to"), label: t("Today"), hint: "1", icon: icon("home"), run: go("overview") },
      { group: t("Go to"), label: t("Projects & tasks"), hint: "2", icon: icon("work"), run: go("work") },
      { group: t("Go to"), label: t("Knowledge"), hint: "3", icon: icon("knowledge"), run: go("knowledge") },
      { group: t("Go to"), label: t("Execution"), hint: "4", icon: icon("execution"), run: go("execution") },
      { group: t("Go to"), label: t("Assistant"), hint: "5", icon: icon("assistant"), run: go("assistant") },
      { group: t("Go to"), label: t("Approvals"), hint: "6", icon: icon("approvals"), run: go("approvals") },
      { group: t("Go to"), label: t("Settings"), icon: icon("settings"), run: go("settings") },
    ];
  }

  private async prefetch(): Promise<void> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return;
    try {
      const [tasks, projects] = await Promise.all([this.client.workTasks(), this.client.workProjects()]);
      this.cache = { tasks, projects, at: Date.now() };
      if (this.dialog?.open) this.renderStatic();
    } catch { /* 面板仍可用于跳转 */ }
  }

  /** 命令与本地缓存的任务/项目：即时过滤。 */
  private renderStatic(extra: Item[] = []): void {
    const q = this.input.value.trim().toLowerCase();
    const match = (text: string) => !q || text.toLowerCase().includes(q);
    const items: Item[] = this.commands().filter(item => match(item.label));
    if (this.cache) {
      const open = this.cache.tasks.filter(t => (q ? t.outcome === "open" : ["needs", "todo"].includes(turnGroup(t))) && match(t.title));
      items.push(...open.slice(0, q ? 8 : 5).map(task => ({ group: q ? t("Tasks") : t("In progress"), label: task.title, hint: this.cache!.projects.find(p => p.id === task.project)?.title,
        icon: turnIcon(turnGroup(task)), run: () => this.navigate("work", task.id) })));
      if (q) items.push(...this.cache.projects.filter(p => match(p.title)).slice(0, 5).map(project => ({ group: t("Projects"), label: project.title, icon: icon("folder"), run: () => this.navigate("work", project.id) })));
    }
    items.push(...extra);
    this.items = items;
    this.render();
  }

  private search = debounce(async () => {
    const q = this.input.value.trim();
    const generation = ++this.generation;
    if (!q) return;
    try {
      const result = await this.client.search(q, { limit: 6 });
      if (generation !== this.generation || !this.dialog?.open) return;
      this.renderStatic(result.hits.filter(hit => NOTE_TYPE[hit.note.type]).map(hit => ({ group: t("Knowledge"), label: hit.note.title, hint: NOTE_TYPE[hit.note.type],
        icon: icon("knowledge"), run: () => this.navigate("knowledge", hit.note.id ?? hit.note.path) })));
    } catch { /* 知识库不可用时只显示本地结果 */ }
  }, 180);

  private render(): void {
    this.index = Math.min(this.index, Math.max(0, this.items.length - 1));
    const nodes: Node[] = [];
    let group = "";
    this.items.forEach((item, i) => {
      if (item.group !== group) { group = item.group; nodes.push(h("p", { class: "palette-group" }, group)); }
      nodes.push(h("button", { type: "button", role: "option", class: `palette-item${i === this.index ? " is-active" : ""}`, "aria-selected": String(i === this.index),
        onmousemove: () => { if (this.index !== i) { this.index = i; this.render(); } }, onclick: () => this.run(item) },
        item.icon, h("span", { class: "label" }, item.label), item.hint && h("span", { class: "hint" }, item.hint)));
    });
    if (!this.items.length) nodes.push(h("p", { class: "state" }, t("No results")));
    clear(this.list, ...nodes);
    this.list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }

  private move(step: number): void {
    if (!this.items.length) return;
    this.index = (this.index + step + this.items.length) % this.items.length;
    this.render();
  }

  private run(item: Item | undefined): void {
    if (!item) return;
    this.dialog?.close();
    item.run();
  }
}

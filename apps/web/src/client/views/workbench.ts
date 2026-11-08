import { referenceLinks } from "../reference-links.ts";
import { drafts } from "../drafts.ts";
import { executionGroups } from "../execution-groups.ts";
import { turnGroup } from "../turn.ts";
import type { Session } from "../api.ts";
import { h, icon, typing } from "../dom.ts";
import { OverviewPane } from "../panes/overview.ts";
import { KnowledgePane } from "../panes/knowledge.ts";
import { WorkPane } from "../panes/work.ts";
import { ExecutionPane } from "../panes/execution.ts";
import { AssistantPane } from "../panes/assistant.ts";
import { ApprovalsPane } from "../panes/approvals.ts";
import { CommandPalette } from "./palette.ts";
import type { Navigate, Pane, Section } from "../navigation.ts";
import { t } from "../i18n.ts";
import { SettingsPane } from "../panes/settings-page.ts";
import { TrashPane } from "../panes/trash.ts";

/** short：窄屏底栏的短名；没有 short 的模块不进底栏，从今日页和提醒进入（ADR 0028）。 */
export const SECTIONS: Array<{ key: Exclude<Section, "settings" | "trash">; label: string; short?: string; icon: string; key2: string }> = [
  { key: "overview", label: "Today", short: "Today", icon: "home", key2: "1" },
  { key: "work", label: "Work", short: "Work", icon: "work", key2: "2" },
  { key: "knowledge", label: "Knowledge", short: "Knowledge", icon: "knowledge", key2: "3" },
  { key: "execution", label: "Execution", icon: "execution", key2: "4" },
  { key: "assistant", label: "Assistant", short: "Assistant", icon: "assistant", key2: "5" },
  { key: "approvals", label: "Approvals", icon: "approvals", key2: "6" },
];

type PaneKey = Section | "projects";
type MountedPane = { target: HTMLElement; pane: Pane };

export class WorkbenchView {
  private main = h("main", { class: "main", id: "content", tabindex: "-1" });
  private nav = new Map<Section, HTMLButtonElement>();
  private counts = new Map<Section, HTMLElement>();
  // Keep mounted views and their scroll/editor state in this verified session only.
  private panes = new Map<PaneKey, MountedPane>();
  private current?: MountedPane;
  private section: Section = "overview";
  private workMode: "tasks" | "projects" = "tasks";
  private currentHash = "";
  private palette: CommandPalette;
  private disposeReferenceLinks: () => void;
  private countTimer: ReturnType<typeof setInterval>;

  private routeGeneration = 0;
  private readonly onRoute = async () => {
    const generation=++this.routeGeneration, route=this.readRoute();
    if (!(await this.beforeLeave())) { if(generation===this.routeGeneration) history.pushState(null, "", this.currentHash || "#overview"); return; }
    if(generation!==this.routeGeneration)return;
    this.show(route.section, route.id);
  };
  private readonly onKey = (event: KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "k") { event.preventDefault(); this.palette.open(); return; }
    if (typing(event) || mod || event.altKey || document.querySelector("dialog[open]")) return;
    const section = SECTIONS.find(s => s.key2 === event.key);
    if (section) { event.preventDefault(); this.go(section.key); return; }
    if (event.key === "c") { event.preventDefault(); this.go("work", undefined, "new"); return; }
    if (event.key === "/") {
      const search = this.current?.target.querySelector<HTMLInputElement>("input[type=search]");
      if (search && search.offsetParent !== null) { event.preventDefault(); search.focus(); search.select(); }
    }
  };
  /** 实时刷新（R4-8）：回到前台或窗口重新获得焦点、收到推送时立即刷新；页面可见时每 15 秒静默刷新一次。 */
  private lastRefresh = 0;
  private readonly refreshNow = () => {
    if (document.visibilityState !== "visible" || document.querySelector("dialog[open]")) return;
    if (Date.now() - this.lastRefresh < 2000) return;
    this.lastRefresh = Date.now();
    this.current?.pane.liveRefresh?.();
    void this.refreshCounts();
  };
  private readonly onVisible = () => { if (document.visibilityState === "visible") this.refreshNow(); else void this.current?.pane.beforeLeave?.(); };
  private liveTimer: ReturnType<typeof setInterval> = setInterval(() => this.refreshNow(), 15_000);
  private readonly onUnload = () => { this.current?.pane.canLeave?.(); };

  private name: string;
  private account: HTMLButtonElement;
  private trashButton: HTMLButtonElement;
  /** 进入设置页之前所在的位置，设置页的返回键回到这里。 */
  private beforeSettings = "#overview";
  /** 语言切换被推迟时，App 在下一次切换模块前重建界面；返回 true 表示已接管。 */
  constructor(root: HTMLElement, private session: Session, humans: string[], private logout: () => void, private beforeShow: () => boolean = () => false) {
    this.disposeReferenceLinks = referenceLinks(this.main, session.client, ref => this.go("knowledge",ref));
    this.palette = new CommandPalette(session.client, (section, id, intent) => this.go(section, id, intent));
    const nav = h("nav", { class: "nav", "aria-label": t("Main navigation") });
    for (const s of SECTIONS) {
      if (s.key === "execution") nav.append(h("p", { class: "nav-group-label" }, t("Automation")));
      const count = h("span", { class: "nav-count" });
      const button = h("button", { type: "button", class: `nav-item${s.short ? "" : " desktop-nav"}`, "aria-label": t(s.label), title: t("{0} ({1})", t(s.label), s.key2), onclick: () => this.go(s.key) },
        icon(s.icon), h("span", { class: "nav-label" }, t(s.label)), s.short && h("span", { class: "nav-short" }, t(s.short)), count);
      this.nav.set(s.key, button); this.counts.set(s.key, count); nav.append(button);
    }
    this.trashButton = h("button", { type: "button", class: "nav-item trash-link desktop-nav", title: t("Recently deleted"), "aria-label": t("Recently deleted"), onclick: () => this.go("trash") },
      icon("trash"), h("span", { class: "nav-label" }, t("Recently deleted")));
    this.name = humans[0] ?? t("Me");
    this.account = h("button", { type: "button", class: "account", title: t("Settings"), "aria-label": t("Settings"), onclick: () => this.go("settings") },
      h("span", { class: "who-avatar", "aria-hidden": "true" }, this.name.slice(0, 1).toUpperCase()),
      h("span", { class: "account-text" }, h("span", { class: "who-name" }, this.name),
        h("span", { class: "account-sub" }, h("span", { class: "connection-dot" }), t("Connected to Hub"))),
      icon("settings"));
    const toggle = h("button", { type: "button", class: "icon-btn sidebar-toggle", "aria-controls": "main-sidebar", "aria-expanded": "true" }, icon("chevron"));
    const sidebar = h("aside", { class: "sidebar", id: "main-sidebar" },
      h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("span", { class: "brand-name" }, "Lumio"), toggle),
      h("button", { type: "button", class: "quick-find", title: t("Search or jump to"), "aria-label": t("Search or jump to"), onclick: () => this.palette.open() }, icon("search"), h("span", {}, t("Search or jump to")), h("kbd", {}, "⌘K")),
      nav,
      h("div", { class: "sidebar-foot" }, this.trashButton, this.account));
    const shell = h("div", { class: "shell" }, sidebar, this.main);
    const labelToggle = (collapsed: boolean) => {
      const label = collapsed ? t("Expand sidebar") : t("Collapse sidebar");
      toggle.title = label;
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("aria-expanded", String(!collapsed));
    };
    labelToggle(false);
    toggle.addEventListener("click", () => labelToggle(shell.classList.toggle("sidebar-collapsed")));
    root.append(
      h("a", { class: "skip-link", href: "#content", onclick: (event: Event) => { event.preventDefault(); this.main.focus(); } }, t("Skip to content")),
      shell);
    window.addEventListener("hashchange", this.onRoute);
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("beforeunload", this.onUnload);
    window.addEventListener("focus", this.refreshNow);
    window.addEventListener("lumio-refresh", this.refreshNow);
    document.addEventListener("visibilitychange", this.onVisible);
    const route = this.readRoute();
    this.show(route.section, route.id);
    void this.refreshCounts();
    this.countTimer = setInterval(() => { if (document.visibilityState === "visible") void this.refreshCounts(); }, 60_000);
  }

  private readRoute(): { section: Section; id?: string } {
    const [section, raw] = location.hash.slice(1).split(/\/(.*)/s);
    const known: Section = section === "settings" || section === "trash" ? section : SECTIONS.find(s => s.key === section)?.key ?? "overview";
    try { return { section: known, ...(raw ? { id: decodeURIComponent(raw) } : {}) }; } catch { return { section: known }; }
  }

  private async go(section: Section, id?: string, intent?: string): Promise<void> {
    const generation = ++this.routeGeneration;
    if (section === "work" && !id) id = intent === "new-project" ? "projects" : intent === "new" ? "tasks" : this.workMode;
    // 设置页的二级菜单也走路由（#settings/<分类>），回到分类列表时 id 为空，不能提前返回。
    if (section === this.section && section !== "settings" && !intent && (!id || (section === "work" && id === this.workMode))) return;
    if (!(await this.beforeLeave()) || generation !== this.routeGeneration) return;
    const hash = `#${section}${id ? `/${encodeURIComponent(id)}` : ""}`;
    if (location.hash !== hash) history.pushState(null, "", hash);
    this.show(section, id, intent);
  }

  private show(section: Section, id?: string, intent?: string): void {
    if (!this.dirty && this.beforeShow()) return;
    if (section === "settings" && this.section !== "settings") this.beforeSettings = this.currentHash || "#overview";
    const previous = this.current;
    const previousSection = this.section;
    this.section = section;
    this.currentHash = `#${section}${id ? `/${encodeURIComponent(id)}` : ""}`;
    let key: PaneKey = section;
    if (section === "work") {
      if (id) this.workMode = id === "projects" || id.startsWith("prj_") ? "projects" : "tasks";
      if (id === "tasks" || id === "projects") id = undefined;
      if (this.workMode === "projects") key = "projects";
    }
    const label = section === "settings" ? t("Settings") : section === "trash" ? t("Recently deleted") : t(SECTIONS.find(s => s.key === section)?.label ?? "Today");
    document.title = t(t("{0} · Lumio"), label);
    for (const [key, button] of this.nav) button.setAttribute("aria-current", key === section ? "page" : "false");
    this.account.setAttribute("aria-current", section === "settings" ? "page" : "false");
    this.trashButton.setAttribute("aria-current", section === "trash" ? "page" : "false");
    let mounted = this.panes.get(key);
    if (previous !== mounted) {
      document.querySelectorAll<HTMLDialogElement>("dialog").forEach(dialog => { dialog.close(); dialog.remove(); });
      document.querySelector(".menu")?.remove();
      if (previous) previous.target.hidden = true;
      if (previousSection === "settings" && previous) {
        previous.pane.dispose?.();
        previous.target.remove();
        this.panes.delete("settings");
      }
    }
    if (!mounted) {
      mounted = this.mountPane(section, id);
      this.panes.set(key, mounted);
    } else {
      mounted.target.hidden = false;
      // Returning to a retained module: keep its state, but catch up with changes made elsewhere meanwhile.
      if (previous !== mounted) { mounted.pane.resume?.(); mounted.pane.liveRefresh?.(); }
      if (id || section === "settings") mounted.pane.open?.(id ?? "");
    }
    this.current = mounted;
    if (intent) mounted.pane.intent?.(intent);
  }

  private mountPane(section: Section, id?: string): MountedPane {
    const target = h("div", { class: `pane pane-${section}` });
    this.main.append(target);
    const client = this.session.client;
    const navigate: Navigate = (s, i, n) => this.go(s, i, n);
    const changed = () => void this.refreshCounts();
    let pane: Pane;
    if (section === "overview") pane = new OverviewPane(target, client, this.session.hub, navigate, this.name, changed);
    else if (section === "settings") pane = new SettingsPane(target, this.session, this.name, () => void this.signOut(), () => this.leaveSettings(), sub => void this.go("settings", sub), id);
    else if (section === "knowledge") pane = new KnowledgePane(target, client, id);
    else if (section === "work") pane = new WorkPane(target, client, this.session.hub, this.workMode, id, navigate, changed);
    else if (section === "execution") pane = new ExecutionPane(target, client, this.session.hub, id, navigate, changed);
    else if (section === "assistant") pane = new AssistantPane(target, client, this.session.hub, navigate);
    else if (section === "trash") pane = new TrashPane(target, client, navigate, changed);
    else pane = new ApprovalsPane(target, client, changed, navigate);
    return { target, pane };
  }

  private async refreshCounts(): Promise<void> {
    const client = this.session.client;
    const [tasks, proposals, jobs, attention] = await Promise.allSettled([client.workTasks(), client.proposals("pending"), client.jobs(), this.session.hub.attention()]);
    const set = (section: Section, value: number | undefined, attention = false) => {
      const el = this.counts.get(section)!;
      el.textContent = value ? String(value) : "";
      el.classList.toggle("attention", attention && !!value);
    };
    set("work", tasks.status === "fulfilled" ? tasks.value.filter(t => turnGroup(t) === "needs" || turnGroup(t) === "todo").length : undefined);
    set("approvals", proposals.status === "fulfilled" ? proposals.value.length : undefined, true);
    const groups = jobs.status === "fulfilled" ? executionGroups(jobs.value,
      tasks.status === "fulfilled" ? tasks.value : undefined,
      attention.status === "fulfilled" ? attention.value : undefined) : undefined;
    set("execution", groups ? groups.live.length + groups.needs.length : undefined);
    // 今日的提醒数 = 需要你处理的轮次 + 待批准（ADR 0030）；窄屏底栏只看得到这一个数。
    const needs = attention.status === "fulfilled" && attention.value ? attention.value.length : 0;
    set("overview", needs + (proposals.status === "fulfilled" ? proposals.value.length : 0), true);
  }

  private leaveSettings(): void {
    const [section, raw] = this.beforeSettings.slice(1).split(/\/(.*)/s);
    const known = SECTIONS.find(s => s.key === section)?.key ?? "overview";
    let id: string | undefined;
    try { id = raw ? decodeURIComponent(raw) : undefined; } catch { id = undefined; }
    this.go(known, id);
  }

  get dirty(): boolean { return [...this.panes.values()].some(({ pane }) => pane.dirty) || !!document.querySelector("dialog[data-dirty=true]"); }

  private async beforeLeave(): Promise<boolean> {
    const pane = this.current?.pane;
    if (!pane?.beforeLeave) return this.canLeave();
    return pane.beforeLeave();
  }

  /** Explicit sign-out: give every retained module a chance to finish autosaving, then drop this account's local drafts. */
  private async signOut(): Promise<void> {
    for (const { pane } of [...this.panes.values()]) if (pane.beforeLeave) await pane.beforeLeave(); else pane.canLeave?.();
    drafts().clear();
    this.logout();
  }

  canLeave(): boolean {
    return this.current?.pane.canLeave?.() ?? true;
  }

  dispose(): void {
    this.disposeReferenceLinks();
    this.routeGeneration++;
    for (const { pane } of this.panes.values()) pane.dispose?.();
    this.panes.clear();
    this.current = undefined;
    this.palette.dispose();
    clearInterval(this.countTimer); clearInterval(this.liveTimer);
    window.removeEventListener("focus", this.refreshNow);
    window.removeEventListener("lumio-refresh", this.refreshNow);
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("hashchange", this.onRoute);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("beforeunload", this.onUnload);
  }
}

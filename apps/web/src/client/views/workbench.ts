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

/** short：窄屏底栏的短名；没有 short 的模块不进底栏，从今日页和提醒进入（ADR 0028）。 */
export const SECTIONS: Array<{ key: Exclude<Section, "settings">; label: string; short?: string; icon: string; key2: string }> = [
  { key: "overview", label: "Today", short: "Today", icon: "home", key2: "1" },
  { key: "work", label: "Projects & tasks", short: "Tasks", icon: "work", key2: "2" },
  { key: "knowledge", label: "Knowledge", short: "Knowledge", icon: "knowledge", key2: "3" },
  { key: "execution", label: "Execution", icon: "execution", key2: "4" },
  { key: "assistant", label: "Assistant", short: "Assistant", icon: "assistant", key2: "5" },
  { key: "approvals", label: "Approvals", icon: "approvals", key2: "6" },
];

export class WorkbenchView {
  private main = h("main", { class: "main", id: "content", tabindex: "-1" });
  private nav = new Map<Section, HTMLButtonElement>();
  private counts = new Map<Section, HTMLElement>();
  private pane?: Pane;
  private section: Section = "overview";
  private currentHash = "";
  private palette: CommandPalette;
  private countTimer: ReturnType<typeof setInterval>;

  private readonly onRoute = () => {
    if (!this.canLeave()) { history.pushState(null, "", this.currentHash || "#overview"); return; }
    const route = this.readRoute();
    if (route.section === this.section && route.id && this.pane?.open) { this.currentHash = location.hash; this.pane.open(route.id); return; }
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
      const search = this.main.querySelector<HTMLInputElement>("input[type=search]");
      if (search) { event.preventDefault(); search.focus(); search.select(); }
    }
  };
  private readonly onUnload = (event: BeforeUnloadEvent) => {
    if (this.pane?.dirty || document.querySelector("dialog[data-dirty=true]")) { event.preventDefault(); event.returnValue = ""; }
  };

  private name: string;
  private account: HTMLButtonElement;
  /** 进入设置页之前所在的位置，设置页的返回键回到这里。 */
  private beforeSettings = "#overview";
  /** 语言切换被推迟时，App 在下一次切换模块前重建界面；返回 true 表示已接管。 */
  constructor(root: HTMLElement, private session: Session, humans: string[], private logout: () => void, private beforeShow: () => boolean = () => false) {
    this.palette = new CommandPalette(session.client, (section, id, intent) => this.go(section, id, intent));
    const nav = h("nav", { class: "nav", "aria-label": t("Main navigation") });
    for (const s of SECTIONS) {
      if (s.key === "execution") nav.append(h("p", { class: "nav-group-label" }, t("Automation")));
      const count = h("span", { class: "nav-count" });
      const button = h("button", { type: "button", class: `nav-item${s.short ? "" : " desktop-nav"}`, title: t("{0} ({1})", t(s.label), s.key2), onclick: () => this.go(s.key) },
        icon(s.icon), h("span", { class: "nav-label" }, t(s.label)), s.short && h("span", { class: "nav-short" }, t(s.short)), count);
      this.nav.set(s.key, button); this.counts.set(s.key, count); nav.append(button);
    }
    this.name = humans[0] ?? t("Me");
    this.account = h("button", { type: "button", class: "account", title: t("Settings"), onclick: () => this.go("settings") },
      h("span", { class: "who-avatar", "aria-hidden": "true" }, this.name.slice(0, 1).toUpperCase()),
      h("span", { class: "account-text" }, h("span", { class: "who-name" }, this.name),
        h("span", { class: "account-sub" }, h("span", { class: "connection-dot" }), t("Connected to Hub"))),
      icon("settings"));
    const sidebar = h("aside", { class: "sidebar" },
      h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("span", {}, "Lumio")),
      h("button", { type: "button", class: "quick-find", onclick: () => this.palette.open() }, icon("search"), h("span", {}, t("Search or jump to")), h("kbd", {}, "⌘K")),
      nav,
      h("div", { class: "sidebar-foot" }, this.account));
    root.append(
      h("a", { class: "skip-link", href: "#content", onclick: (event: Event) => { event.preventDefault(); this.main.focus(); } }, t("Skip to content")),
      h("div", { class: "shell" }, sidebar, this.main));
    window.addEventListener("hashchange", this.onRoute);
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("beforeunload", this.onUnload);
    const route = this.readRoute();
    this.show(route.section, route.id);
    void this.refreshCounts();
    this.countTimer = setInterval(() => { if (document.visibilityState === "visible") void this.refreshCounts(); }, 60_000);
  }

  private readRoute(): { section: Section; id?: string } {
    const [section, raw] = location.hash.slice(1).split(/\/(.*)/s);
    const known: Section = section === "settings" ? "settings" : SECTIONS.find(s => s.key === section)?.key ?? "overview";
    try { return { section: known, ...(raw ? { id: decodeURIComponent(raw) } : {}) }; } catch { return { section: known }; }
  }

  private go(section: Section, id?: string, intent?: string): void {
    if (section === this.section && this.pane) {
      if (!id) { if (intent) this.pane.intent?.(intent); return; }
      if (this.pane.open) {
        this.currentHash = `#${section}/${encodeURIComponent(id)}`;
        history.pushState(null, "", this.currentHash);
        this.pane.open(id);
        return;
      }
    }
    if (!this.canLeave()) return;
    history.pushState(null, "", `#${section}${id ? `/${encodeURIComponent(id)}` : ""}`);
    this.show(section, id, intent);
  }

  private show(section: Section, id?: string, intent?: string): void {
    if (this.beforeShow()) return;
    this.pane?.dispose?.();
    document.querySelectorAll<HTMLDialogElement>("dialog").forEach(dialog => { dialog.close(); dialog.remove(); });
    document.querySelector(".menu")?.remove();
    this.section = section;
    this.currentHash = `#${section}${id ? `/${encodeURIComponent(id)}` : ""}`;
    if (section === "settings" && this.section !== "settings" && this.currentHash) this.beforeSettings = this.currentHash;
    const label = section === "settings" ? t("Settings") : t(SECTIONS.find(s => s.key === section)?.label ?? "Today");
    document.title = t(t("{0} · Lumio"), label);
    for (const [key, button] of this.nav) button.setAttribute("aria-current", key === section ? "page" : "false");
    this.account.setAttribute("aria-current", section === "settings" ? "page" : "false");
    const target = h("div", { class: `pane pane-${section}` });
    this.main.replaceChildren(target);
    const client = this.session.client;
    const navigate: Navigate = (s, i, n) => this.go(s, i, n);
    const changed = () => void this.refreshCounts();
    let pane: Pane;
    if (section === "overview") pane = new OverviewPane(target, client, this.session.hub, navigate, this.name, changed);
    else if (section === "settings") pane = new SettingsPane(target, this.session, this.name, () => { if (this.canLeave()) this.logout(); }, () => this.leaveSettings());
    else if (section === "knowledge") pane = new KnowledgePane(target, client, id);
    else if (section === "work") pane = new WorkPane(target, client, this.session.hub, id, navigate, changed);
    else if (section === "execution") pane = new ExecutionPane(target, client, this.session.hub, id, navigate, changed);
    else if (section === "assistant") pane = new AssistantPane(target, client, intent, navigate);
    else pane = new ApprovalsPane(target, client, changed);
    this.pane = pane;
    if (intent && section !== "assistant") pane.intent?.(intent);
  }

  private async refreshCounts(): Promise<void> {
    const client = this.session.client;
    const [tasks, proposals, jobs, attention] = await Promise.allSettled([client.workTasks(), client.proposals("pending"), client.jobs(), this.session.hub.attention()]);
    const set = (section: Section, value: number | undefined, attention = false) => {
      const el = this.counts.get(section)!;
      el.textContent = value ? String(value) : "";
      el.classList.toggle("attention", attention && !!value);
    };
    set("work", tasks.status === "fulfilled" ? tasks.value.filter(t => t.status === "active" || t.status === "todo").length : undefined);
    set("approvals", proposals.status === "fulfilled" ? proposals.value.length : undefined, true);
    set("execution", jobs.status === "fulfilled" ? jobs.value.filter(j => ["queued", "assigned", "running", "waiting_for_human"].includes(j.status)).length : undefined);
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

  get dirty(): boolean { return !!this.pane?.dirty || !!document.querySelector("dialog[data-dirty=true]"); }

  canLeave(): boolean {
    if (document.querySelector("dialog[data-dirty=true]") && !confirm(t("You have an unsaved form that will be lost. Continue?"))) return false;
    return this.pane?.canLeave?.() ?? true;
  }

  dispose(): void {
    this.pane?.dispose?.();
    this.palette.dispose();
    clearInterval(this.countTimer);
    window.removeEventListener("hashchange", this.onRoute);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("beforeunload", this.onUnload);
  }
}

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

export const SECTIONS: Array<{ key: Section; label: string; icon: string; key2: string }> = [
  { key: "overview", label: "今日", icon: "home", key2: "1" },
  { key: "work", label: "项目与任务", icon: "work", key2: "2" },
  { key: "knowledge", label: "知识库", icon: "knowledge", key2: "3" },
  { key: "execution", label: "执行", icon: "execution", key2: "4" },
  { key: "assistant", label: "助手", icon: "assistant", key2: "5" },
  { key: "approvals", label: "审批", icon: "approvals", key2: "6" },
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

  constructor(root: HTMLElement, private session: Session, humans: string[], private logout: () => void) {
    this.palette = new CommandPalette(session.client, (section, id, intent) => this.go(section, id, intent));
    const nav = h("nav", { class: "nav", "aria-label": "主导航" });
    for (const s of SECTIONS) {
      if (s.key === "execution") nav.append(h("p", { class: "nav-group-label" }, "自动化"));
      const count = h("span", { class: "nav-count" });
      const button = h("button", { type: "button", class: "nav-item", title: `${s.label}（${s.key2}）`, onclick: () => this.go(s.key) }, icon(s.icon), h("span", {}, s.label), count);
      this.nav.set(s.key, button); this.counts.set(s.key, count); nav.append(button);
    }
    const name = humans[0] ?? "我";
    const sidebar = h("aside", { class: "sidebar" },
      h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("span", {}, "Lumio")),
      h("button", { type: "button", class: "quick-find", onclick: () => this.palette.open() }, icon("search"), h("span", {}, "搜索或跳转"), h("kbd", {}, "⌘K")),
      nav,
      h("div", { class: "sidebar-foot" },
        h("div", { class: "connection" }, h("span", { class: "connection-dot" }), "已连接 Hub"),
        h("div", { class: "who" }, h("span", { class: "who-avatar" }, name.slice(0, 1).toUpperCase()), h("span", { class: "who-name" }, name),
          h("button", { type: "button", class: "icon-btn", title: "退出登录", "aria-label": "退出登录", onclick: () => { if (this.canLeave()) this.logout(); } }, icon("logout")))));
    root.append(
      h("a", { class: "skip-link", href: "#content", onclick: (event: Event) => { event.preventDefault(); this.main.focus(); } }, "跳到内容"),
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
    const known = SECTIONS.find(s => s.key === section)?.key ?? "overview";
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
    this.pane?.dispose?.();
    document.querySelectorAll<HTMLDialogElement>("dialog").forEach(dialog => { dialog.close(); dialog.remove(); });
    document.querySelector(".menu")?.remove();
    this.section = section;
    this.currentHash = `#${section}${id ? `/${encodeURIComponent(id)}` : ""}`;
    const label = SECTIONS.find(s => s.key === section)?.label ?? "今日";
    document.title = `${label} · Lumio`;
    for (const [key, button] of this.nav) button.setAttribute("aria-current", key === section ? "page" : "false");
    const target = h("div", { class: `pane pane-${section}` });
    this.main.replaceChildren(target);
    const client = this.session.client;
    const navigate: Navigate = (s, i, n) => this.go(s, i, n);
    const changed = () => void this.refreshCounts();
    let pane: Pane;
    if (section === "overview") pane = new OverviewPane(target, client, navigate);
    else if (section === "knowledge") pane = new KnowledgePane(target, client, id);
    else if (section === "work") pane = new WorkPane(target, client, id, navigate, changed);
    else if (section === "execution") pane = new ExecutionPane(target, client, id, navigate);
    else if (section === "assistant") pane = new AssistantPane(target, client, intent);
    else pane = new ApprovalsPane(target, client, changed);
    this.pane = pane;
    if (intent && section !== "assistant") pane.intent?.(intent);
  }

  private async refreshCounts(): Promise<void> {
    const client = this.session.client;
    const [tasks, proposals, jobs] = await Promise.allSettled([client.workTasks(), client.proposals("pending"), client.jobs()]);
    const set = (section: Section, value: number | undefined, attention = false) => {
      const el = this.counts.get(section)!;
      el.textContent = value ? String(value) : "";
      el.classList.toggle("attention", attention && !!value);
    };
    set("work", tasks.status === "fulfilled" ? tasks.value.filter(t => t.status === "active" || t.status === "todo").length : undefined);
    set("approvals", proposals.status === "fulfilled" ? proposals.value.length : undefined, true);
    set("execution", jobs.status === "fulfilled" ? jobs.value.filter(j => ["queued", "assigned", "running", "waiting_for_human"].includes(j.status)).length : undefined);
  }

  canLeave(): boolean {
    if (document.querySelector("dialog[data-dirty=true]") && !confirm("有尚未保存的表单，离开会丢弃修改。确定继续吗？")) return false;
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

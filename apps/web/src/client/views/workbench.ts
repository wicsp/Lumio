import { referenceLinks } from "../reference-links.ts";
import { resourceLinks } from "../resources.ts";
import { drafts } from "../drafts.ts";
import { executionGroups } from "../execution-groups.ts";
import { turnGroup } from "../turn.ts";
import type { Session } from "../api.ts";
import { h, icon, toast, typing } from "../dom.ts";
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
import { InboxPane } from "../panes/inbox.ts";
import { DEFAULT_BINDINGS, GamepadInput } from "../gamepad-input.ts";
import { padButtonLabel } from "../gamepad-settings.ts";
import { GamepadNavigation } from "../gamepad-navigation.ts";
import { SpeechService, setSpeechService } from "../speech-input.ts";
import { UsageIndicator } from "../usage-indicator.ts";
import { MainDock } from "../main-dock.ts";
import { canNavigateNow, navigateRoute, type FocusInput } from "../workbench-assist.ts";
import type { WorkbenchAction } from "@lumio/schema";

/** 记住侧栏是否收起（只影响本设备）。 */
const SIDEBAR_KEY = "lumio.web.sidebar-collapsed";

/** short：窄屏底栏的短名；没有 short 的模块不进底栏，从今日页和提醒进入（ADR 0028）。 */
export const SECTIONS: Array<{ key: Exclude<Section, "settings" | "trash">; label: string; short?: string; icon: string; key2: string }> = [
  { key: "overview", label: "Today", short: "Today", icon: "home", key2: "1" },
  { key: "work", label: "Work", short: "Work", icon: "work", key2: "2" },
  { key: "knowledge", label: "Knowledge", short: "Knowledge", icon: "knowledge", key2: "3" },
  { key: "inbox", label: "Inbox", short: "Inbox", icon: "inbox", key2: "4" },
  { key: "execution", label: "Execution", icon: "execution", key2: "5" },
  { key: "assistant", label: "Assistant", short: "Assistant", icon: "assistant", key2: "6" },
  { key: "approvals", label: "Approvals", icon: "approvals", key2: "7" },
];

type PaneKey = Section | "projects";
type MountedPane = { target: HTMLElement; pane: Pane };

export class WorkbenchView {
  private gamepad: GamepadInput;
  private speech: SpeechService;
  /** 手柄 B 在页面层返回的位置（G1-6）：最近访问的页面，最多 30 个。 */
  private visited: string[] = [];
  private returning = false;
  private padNavigation: GamepadNavigation;
  private unsubscribePadStatus: () => void;
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
  private disposeResourceLinks: () => void;
  private countTimer: ReturnType<typeof setInterval>;
  /** 主对话面板（ADR 0060，A1-5）。 */
  private dock: MainDock;
  /** 人最近一次在页面上输入、滚动、点击或按键的时间；助手替人跳转前要先空闲一会儿。 */
  private lastActivity = 0;
  private readonly onActivity = () => { this.lastActivity = Date.now(); };

  private routeGeneration = 0;
  private readonly onRoute = async () => {
    const generation=++this.routeGeneration, route=this.readRoute();
    if (!(await this.beforeLeave())) { if(generation===this.routeGeneration) history.pushState(null, "", this.currentHash || "#overview"); return; }
    if(generation!==this.routeGeneration)return;
    this.show(route.section, route.id);
  };
  private readonly onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "k") { event.preventDefault(); this.palette.open(); return; }
    if (typing(event) || mod || event.altKey || document.querySelector("dialog[open]")) return;
    const section = SECTIONS.find(s => s.key2 === event.key);
    if (section) { event.preventDefault(); this.go(section.key); return; }
    if (event.key === "c") { event.preventDefault(); this.go("work", undefined, "new"); return; }
    if (this.section === "overview" && ["j", "k", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      const step = ["k", "ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1;
      if (this.padNavigation.move(step)) event.preventDefault();
      return;
    }
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
    void this.usage.refresh();
  };
  private readonly onVisible = () => { if (document.visibilityState === "visible") this.refreshNow(); else void this.current?.pane.beforeLeave?.(); };
  private liveTimer: ReturnType<typeof setInterval> = setInterval(() => this.refreshNow(), 15_000);
  private readonly onUnload = () => { this.current?.pane.canLeave?.(); };

  private name: string;
  /** 侧栏底部的 AI 用量指示器。 */
  private usage: UsageIndicator;
  private account: HTMLButtonElement;
  /** 进入设置页之前所在的位置，设置页的返回键回到这里。 */
  private beforeSettings = "#overview";
  /** 语言切换被推迟时，App 在下一次切换模块前重建界面；返回 true 表示已接管。 */
  constructor(root: HTMLElement, private session: Session, humans: string[], private logout: () => void, private beforeShow: () => boolean = () => false) {
    this.disposeReferenceLinks = referenceLinks(this.main, session.client, ref => this.go("knowledge",ref));
    this.disposeResourceLinks = resourceLinks(this.main, session.client, (section, id, intent) => void this.go(section, id, intent));
    this.palette = new CommandPalette(session.client, (section, id, intent) => this.go(section, id, intent));
    this.padNavigation = new GamepadNavigation({
      pane: () => this.current?.target,
      back: () => this.goBack(),
      backLabel: () => { const target = this.backTarget(); return target ? t("Back to {0}", this.sectionLabel(target.section)) : undefined; },
      openAssistant: async () => {
        if (this.section !== "assistant") await this.go("assistant");
        if (this.section !== "assistant") return undefined;
        return this.current?.target.querySelector<HTMLTextAreaElement>("textarea[name=chat-message]") ?? undefined;
      },
      section: step => {
        const next = this.adjacentSection(step);
        if (next) void this.go(next.key);
      },
      sectionLabel: step => {
        const next = this.adjacentSection(step);
        return next && t(next.label);
      },
      buttonLabel: command => {
        const pad = this.gamepad?.activePad;
        const button = (this.gamepad?.mapping ?? DEFAULT_BINDINGS)[command];
        return !pad || button < pad.buttons.length ? padButtonLabel(button, pad) : undefined;
      },
      delegate: id => this.current?.pane.intent?.(`delegate:${id}`),
      palette: () => this.palette.open(true),
      paletteAction: step => this.palette.gamepad(step),
    });
    this.padNavigation.mount();
    this.speech = new SpeechService(session);
    setSpeechService(this.speech);
    this.gamepad = new GamepadInput(input => this.padNavigation.handle(input));
    const warned = new Set<string>();
    this.unsubscribePadStatus = this.gamepad.subscribe(({ pad }) => {
      if (pad && pad.mapping !== "standard" && !warned.has(pad.id)) {
        warned.add(pad.id);
        toast(t("This controller’s buttons may be mismatched. You can remap them in Settings → Keyboard & gamepad."));
      }
    });
    const nav = h("nav", { class: "nav", "aria-label": t("Main navigation") });
    for (const s of SECTIONS) {
      if (s.key === "execution") nav.append(h("p", { class: "nav-group-label" }, t("Automation")));
      const count = h("span", { class: "nav-count" });
      const button = h("button", { type: "button", class: `nav-item${s.short ? "" : " desktop-nav"}`, "aria-label": t(s.label), title: t("{0} ({1})", t(s.label), s.key2), onclick: () => this.go(s.key) },
        icon(s.icon), h("span", { class: "nav-label" }, t(s.label)), s.short && h("span", { class: "nav-short" }, t(s.short)), count);
      this.nav.set(s.key, button); this.counts.set(s.key, count); nav.append(button);
    }
    this.name = humans[0] ?? t("Me");
    this.usage = new UsageIndicator(session.client, () => void this.go("settings", "ai"));
    this.account = h("button", { type: "button", class: "account", title: t("Settings"), "aria-label": t("Settings"), onclick: () => this.go("settings") },
      h("span", { class: "who-avatar", "aria-hidden": "true" }, this.name.slice(0, 1).toUpperCase()),
      h("span", { class: "account-text" }, h("span", { class: "who-name" }, this.name),
        h("span", { class: "account-sub" }, h("span", { class: "connection-dot" }), t("Connected to Hub"))),
      icon("settings"));
    // 收起侧栏后，左上角只剩 Lumio 图标，点它展开；展开时图标只是标志，收起按钮在右侧。
    const toggle = h("button", { type: "button", class: "icon-btn sidebar-toggle", "aria-controls": "main-sidebar", "aria-expanded": "true", title: t("Collapse sidebar"), "aria-label": t("Collapse sidebar") }, icon("chevron"));
    const logo = h("button", { type: "button", class: "brand-logo", "aria-controls": "main-sidebar", title: t("Expand sidebar"), "aria-label": t("Expand sidebar") }, h("span", { class: "brand-mark", "aria-hidden": "true" }));
    const sidebar = h("aside", { class: "sidebar", id: "main-sidebar" },
      h("div", { class: "brand" }, logo, h("span", { class: "brand-name" }, "Lumio"), toggle),
      h("button", { type: "button", class: "quick-find", title: t("Search or jump to"), "aria-label": t("Search or jump to"), onclick: () => this.palette.open() }, icon("search"), h("span", {}, t("Search or jump to")), h("kbd", {}, "⌘K")),
      nav,
      h("div", { class: "sidebar-foot" }, this.usage.element, this.account));
    const shell = h("div", { class: "shell" }, sidebar, this.main);
    this.dock = new MainDock(session.client, {
      focus: () => this.focusInput(),
      navigate: (section, id, intent) => void this.go(section, id, intent),
      apply: action => this.applyAction(action),
      clearHighlights: () => this.clearHighlights(),
      layout: open => shell.classList.toggle("dock-open", open),
    });
    shell.append(this.dock.element);
    for (const type of ["input", "keydown", "pointerdown", "wheel"]) this.main.addEventListener(type, this.onActivity, { passive: true });
    this.main.addEventListener("scroll", this.onActivity, { capture: true, passive: true });
    const collapse = (collapsed: boolean, focus = false) => {
      shell.classList.toggle("sidebar-collapsed", collapsed);
      toggle.setAttribute("aria-expanded", String(!collapsed));
      logo.setAttribute("aria-expanded", String(!collapsed));
      // 展开时 Lumio 图标不可点，也不进入 Tab 顺序。
      logo.tabIndex = collapsed ? 0 : -1;
      logo.setAttribute("aria-hidden", String(!collapsed));
      if (focus) {
        try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch { /* 存储不可用时只是不记住 */ }
        (collapsed ? logo : toggle).focus();
      }
    };
    let remembered = false;
    try { remembered = localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { remembered = false; }
    collapse(remembered);
    toggle.addEventListener("click", () => collapse(true, true));
    logo.addEventListener("click", () => { if (shell.classList.contains("sidebar-collapsed")) collapse(false, true); });
    root.append(
      h("a", { class: "skip-link", href: "#content", onclick: (event: Event) => { event.preventDefault(); this.main.focus(); } }, t("Skip to content")),
      shell, this.dock.launcher);
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

  private adjacentSection(step: number): typeof SECTIONS[number] | undefined {
    const index = SECTIONS.findIndex(section => section.key === this.section);
    return index < 0 ? SECTIONS[step > 0 ? 0 : SECTIONS.length - 1] : SECTIONS[index + step];
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
    if (section === "settings" && this.section !== "settings" && this.section !== "trash") this.beforeSettings = this.currentHash || "#overview";
    const previous = this.current;
    const previousSection = this.section;
    if (this.currentHash && !this.returning) this.visited = [...this.visited.filter(hash => hash !== this.currentHash), this.currentHash].slice(-30);
    this.returning = false;
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
    // 「最近删除」属于设置，侧栏不单独放入口；打开它时高亮账户（设置）按钮。
    this.account.setAttribute("aria-current", section === "settings" || section === "trash" ? "page" : "false");
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
    this.clearHighlights();
    this.dock?.pageChanged();
    this.padNavigation.routeChanged(!!id && section !== "settings");
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
    else if (section === "settings") pane = new SettingsPane(target, this.session, this.name, () => void this.signOut(), () => this.leaveSettings(), sub => void this.go("settings", sub), id, this.gamepad);
    else if (section === "knowledge") pane = new KnowledgePane(target, client, id);
    else if (section === "work") pane = new WorkPane(target, client, this.session.hub, this.workMode, id, navigate, changed);
    else if (section === "execution") pane = new ExecutionPane(target, client, this.session.hub, id, navigate, changed);
    else if (section === "assistant") pane = new AssistantPane(target, client, this.session.hub, navigate, id);
    else if (section === "trash") pane = new TrashPane(target, client, navigate, changed);
    else if (section === "inbox") pane = new InboxPane(target, client, navigate, changed);
    else pane = new ApprovalsPane(target, client, changed, navigate);
    return { target, pane };
  }

  /** 焦点快照的来源：当前分区、路由里的对象 ID、主区域里选中的文字。 */
  private focusInput(): FocusInput {
    const { section, id } = this.parseHash(this.currentHash || "#overview");
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const selected = selection && !selection.isCollapsed && anchor && this.main.contains(anchor) ? selection.toString() : undefined;
    return { section, ...(id ? { id } : {}), ...(selected ? { selection: selected } : {}) };
  }

  /** 助手的跳转与高亮（ADR 0060 第 2、3 节）。人正在操作页面时不跳转，交给面板显示「带我过去」。 */
  private applyAction(action: Extract<WorkbenchAction, { action: "navigate" | "highlight" }>): "applied" | "deferred" {
    if (action.action === "navigate") {
      const active = document.activeElement;
      const editing = !!document.querySelector("dialog[open]") || (!!active && this.main.contains(active) &&
        (active.matches("input, textarea, select") || (active as HTMLElement).isContentEditable));
      const attentive = document.visibilityState === "visible" && document.hasFocus();
      if (!canNavigateNow({ now: Date.now(), lastActivity: this.lastActivity, editing, attentive })) return "deferred";
      const [section, id] = navigateRoute(action);
      void this.go(section, id);
      return "applied";
    }
    this.clearHighlights();
    const target = this.current?.target;
    let first: HTMLElement | undefined;
    for (const ref of action.refs) {
      for (const element of target?.querySelectorAll<HTMLElement>(`[data-id="${CSS.escape(ref.id)}"]`) ?? []) {
        element.classList.add("assist-highlight");
        if (action.note) element.dataset.assistNote = action.note;
        first ??= element;
      }
    }
    first?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return "applied";
  }

  private clearHighlights(): void {
    for (const element of this.main.querySelectorAll<HTMLElement>(".assist-highlight")) {
      element.classList.remove("assist-highlight");
      delete element.dataset.assistNote;
    }
  }

  private async refreshCounts(): Promise<void> {
    const client = this.session.client;
    const [tasks, proposals, jobs, attention, inbox] = await Promise.allSettled([client.workTasks(), client.proposals("pending"), client.jobs(), this.session.hub.attention(), client.captures({ untriaged: true, limit: 1 })]);
    const set = (section: Section, value: number | undefined, attention = false) => {
      const el = this.counts.get(section)!;
      el.textContent = value ? String(value) : "";
      el.classList.toggle("attention", attention && !!value);
    };
    set("work", tasks.status === "fulfilled" ? tasks.value.filter(t => turnGroup(t) === "needs" || turnGroup(t) === "todo").length : undefined);
    set("inbox", inbox.status === "fulfilled" ? inbox.value.total : undefined);
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

  private sectionLabel(section: Section): string {
    return section === "settings" ? t("Settings") : section === "trash" ? t("Recently deleted") : t(SECTIONS.find(s => s.key === section)?.label ?? "Today");
  }

  private parseHash(hash: string): { section: Section; id?: string } {
    const [section, raw] = hash.slice(1).split(/\/(.*)/s);
    const known: Section = section === "settings" || section === "trash" ? section : SECTIONS.find(s => s.key === section)?.key ?? "overview";
    try { return { section: known, ...(raw ? { id: decodeURIComponent(raw) } : {}) }; } catch { return { section: known }; }
  }

  /** 页面层的 B 回到最近访问的另一个模块；没有记录时回到 Today，在 Today 时不动（G1-6）。 */
  private backTarget(): { section: Section; id?: string; hash?: string } | undefined {
    const hash = [...this.visited].reverse().find(value => this.parseHash(value).section !== this.section);
    if (hash) return { ...this.parseHash(hash), hash };
    return this.section === "overview" ? undefined : { section: "overview" };
  }

  private goBack(): void {
    const target = this.backTarget();
    if (!target) return;
    if (target.hash) this.visited = this.visited.slice(0, this.visited.lastIndexOf(target.hash));
    this.returning = true;
    void this.go(target.section, target.id).finally(() => { this.returning = false; });
  }

  dispose(): void {
    this.dock.dispose();
    this.dock.launcher.remove();
    setSpeechService(undefined);
    this.unsubscribePadStatus();
    this.gamepad.dispose();
    this.padNavigation.dispose();
    this.disposeReferenceLinks();
    this.disposeResourceLinks();
    this.routeGeneration++;
    for (const { pane } of this.panes.values()) pane.dispose?.();
    this.panes.clear();
    this.current = undefined;
    this.palette.dispose();
    this.usage.dispose();
    clearInterval(this.countTimer); clearInterval(this.liveTimer);
    window.removeEventListener("focus", this.refreshNow);
    window.removeEventListener("lumio-refresh", this.refreshNow);
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("hashchange", this.onRoute);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("beforeunload", this.onUnload);
  }
}

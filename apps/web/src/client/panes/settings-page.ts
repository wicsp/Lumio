/**
 * 设置页（ADR 0028）：二级菜单。桌面左侧是分类，右侧是当前分类的内容；
 * 窄屏先显示分类列表，点进分类后用返回键回到列表。地址是 `#settings/<分类>`。
 * 各分类在第一次打开时才创建，离开设置页时一起释放。
 */
import type { RuntimeInfo } from "@lumio/schema";
import { errorText, type Session } from "../api.ts";
import { clear, h, icon } from "../dom.ts";
import { ago } from "../format.ts";
import { formatTime } from "../commands.ts";
import { helperState, installCommandBlock } from "../privileged-helper.ts";
import { lang, setLang, t, type Lang } from "../i18n.ts";
import { onTheme, setTheme, themeChoice, type ThemeChoice } from "../theme.ts";
import { LANGS, THEMES } from "../settings.ts";
import { AISettings } from "../ai-settings.ts";
import { AgentsSettings } from "../agents-settings.ts";
import type { GamepadInput } from "../gamepad-input.ts";
import { GamepadSettings } from "../gamepad-settings.ts";
import { NotificationSettings } from "../notification-settings.ts";
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, settingsSection, type SettingsSection } from "../settings-sections.ts";

const SOURCE = "https://github.com/wicsp/Lumio";

interface Built { element: HTMLElement; dispose?: () => void }
type Health = { ok: boolean; version?: string } | { error: unknown };

export class SettingsPane {
  private unbindTheme: () => void;
  private active = true;
  private themeTiles = new Map<ThemeChoice, HTMLButtonElement>();
  private built = new Map<SettingsSection, Built>();
  private navItems = new Map<SettingsSection, HTMLAnchorElement>();
  private shell = h("div", { class: "set-shell" });
  private content = h("div", { class: "set-content" });
  private title = h("h1", { class: "bar-title" }, t("Settings"));
  private shown?: SettingsSection;
  private health?: Promise<Health>;

  constructor(owner: HTMLElement, private session: Session, private name: string, private logout: () => void,
    private back: () => void, private navigate: (section?: SettingsSection) => void, initial?: string, private gamepad?: GamepadInput) {
    const bar = h("header", { class: "bar set-bar" },
      h("button", { type: "button", class: "icon-btn mobile-only", title: t("Back"), "aria-label": t("Back"), onclick: () => this.goBack() }, icon("back")),
      this.title);
    this.shell.append(this.nav(), this.content);
    owner.append(bar, h("div", { class: "set-scroll" }, this.shell));
    this.unbindTheme = onTheme(() => this.markTheme());
    this.open(initial ?? "");
  }

  dispose(): void {
    this.active = false; this.unbindTheme();
    for (const built of this.built.values()) built.dispose?.();
    this.built.clear();
  }

  /** 由路由调用：`id` 为空表示分类列表（桌面上等同于「通用」）。 */
  open(id: string): void {
    const picked = settingsSection(id);
    this.shell.classList.toggle("at-index", !picked);
    const key = picked ?? DEFAULT_SETTINGS_SECTION;
    for (const [section, item] of this.navItems) item.setAttribute("aria-current", section === picked || (!picked && section === key) ? "page" : "false");
    this.title.textContent = picked ? t(SETTINGS_SECTIONS.find(s => s.key === picked)!.label) : t("Settings");
    if (key === this.shown) return;
    this.shown = key;
    let built = this.built.get(key);
    if (!built) { built = this.build(key); this.built.set(key, built); }
    clear(this.content, built.element);
    this.content.scrollTop = 0;
  }

  private goBack(): void {
    if (this.shell.classList.contains("at-index")) this.back();
    else this.navigate(undefined);
  }

  // ───────────── 分类导航 ─────────────

  private nav(): HTMLElement {
    const items = SETTINGS_SECTIONS.map(section => {
      const item = h("a", { class: "set-nav-item", "data-pad-row": `settings:${section.key}`, href: `#settings/${section.key}`, "aria-current": "false",
        onclick: (event: Event) => { const click = event as MouseEvent; if (click.metaKey || click.ctrlKey || click.shiftKey) return; event.preventDefault(); this.navigate(section.key); } },
        h("span", { class: "set-nav-icon" }, icon(section.icon)),
        h("span", { class: "set-nav-text" }, h("span", { class: "set-nav-label" }, t(section.label)), h("span", { class: "set-nav-hint" }, t(section.hint))),
        icon("chevron", "icon set-nav-chevron"));
      this.navItems.set(section.key, item);
      return item;
    });
    return h("nav", { class: "set-nav", "aria-label": t("Settings") },
      this.profile(),
      h("div", { class: "set-nav-list" }, ...items),
      h("button", { type: "button", class: "set-nav-item set-nav-signout", onclick: () => this.logout() },
        h("span", { class: "set-nav-icon" }, icon("logout")), h("span", { class: "set-nav-label" }, t("Sign out"))));
  }

  private profile(): HTMLElement {
    return h("section", { class: "set-profile" },
      h("span", { class: "set-avatar", "aria-hidden": "true" }, this.name.slice(0, 1).toUpperCase()),
      h("div", { class: "set-profile-text" }, h("p", { class: "set-name" }, this.name), h("p", { class: "set-sub" }, t("Signed in to {0}", location.host))));
  }

  // ───────────── 各分类内容 ─────────────

  private build(key: SettingsSection): Built {
    const info = SETTINGS_SECTIONS.find(s => s.key === key)!;
    const page = (...children: Array<Node | null | undefined | false>) => h("div", { class: "set-page" },
      h("header", { class: "set-head" }, h("h2", { class: "set-title" }, t(info.label)), h("p", { class: "set-lede" }, t(info.hint))), ...children);
    switch (key) {
      case "general":
        return { element: page(
          this.group(t("Appearance"), t("Choose how Lumio looks on this device."), this.themes()),
          this.group(t("Language"), t("Used for menus, dates and messages from the Hub."), this.languages())) };
      case "controls": {
        const gamepad = this.gamepad ? new GamepadSettings(this.gamepad) : undefined;
        return { element: page(
          this.group(t("Keyboard shortcuts"), undefined, h("div", { class: "set-rows" },
            this.row(t("Command menu"), h("span", { class: "set-value" }, h("kbd", {}, "⌘K"))),
            this.row(t("Switch sections"), h("span", { class: "set-value" }, h("kbd", {}, "1"), "–", h("kbd", {}, "7"))))),
          gamepad && this.group(t("Gamepad"), undefined, gamepad.element)), dispose: () => gamepad?.dispose() };
      }
      case "notifications": {
        const notifications = new NotificationSettings(this.session.client);
        return { element: page(this.group("", t("Lumio notifies you only when it's your turn to answer, review or handle a failed round, and when an agent asks for approval. Notifications show the task title only."), notifications.element)),
          dispose: () => notifications.dispose() };
      }
      case "ai": {
        const profiles = new AISettings(this.session.client, (title, hint, body, action) => this.group(title, hint, body, action));
        return { element: page(profiles.element), dispose: () => profiles.dispose() };
      }
      case "devices": {
        const hubRows = h("div", { class: "set-rows" }), runtimeRows = h("div", { class: "set-rows" });
        clear(hubRows, this.row(t("Address"), h("span", { class: "set-value mono" }, location.host)), this.row(t("Status"), h("span", { class: "set-value muted" }, t("Checking…"))));
        clear(runtimeRows, h("p", { class: "set-empty" }, t("Loading…")));
        void this.loadHub(hubRows);
        void this.loadRuntimes(runtimeRows);
        return { element: page(this.group(t("Hub"), undefined, hubRows), this.group(t("Runtimes"), t("Machines that run agents for this Hub."), runtimeRows),
          this.group(t("Browser extension"), t("Save the page you're reading to the Inbox with one click."), this.extensionPairing())) };
      }
      case "agents": {
        const agents = new AgentsSettings(this.session.client);
        return { element: page(this.group("", t("Agents outside Lumio that can read your tasks and notes and make small changes. They can't mark tasks done, delegate, approve, or read private notes."), agents.element)),
          dispose: () => agents.dispose() };
      }
      case "data":
        return { element: page(this.group(t("Recently deleted"), t("Deleted tasks, projects, notes and conversations stay here for 30 days."), h("div", { class: "set-rows" },
          h("a", { class: "set-row set-link", href: "#trash" }, icon("trash", "icon set-row-icon"), h("span", { class: "set-label" }, t("Open Recently deleted")), icon("chevron"))))) };
      case "about": {
        const version = h("span", { class: "set-value mono" }, "…");
        void this.hubHealth().then(health => { if (this.active) version.textContent = "version" in health && health.version ? health.version : "—"; });
        return { element: page(
          h("section", { class: "set-about" },
            h("span", { class: "set-about-mark", "aria-hidden": "true" }, "L"),
            h("div", {}, h("p", { class: "set-name" }, "Lumio"), h("p", { class: "set-sub" }, t("Your knowledge, work and agents in one place.")))),
          this.group(t("Details"), undefined, h("div", { class: "set-rows" },
            this.row(t("Hub version"), version),
            h("a", { class: "set-row set-link", href: SOURCE, target: "_blank", rel: "noopener noreferrer" },
              h("span", { class: "set-label" }, t("Source code")), h("span", { class: "set-value" }, "github.com/wicsp/Lumio"), icon("external"))))) };
      }
    }
  }

  private group(title: string, hint: string | undefined, body: HTMLElement, action?: HTMLElement): HTMLElement {
    return h("section", { class: "set-group" },
      (title || action) && h("div", { class: "set-group-head" }, title && h("h3", { class: "set-group-title" }, title), action),
      h("div", { class: "set-card" }, body),
      hint && h("p", { class: "set-hint" }, hint));
  }

  /** 给浏览器插件生成一次性配对码：插件设置页填 Hub 地址和配对码，换取自己的 human 令牌（ADR 0057）。 */
  private extensionPairing(): HTMLElement {
    const result = h("div", { class: "set-pairing", role: "status" });
    const button = h("button", { type: "button", class: "btn btn-small" }, t("Create pairing code"));
    button.addEventListener("click", () => void (async () => {
      button.disabled = true; clear(result);
      try {
        const invite = await this.session.client.clientInvite(`browser@${new Date().toISOString().slice(0, 10)}`);
        clear(result,
          this.row(t("Hub address"), h("span", { class: "set-value mono" }, invite.hub_url)),
          this.row(t("Pairing code"), h("span", { class: "set-value mono set-code" }, invite.code)),
          h("p", { class: "field-hint" }, t("Enter both in the extension's settings. The code works once, until {0}.", formatTime(invite.expires))));
      } catch (error) {
        clear(result, h("p", { class: "field-hint inbox-error" }, errorText(error)));
      } finally { button.disabled = false; }
    })());
    return h("div", { class: "set-rows" },
      h("div", { class: "set-row" }, h("span", { class: "set-label" }, t("Pair a browser"),
        h("span", { class: "set-sub" }, t("Install the Lumio extension from apps/chrome-ext, then create a code here."))), button),
      result);
  }

  private row(label: string, value: Node): HTMLElement {
    return h("div", { class: "set-row" }, h("span", { class: "set-label" }, label), value);
  }

  private themes(): HTMLElement {
    const tiles = THEMES.map(([value, label, glyph]) => {
      const tile = h("button", { type: "button", class: `theme-tile theme-tile-${value}`, "aria-pressed": "false", onclick: () => setTheme(value) },
        h("span", { class: "theme-preview", "aria-hidden": "true" },
          h("span", { class: "tp-side" }), h("span", { class: "tp-main" }, h("span", { class: "tp-line" }), h("span", { class: "tp-line short" }), h("span", { class: "tp-dot" }))),
        h("span", { class: "theme-name" }, icon(glyph), t(label)));
      this.themeTiles.set(value, tile);
      return tile;
    });
    this.markTheme();
    return h("div", { class: "theme-tiles", role: "group", "aria-label": t("Theme") }, ...tiles);
  }

  private markTheme(): void {
    for (const [value, tile] of this.themeTiles) tile.setAttribute("aria-pressed", String(themeChoice() === value));
  }

  /** 语言名称用各自的语言写，不翻译。切换后 App 会重建界面，仍停在设置页的同一分类。 */
  private languages(): HTMLElement {
    return h("div", { class: "set-rows", role: "radiogroup", "aria-label": t("Language") }, ...LANGS.map(([value, label]) =>
      h("button", { type: "button", class: "set-row", role: "radio", "aria-checked": String(lang() === value), onclick: () => { if (lang() !== value) setLang(value as Lang); } },
        h("span", { class: "set-label" }, label), lang() === value ? icon("check", "icon set-check") : null)));
  }

  private hubHealth(): Promise<Health> {
    return this.health ??= this.session.health().then(health => ({ ok: health.ok, version: health.version }), (error: unknown) => ({ error }));
  }

  private async loadHub(rows: HTMLElement): Promise<void> {
    const health = await this.hubHealth();
    if (!this.active) return;
    const status = "error" in health
      ? h("span", { class: "set-value set-status" }, h("span", { class: "connection-dot off" }), errorText(health.error))
      : h("span", { class: "set-value set-status" }, h("span", { class: `connection-dot${health.ok ? "" : " off"}` }), health.ok ? t("Connected") : t("Not healthy"));
    clear(rows,
      this.row(t("Address"), h("span", { class: "set-value mono" }, location.host)),
      this.row(t("Version"), h("span", { class: "set-value mono" }, ("version" in health && health.version) || "—")),
      this.row(t("Status"), status));
  }

  private async loadRuntimes(rows: HTMLElement): Promise<void> {
    let runtimes: RuntimeInfo[];
    try { runtimes = await this.session.client.runtimes(); } catch (error) {
      if (this.active) clear(rows, h("p", { class: "set-empty" }, errorText(error)));
      return;
    }
    if (!this.active) return;
    if (!runtimes.length) { clear(rows, h("p", { class: "set-empty" }, t("No runtimes yet. Run lumio runtime add <name> to pair a machine."))); return; }
    clear(rows, ...runtimes.flatMap(runtime => {
      const helper = helperState(runtime.registration);
      const row = h("div", { class: "set-row" },
        h("span", { class: `connection-dot${runtime.online ? "" : " off"}` }),
        h("span", { class: "set-label" }, runtime.registration.name,
          h("span", { class: "set-sub" }, runtime.registration.engines.map(engine => engine.name).join(", ") || t("No agents")),
          h("span", { class: "set-sub" }, helper === "installed" ? t("Administrator helper: installed")
            : helper === "missing" ? t("Administrator helper: not installed") : t("Administrator helper: unknown (update this runtime to see)"))),
        h("span", { class: "set-value muted" }, runtime.online ? t("Online") : t("Last seen {0}", ago(runtime.last_seen))));
      if (helper !== "missing") return [row];
      // 没装助手时说明它的用途，并给出可复制的安装命令（ADR 0020）。
      return [row, h("div", { class: "set-row helper-row" },
        h("p", { class: "field-hint" }, t("Only needed when an agent must install software or change system settings on {0}. Without it, everything else still works. To install, run this once in a terminal on {0}; it asks for that machine's password, and each request still needs your approval.", runtime.registration.name)),
        installCommandBlock())];
    }));
  }
}

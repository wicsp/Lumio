/**
 * 设置页（ADR 0028）：账户、外观、语言、通知、助手模型、Hub、执行器、已连接的 agent、关于。
 * 桌面端从侧栏底部的账户按钮进入，窄屏从今日页右上角的头像进入，返回键回到上一页。
 */
import type { RuntimeInfo } from "@lumio/schema";
import { errorText, type Session } from "../api.ts";
import { clear, h, icon } from "../dom.ts";
import { ago } from "../format.ts";
import { lang, setLang, t, type Lang } from "../i18n.ts";
import { onTheme, setTheme, themeChoice, type ThemeChoice } from "../theme.ts";
import { LANGS, THEMES } from "../settings.ts";
import { AssistantSettings } from "../assistant-settings.ts";
import { AgentsSettings } from "../agents-settings.ts";
import { NotificationSettings } from "../notification-settings.ts";

const SOURCE = "https://github.com/wicsp/Lumio";

export class SettingsPane {
  private unbindTheme: () => void;
  private active = true;
  private themeTiles = new Map<ThemeChoice, HTMLButtonElement>();
  private hubRows = h("div", { class: "set-rows" });
  private runtimeRows = h("div", { class: "set-rows" });
  private assistant: AssistantSettings;
  private agents: AgentsSettings;
  private notifications: NotificationSettings;

  constructor(owner: HTMLElement, private session: Session, private name: string, private logout: () => void, back: () => void) {
    const bar = h("header", { class: "bar set-bar" },
      h("button", { type: "button", class: "icon-btn mobile-only", title: t("Back"), "aria-label": t("Back"), onclick: back }, icon("back")),
      h("h1", { class: "bar-title" }, t("Settings")));
    const page = h("div", { class: "set-page" },
      this.profile(),
      this.group(t("Appearance"), t("Choose how Lumio looks on this device."), this.themes()),
      this.group(t("Language"), t("Used for menus, dates and messages from the Hub."), this.languages()),
      this.group(t("Notifications"), t("Lumio notifies you only when it's your turn to answer, review or handle a failed round, and when an agent asks for approval. Notifications show the task title only."), (this.notifications = new NotificationSettings(session.client)).element),
      this.group(t("Assistant model"), t("Any service with a Chat Completions-compatible API. Saving takes effect immediately."), (this.assistant = new AssistantSettings(session.hub)).element),
      this.group(t("Hub"), undefined, this.hubRows),
      this.group(t("Runtimes"), t("Machines that run agents for this Hub."), this.runtimeRows),
      this.group(t("Connected agents"), t("Agents outside Lumio that can read your tasks and notes and make small changes. They can't mark tasks done, delegate, approve, or read private notes."), (this.agents = new AgentsSettings(session.client)).element),
      this.group(t("Recently deleted"), t("Deleted tasks, projects, notes and conversations stay here for 30 days."), h("div", { class: "set-rows" },
        h("a", { class: "set-row set-link", href: "#trash" }, h("span", { class: "set-label" }, t("Open Recently deleted")), icon("chevron")))),
      this.group(t("About"), undefined, h("div", { class: "set-rows" },
        this.row(t("Keyboard shortcuts"), h("span", { class: "set-value" }, h("kbd", {}, "⌘K"), " ", t("command menu"), " · ", h("kbd", {}, "1"), "–", h("kbd", {}, "6"), " ", t("sections"))),
        h("a", { class: "set-row set-link", href: SOURCE, target: "_blank", rel: "noopener noreferrer" },
          h("span", { class: "set-label" }, t("Source code")), h("span", { class: "set-value" }, "github.com/wicsp/Lumio"), icon("external")))),
      h("div", { class: "set-group" }, h("div", { class: "set-card" },
        h("button", { type: "button", class: "set-row set-danger", onclick: () => this.logout() }, icon("logout"), h("span", { class: "set-label" }, t("Sign out"))))));
    owner.append(bar, h("div", { class: "set-scroll" }, page));
    this.unbindTheme = onTheme(() => this.markTheme());
    clear(this.hubRows, this.row(t("Address"), h("span", { class: "set-value mono" }, location.host)), this.row(t("Status"), h("span", { class: "set-value muted" }, t("Checking…"))));
    clear(this.runtimeRows, h("p", { class: "set-empty" }, t("Loading…")));
    void this.loadHub();
    void this.loadRuntimes();
  }

  dispose(): void { this.active = false; this.unbindTheme(); this.assistant.dispose(); this.agents.dispose(); this.notifications.dispose(); }

  private profile(): HTMLElement {
    return h("section", { class: "set-profile" },
      h("span", { class: "set-avatar", "aria-hidden": "true" }, this.name.slice(0, 1).toUpperCase()),
      h("div", {}, h("p", { class: "set-name" }, this.name), h("p", { class: "set-sub" }, t("Signed in to {0}", location.host))));
  }

  private group(title: string, hint: string | undefined, body: HTMLElement): HTMLElement {
    return h("section", { class: "set-group" },
      h("h2", { class: "set-group-title" }, title),
      h("div", { class: "set-card" }, body),
      hint && h("p", { class: "set-hint" }, hint));
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

  /** 语言名称用各自的语言写，不翻译。切换后 App 会重建界面，仍停在设置页。 */
  private languages(): HTMLElement {
    return h("div", { class: "set-rows", role: "radiogroup", "aria-label": t("Language") }, ...LANGS.map(([value, label]) =>
      h("button", { type: "button", class: "set-row", role: "radio", "aria-checked": String(lang() === value), onclick: () => { if (lang() !== value) setLang(value as Lang); } },
        h("span", { class: "set-label" }, label), lang() === value ? icon("check", "icon set-check") : null)));
  }

  private async loadHub(): Promise<void> {
    let status: Node, version: string | undefined;
    try {
      const health = await this.session.health();
      version = health.version;
      status = h("span", { class: "set-value set-status" }, h("span", { class: `connection-dot${health.ok ? "" : " off"}` }), health.ok ? t("Connected") : t("Not healthy"));
    } catch (error) {
      status = h("span", { class: "set-value set-status" }, h("span", { class: "connection-dot off" }), errorText(error));
    }
    if (!this.active) return;
    clear(this.hubRows,
      this.row(t("Address"), h("span", { class: "set-value mono" }, location.host)),
      this.row(t("Version"), h("span", { class: "set-value mono" }, version ?? "—")),
      this.row(t("Status"), status));
  }

  private async loadRuntimes(): Promise<void> {
    let runtimes: RuntimeInfo[];
    try { runtimes = await this.session.client.runtimes(); } catch (error) {
      if (this.active) clear(this.runtimeRows, h("p", { class: "set-empty" }, errorText(error)));
      return;
    }
    if (!this.active) return;
    if (!runtimes.length) { clear(this.runtimeRows, h("p", { class: "set-empty" }, t("No runtimes yet. Run lumio runtime add <name> to pair a machine."))); return; }
    clear(this.runtimeRows, ...runtimes.map(runtime => h("div", { class: "set-row" },
      h("span", { class: `connection-dot${runtime.online ? "" : " off"}` }),
      h("span", { class: "set-label" }, runtime.registration.name,
        h("span", { class: "set-sub" }, runtime.registration.engines.map(engine => engine.name).join(", ") || t("No agents"))),
      h("span", { class: "set-value muted" }, runtime.online ? t("Online") : t("Last seen {0}", ago(runtime.last_seen))))));
  }
}

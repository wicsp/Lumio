import { observationSettings } from "../observation-settings.ts";
import type { UsageObservations } from "../usage-observations.ts";
/**
 * 设置页（ADR 0028）：二级菜单。桌面左侧是分类，右侧是当前分类的内容；
 * 窄屏先显示分类列表，点进分类后用返回键回到列表。地址是 `#settings/<分类>`。
 * 各分类在第一次打开时才创建，离开设置页时一起释放。
 * 不常改的配置（配对、代理、改键说明等）放进可折叠的卡片，展开状态记在当前浏览器。
 */
import { imageHostingSettings } from "../image-hosting-settings.ts";
import type { RuntimeInfo } from "@lumio/schema";
import { errorText, type Session } from "../api.ts";
import { clear, confirmDialog, h, icon, openDialog, toast } from "../dom.ts";
import { ago } from "../format.ts";
import { formatTime } from "../commands.ts";
import { helperState, installCommandBlock } from "../privileged-helper.ts";
import { lang, setLang, t, type Lang } from "../i18n.ts";
import { onTheme, setTheme, themeChoice, type ThemeChoice } from "../theme.ts";
import { browserChoiceRow, LANGS, THEMES } from "../settings.ts";
import { sidebarUsageStyle } from "../browser-preferences.ts";
import { AISettings } from "../ai-settings.ts";
import { AgentsSettings } from "../agents-settings.ts";
import { AgentConcurrencySettings } from "../agent-concurrency-settings.ts";
import { JobInteractionSettings } from "../job-interaction-settings.ts";
import { KnowledgeAISettings } from "../knowledge-ai-settings.ts";
import { captureProxySettings } from "../capture-proxy-settings.ts";
import { IPHONE_SHORTCUTS, isIOSDevice, pairingUrl, phoneHubDefault, shortcutInstallUrl, unreachableFromPhone } from "../iphone-setup.ts";
import { qrSvg } from "../qr-code.ts";
import type { GamepadInput } from "../gamepad-input.ts";
import { SECTIONS } from "../navigation.ts";
import { GamepadSettings } from "../gamepad-settings.ts";
import { NotificationSettings } from "../notification-settings.ts";
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, foldOpen, rememberFold, settingsNavGroups, settingsSection, type SettingsSection } from "../settings-sections.ts";

const SOURCE = "https://github.com/wicsp/Lumio";

interface Built { element: HTMLElement; refresh?: () => void; dispose?: () => void }
type Health = { ok: boolean; version?: string } | { error: unknown };

export class SettingsPane {
  private unbindTheme: () => void;
  private active = true;
  private themeTiles = new Map<ThemeChoice, HTMLButtonElement>();
  private built = new Map<SettingsSection, Built>();
  private navItems = new Map<SettingsSection, HTMLAnchorElement>();
  private shell = h("div", { class: "set-shell" });
  private scroll = h("div", { class: "set-scroll" }, this.shell);
  private content = h("div", { class: "set-content" });
  private title = h("span", { class: "set-mobile-title" }, t("Settings"));
  private shown?: SettingsSection;
  private health?: Promise<Health>;
  private runtimeRows?: HTMLElement;
  private runtimeLoad = 0;

  constructor(owner: HTMLElement, private session: Session, private name: string, private logout: () => void,
    private back: () => void, private navigate: (section?: SettingsSection) => void, initial?: string, private gamepad?: GamepadInput, private observations?: UsageObservations) {
    const bar = h("header", { class: "bar set-bar" },
      h("button", { type: "button", class: "icon-btn mobile-only", title: t("Back"), "aria-label": t("Back"), onclick: () => this.goBack() }, icon("back")),
      h("h1", { class: "bar-title" }, h("span", { class: "set-desktop-title" }, t("Settings")), this.title));
    this.shell.append(this.nav(), this.content);
    owner.append(bar, this.scroll);
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
    if (key === this.shown) { this.built.get(key)?.refresh?.(); return; }
    if (this.shown === "devices") {
      this.runtimeRows = undefined;
      this.built.get("devices")?.dispose?.();
      this.built.delete("devices");
    }
    this.shown = key;
    let built = this.built.get(key);
    if (!built) { built = this.build(key); this.built.set(key, built); }
    built.refresh?.();
    clear(this.content, built.element);
    this.scroll.scrollTop = 0;
  }

  private goBack(): void {
    if (this.shell.classList.contains("at-index")) this.back();
    else this.navigate(undefined);
  }

  // ───────────── 分类导航 ─────────────

  private nav(): HTMLElement {
    const item = (section: (typeof SETTINGS_SECTIONS)[number]) => {
      const item = h("a", { class: "set-nav-item", "data-pad-row": `settings:${section.key}`, href: `#settings/${section.key}`, "aria-current": "false",
        onclick: (event: Event) => { const click = event as MouseEvent; if (click.metaKey || click.ctrlKey || click.shiftKey) return; event.preventDefault(); this.navigate(section.key); } },
        h("span", { class: "set-nav-icon" }, icon(section.icon)),
        h("span", { class: "set-nav-label" }, t(section.label)),
        icon("chevron", "icon set-nav-chevron"));
      this.navItems.set(section.key, item);
      return item;
    };
    const groups = settingsNavGroups().map(group => h("div", { class: "set-nav-group" },
      group.title ? h("p", { class: "set-nav-heading" }, t(group.title)) : null,
      h("div", { class: "set-nav-list" }, ...group.sections.map(item))));
    return h("nav", { class: "set-nav", "aria-label": t("Settings") },
      this.profile(),
      ...groups,
      h("button", { type: "button", class: "set-nav-item set-nav-signout", onclick: () => this.logout() },
        h("span", { class: "set-nav-icon" }, icon("logout")), h("span", { class: "set-nav-label" }, t("Sign out"))));
  }

  private profile(): HTMLElement {
    return h("section", { class: "set-profile" },
      h("span", { class: "set-avatar", "aria-hidden": "true" }, this.name.slice(0, 1).toUpperCase()),
      h("p", { class: "set-name" }, this.name));
  }

  // ───────────── 各分类内容 ─────────────

  private build(key: SettingsSection): Built {
    const title = h("h2", { class: "set-title" }, t(SETTINGS_SECTIONS.find(section => section.key === key)!.label));
    const page = (...children: Array<Node | null | undefined | false>) => h("div", { class: "set-page" }, title, ...children);
    switch (key) {
      case "general": {
        const usageStyle = browserChoiceRow(sidebarUsageStyle);
        return { element: page(
          this.group(t("Appearance"), h("div", {}, this.themes(), usageStyle.element)),
          this.group(t("Language"), this.languages())),
          dispose: usageStyle.dispose };
      }
      case "controls": {
        const gamepad = this.gamepad ? new GamepadSettings(this.gamepad) : undefined;
        return { element: page(
          this.group(t("Keyboard shortcuts"), h("div", { class: "set-rows" },
            this.row(t("Command menu"), h("span", { class: "set-value" }, h("kbd", {}, "⌘K"))),
            this.row(t("Switch sections"), h("span", { class: "set-value" }, h("kbd", {}, "1"), "–", h("kbd", {}, SECTIONS.length))))),
          gamepad && this.group(t("Gamepad"), gamepad.element)), dispose: () => gamepad?.dispose() };
      }
      case "notifications": {
        const notifications = new NotificationSettings(this.session.client);
        return { element: page(notifications.element),
          dispose: () => notifications.dispose() };
      }
      case "ai": {
        const profiles = new AISettings(this.session.client, (title, body, action) => this.group(title, body, action));
        return { element: page(profiles.element), dispose: () => profiles.dispose() };
      }
      case "execution": {
        const interaction = new JobInteractionSettings(this.session.client);
        const concurrency = new AgentConcurrencySettings(this.session.client);
        return { element: page(
          this.group(t("Agent concurrency defaults"), concurrency.element),
          this.group(t("Project concurrency"), concurrency.projects),
          this.group(t("Task execution"), interaction.element)),
          dispose: () => { interaction.dispose(); concurrency.dispose(); } };
      }
      case "devices": {
        const hubRows = h("div", { class: "set-rows" }), runtimeRows = h("div", { class: "set-rows" });
        clear(hubRows, this.row(t("Address"), h("span", { class: "set-value mono" }, location.host)), this.row(t("Status"), h("span", { class: "set-value muted" }, t("Checking…"))));
        clear(runtimeRows, h("p", { class: "set-empty" }, t("Loading…")));
        void this.loadHub(hubRows);
        this.runtimeRows = runtimeRows;
        void this.loadRuntimes(runtimeRows);
        return { element: page(this.group(t("Hub"), hubRows),
          this.group(t("Runtimes"), runtimeRows)) };
      }
      case "capture": {
        const cards = new KnowledgeAISettings(this.session.client);
        void this.session.client.aiConfiguration().then(config => cards.update(config), () => cards.update({ connections: [], profiles: [] }));
        const proxy = captureProxySettings(this.session.client);
        return { element: page(
          this.group(t("Inbox cards"), cards.element),
          this.group(t("Devices"), h("div", { class: "set-folds" },
            this.fold("capture.browser", "globe", t("Browser extension"), this.pairing("browser")),
            this.fold("capture.mac", "monitor", t("Lumio Capture for Mac"), this.pairing("desktop")),
            this.fold("capture.iphone", "device", t("iPhone"), this.iphoneSetup()))),
          this.group(t("Advanced"), this.fold("capture.proxy", "route", t("Capture proxy"), proxy.element))),
          dispose: () => { cards.dispose(); proxy.dispose(); } };
      }
      case "agents": {
        const agents = new AgentsSettings(this.session.client);
        return { element: h("div", { class: "set-page" },
          h("div", { class: "set-page-heading" }, title, agents.versionButton), agents.element),
          dispose: () => agents.dispose() };
      }
      case "data": {
        const images = imageHostingSettings(this.session.client);
        const usage = this.observations && observationSettings(this.observations);
        return { refresh: usage?.refresh, element: page(...(usage ? [this.group(t("Usage observations"), usage.element)] : []), this.group(t("Image hosting"), images.element),
          h("a", { class: "set-row set-link", href: "#trash" }, icon("trash", "icon set-row-icon"), h("span", { class: "set-label" }, t("Recently deleted")), icon("chevron"))),
          dispose: images.dispose };
      }
      case "about": {
        const version = h("span", { class: "set-value mono" }, "…");
        void this.hubHealth().then(health => { if (this.active) version.textContent = "version" in health && health.version ? health.version : "—"; });
        return { element: page(
          h("section", { class: "set-about" },
            h("span", { class: "brand-mark", "aria-hidden": "true" }), h("p", { class: "set-name" }, "Lumio")),
          this.group(t("Details"), h("div", { class: "set-rows" },
            this.row(t("Hub version"), version),
            h("a", { class: "set-row set-link", href: SOURCE, target: "_blank", rel: "noopener noreferrer" },
              h("span", { class: "set-label" }, t("Source code")), h("span", { class: "set-value" }, "github.com/wicsp/Lumio"), icon("external"))))) };
      }
    }
  }

  private group(title: string, body: HTMLElement, action?: HTMLElement): HTMLElement {
    return h("section", { class: "set-group" },
      h("div", { class: "set-group-head" }, h("h3", { class: "set-group-title" }, title), action),
      h("div", { class: "set-card" }, body));
  }

  /**
   * 可折叠的卡片：标题行常显（图标、名称），展开后才显示内容。
   * 默认收起；展开状态按 key 记在当前浏览器。
   */
  private fold(key: string, glyph: string, title: string, body: HTMLElement): HTMLElement {
    const details = h("details", { class: "set-fold", "data-fold": key },
      h("summary", { class: "set-row set-fold-head" },
        h("span", { class: "set-row-badge" }, icon(glyph)),
        h("span", { class: "set-label" }, title),
        icon("chevron", "icon set-fold-chevron")),
      h("div", { class: "set-fold-body" }, body));
    if (foldOpen(key, false)) details.setAttribute("open", "");
    details.addEventListener("toggle", () => rememberFold(key, details.open));
    return details;
  }

  /**
   * iPhone 快捷指令（apps/mobile）：电脑上扫码安装、扫码配对，电脑是什么系统都行；
   * 在 iPhone 上打开这个页面时扫不了自己的屏幕，改成直接点按钮安装和配对。
   */
  private iphoneSetup(): HTMLElement {
    const onPhone = isIOSDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
    const installs = onPhone
      ? h("div", { class: "set-actions" }, ...IPHONE_SHORTCUTS.map(item =>
        h("a", { class: "btn btn-small", href: shortcutInstallUrl(item.name) }, t("Add {0}").replace("{0}", item.name))))
      : h("div", { class: "qr-row" }, ...IPHONE_SHORTCUTS.map(item => {
        const url = shortcutInstallUrl(item.name);
        return h("figure", { class: "qr-card" }, qrSvg(url, item.name),
          h("figcaption", {}, h("a", { href: url, target: "_blank", rel: "noopener" }, item.name),
            h("span", { class: "set-sub" }, item.use === "save" ? t("Bind to Back Tap") : t("Bind to the Action Button"))));
      }));
    const result = h("div", { class: "set-pairing", role: "status" });
    const button = h("button", { type: "button", class: "btn btn-small" }, onPhone ? t("Create pairing link") : t("Create pairing QR code"));
    button.addEventListener("click", () => void (async () => {
      button.disabled = true; clear(result);
      try {
        const invite = await this.session.client.clientInvite(`iphone@${new Date().toISOString().slice(0, 10)}`);
        const address = h("input", { class: "mono set-input-wide", type: "url", value: phoneHubDefault(invite.hub_url, location.origin), "aria-label": t("Hub address the iPhone can reach") });
        const code = h("div", { class: onPhone ? "set-actions" : "qr-row" });
        const warning = h("p", { class: "field-hint inbox-error" });
        const draw = () => {
          const hub = address.value.trim(), unreachable = unreachableFromPhone(hub);
          warning.textContent = unreachable ? t("The iPhone can't reach this address. Use this computer's LAN or Tailscale address.") : "";
          if (unreachable) clear(code);
          else if (onPhone) clear(code, h("a", { class: "btn btn-small btn-primary", href: pairingUrl(hub, invite.code, lang()) }, t("Pair this iPhone")));
          else clear(code, h("figure", { class: "qr-card" }, qrSvg(pairingUrl(hub, invite.code, lang()), t("Pairing QR code"))));
        };
        address.addEventListener("input", draw);
        draw();
        clear(result,
          h("div", { class: "set-row set-row-stack" }, h("span", { class: "set-label" }, t("Hub address the iPhone can reach")), address),
          warning, code,
          this.row(t("Expires"), h("time", { class: "set-value", datetime: invite.expires }, formatTime(invite.expires))));
      } catch (error) {
        clear(result, h("p", { class: "field-hint inbox-error" }, errorText(error)));
      } finally { button.disabled = false; }
    })());
    return h("div", { class: "set-rows" },
      h("div", { class: "set-row set-row-stack" }, h("span", { class: "set-label" }, t("Install shortcuts")), installs),
      h("div", { class: "set-row" }, h("span", { class: "set-label" }, t("Pair this iPhone")), button),
      result);
  }

  private pairing(kind: "browser" | "desktop"): HTMLElement {
    const result = h("div", { class: "set-pairing", role: "status" });
    const button = h("button", { type: "button", class: "btn btn-small" }, t("Create pairing code"));
    button.addEventListener("click", () => void (async () => {
      button.disabled = true; clear(result);
      try {
        const invite = await this.session.client.clientInvite(`${kind}@${new Date().toISOString().slice(0, 10)}`);
        clear(result,
          this.row(t("Hub address"), h("span", { class: "set-value mono" }, invite.hub_url)),
          this.row(t("Pairing code"), h("span", { class: "set-value mono set-code" }, invite.code)),
          this.row(t("Expires"), h("time", { class: "set-value", datetime: invite.expires }, formatTime(invite.expires))));
      } catch (error) {
        clear(result, h("p", { class: "field-hint inbox-error" }, errorText(error)));
      } finally { button.disabled = false; }
    })());
    return h("div", { class: "set-rows" },
      h("div", { class: "set-actions" }, button),
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

  private async removeRuntime(name: string, button: HTMLButtonElement): Promise<void> {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const confirmed = await confirmDialog({
        title: t("Remove {0}?", name),
        message: t("This revokes the runtime’s access to this Hub. Any running jobs may be interrupted. Job history is kept."),
        confirm: t("Remove"),
        danger: true,
      });
      if (!confirmed || !this.active || !button.isConnected) return;
      await this.session.client.removeRuntime(name);
      if (this.active) {
        toast(t("Removed {0}.", name));
        const rows = this.runtimeRows;
        if (rows?.isConnected) await this.loadRuntimes(rows);
      }
    } catch (error) {
      if (this.active && button.isConnected) toast(t("Could not remove {0}. {1}", name, errorText(error)), "error");
    } finally {
      button.disabled = false;
    }
  }

  private async loadRuntimes(rows: HTMLElement): Promise<void> {
    const request = ++this.runtimeLoad;
    const current = () => this.active && this.runtimeRows === rows && this.runtimeLoad === request;
    let runtimes: RuntimeInfo[];
    try { runtimes = await this.session.client.runtimes(); } catch (error) {
      if (current()) clear(rows, h("p", { class: "set-empty" }, errorText(error)));
      return;
    }
    if (!current()) return;
    if (!runtimes.length) { clear(rows, h("p", { class: "set-empty" }, t("No runtimes yet. Run lumio runtime add <name> to pair a machine."))); return; }
    clear(rows, ...runtimes.map(runtime => {
      const name = runtime.registration.name;
      const helper = helperState(runtime.registration);
      const engines = runtime.registration.engines.map(engine => engine.name).join(", ") || t("No agents");
      const connection = runtime.online ? t("Online") : t("Last seen {0}", ago(runtime.last_seen));
      const install = t("Install administrator helper on {0}", name);
      const status = helper === "installed" ? t("Administrator helper: installed")
        : helper === "missing" ? t("Administrator helper: not installed") : t("Administrator helper: unknown (update this runtime to see)");
      const sudo = helper === "missing"
        ? h("button", { type: "button", class: "runtime-sudo missing", title: install,
          "aria-label": `${status}. ${install}`, "aria-haspopup": "dialog",
          onclick: () => openDialog(install, installCommandBlock(), []) }, "sudo", icon("close"))
        : h("span", { class: `runtime-sudo ${helper}`, title: status, role: "img", "aria-label": status },
          "sudo", icon(helper === "installed" ? "check" : "help"));
      const removeLabel = t("Remove runtime {0}", name);
      const remove = h("button", { type: "button", class: "icon-btn row-delete", title: removeLabel, "aria-label": removeLabel,
        onclick: () => void this.removeRuntime(name, remove) }, icon("trash"));
      return h("div", { class: "set-row runtime-row" },
        h("div", { class: "set-label" },
          h("div", { class: "runtime-name" },
            h("span", { class: `connection-dot${runtime.online ? "" : " off"}`, title: connection, role: "img", "aria-label": connection }),
            h("span", { class: "runtime-text", title: name }, name)),
          h("span", { class: "set-sub runtime-text", title: engines }, engines)),
        h("div", { class: "runtime-actions" }, sudo, remove));
    }));
  }
}

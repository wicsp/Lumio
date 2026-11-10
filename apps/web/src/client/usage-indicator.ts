/**
 * 侧栏 AI 用量指示器：在侧栏底部、账号上方，每个开启监控的连接一行。
 * 订阅额度显示各窗口中最少的剩余百分比，细条依次是从短到长的窗口；API 余额显示余额。
 * 平时是灰色，低于监控阈值变黄，用完变红；收起侧栏时只剩一个圆环，表示最紧张的额度。
 * 点一行弹出详情（各窗口剩余与重置时间、刷新、去设置）。数据复用 ADR 0052 的用量接口，不新增契约。
 */
import type { AIConnection, AIQuotaView, AIQuotaWindow } from "@lumio/schema";
import { errorText, type Client } from "./api.ts";
import { clear, failure, h, icon } from "./dom.ts";
import { t } from "./i18n.ts";
import { formatTime } from "./commands.ts";
import { amount, usageSummary, windowRow } from "./ai-usage.ts";

export type UsageLevel = "ok" | "low" | "empty" | "issue";
export type UsageGlance = {
  connection: string;
  name: string;
  level: UsageLevel;
  /** 订阅额度：各窗口中最少的剩余百分比（整数）。API 余额没有这一项。 */
  remaining?: number;
  /** 每个窗口的剩余百分比，从短窗口到长窗口，最多两条。 */
  bars: number[];
  /** 行尾显示的值：百分比、余额，或无法读取时的「—」。 */
  value: string;
};

/** 没有可用读数、或读数来源本身有问题的状态。离线、过期但仍有上次读数时照常显示。 */
const BROKEN = new Set<AIQuotaView["status"]>(["credentials", "error", "unsupported"]);
const SEVERITY: Record<UsageLevel, number> = { ok: 0, issue: 1, low: 2, empty: 3 };

const remainingOf = (window: AIQuotaWindow) => Math.max(0, Math.round(100 - window.used_percent!));

export function usageGlance(connection: AIConnection, usage: AIQuotaView): UsageGlance | undefined {
  if (!usage.settings.monitor) return undefined;
  const base = { connection: connection.id, name: connection.name };
  const snapshot = usage.snapshot;
  if (!snapshot || BROKEN.has(usage.status) || usage.claude_issue) return { ...base, level: "issue", bars: [], value: "—" };
  if (snapshot.source === "deepseek") {
    const balance = snapshot.balances.find(b => b.currency === "CNY") ?? snapshot.balances[0];
    const level: UsageLevel = !snapshot.available ? "empty" : usage.attention ? "low" : "ok";
    return { ...base, level, bars: [], value: balance ? amount(balance.currency, balance.total) : "—" };
  }
  const windows = snapshot.windows.filter(window => window.used_percent !== undefined)
    .sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  if (!windows.length) return { ...base, level: "issue", bars: [], value: "—" };
  const bars = windows.slice(0, 2).map(remainingOf);
  const remaining = Math.min(...windows.map(remainingOf));
  const level: UsageLevel = remaining === 0 ? "empty" : usage.attention ? "low" : "ok";
  return { ...base, level, remaining, bars, value: `${remaining}%` };
}

/** 收起侧栏时的圆环：颜色取最严重的一行，弧长取订阅额度里最少的剩余；只有 API 余额时画满。 */
export function usageRing(glances: readonly UsageGlance[]): { level: UsageLevel; remaining: number } | undefined {
  if (!glances.length) return undefined;
  const level = glances.reduce<UsageLevel>((worst, g) => SEVERITY[g.level] > SEVERITY[worst] ? g.level : worst, "ok");
  const values = glances.flatMap(g => g.remaining === undefined ? [] : [g.remaining]);
  return { level, remaining: values.length ? Math.min(...values) : level === "empty" ? 0 : 100 };
}

const LEVEL_LABEL: Record<UsageLevel, string> = { ok: "", low: "Running low", empty: "Used up", issue: "Usage unavailable" };
const RING_R = 9, RING_C = 2 * Math.PI * RING_R;
const MIN_INTERVAL = 30_000, CONFIG_TTL = 10 * 60_000;

export class UsageIndicator {
  readonly element = h("div", { class: "usage-glance", hidden: true });
  private rows = h("div", { class: "usage-rows", role: "group", "aria-label": t("AI usage") });
  private ring = h("button", { type: "button", class: "usage-ring", onclick: () => this.openSettings() });
  private connections = new Map<string, AIConnection>();
  private usage = new Map<string, AIQuotaView>();
  private configAt = 0;
  private loadedAt = 0;
  private loading = false;
  private disposed = false;
  private popover?: { element: HTMLElement; anchor: HTMLElement; connection: string; close: () => void };
  private timer = setInterval(() => void this.refresh(), 60_000);

  constructor(private client: Client, private openSettings: () => void) {
    this.element.append(this.rows, this.ring);
    void this.refresh(true);
  }

  /** 工作台刷新时调用；距上次不足 30 秒时跳过，除非 force。 */
  async refresh(force = false): Promise<void> {
    if (this.loading || this.disposed) return;
    if (!force && (document.visibilityState !== "visible" || Date.now() - this.loadedAt < MIN_INTERVAL)) return;
    this.loading = true;
    try {
      const usage = await this.client.aiUsage();
      const unknown = usage.some(view => !this.connections.has(view.connection));
      if (unknown || Date.now() - this.configAt > CONFIG_TTL) {
        const config = await this.client.aiConfiguration();
        this.connections = new Map(config.connections.map(c => [c.id, c]));
        this.configAt = Date.now();
      }
      this.usage = new Map(usage.map(view => [view.connection, view]));
      this.loadedAt = Date.now();
      if (!this.disposed) this.render();
    } catch { /* 旧 Hub 没有用量接口，或暂时连不上：保持上一次的显示 */ }
    finally { this.loading = false; }
  }

  private glances(): UsageGlance[] {
    return [...this.usage.values()].flatMap(view => {
      const connection = this.connections.get(view.connection);
      const glance = connection && usageGlance(connection, view);
      return glance ? [glance] : [];
    });
  }

  private render(): void {
    const glances = this.glances();
    this.element.hidden = !glances.length;
    clear(this.rows, ...glances.map(g => this.row(g)));
    const ring = usageRing(glances);
    if (ring) {
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
      const circle = (cls: string, dash?: string) => {
        const c = document.createElementNS(ns, "circle");
        for (const [k, v] of Object.entries({ cx: "12", cy: "12", r: String(RING_R), class: cls })) c.setAttribute(k, v);
        if (dash) c.setAttribute("stroke-dasharray", dash);
        return c;
      };
      svg.append(circle("usage-ring-track"), circle("usage-ring-fill", `${(RING_C * ring.remaining) / 100} ${RING_C}`));
      clear(this.ring, svg);
      this.ring.dataset.level = ring.level;
      const summary = glances.map(g => `${g.name} ${g.value}`).join(" · ");
      this.ring.title = summary;
      this.ring.setAttribute("aria-label", t("AI usage: {0}", summary));
    }
    if (this.popover) {
      const view = this.usage.get(this.popover.connection), connection = this.connections.get(this.popover.connection);
      if (view && connection && glances.some(g => g.connection === connection.id)) this.fillPopover(this.popover.element, connection, view);
      else this.popover.close();
    }
  }

  private row(g: UsageGlance): HTMLElement {
    const label = [g.name, g.value, t(LEVEL_LABEL[g.level])].filter(Boolean).join(" · ");
    const button = h("button", { type: "button", class: "usage-row", "data-level": g.level, "data-connection": g.connection,
      title: label, "aria-label": label, "aria-haspopup": "dialog", "aria-expanded": String(this.popover?.connection === g.connection),
      onclick: () => this.toggle(button, g.connection) },
      h("span", { class: "usage-name" }, g.name),
      h("span", { class: "usage-bars", "aria-hidden": "true" }, ...g.bars.map(value => {
        const fill = h("i");
        fill.style.width = `${value}%`; // CSP 不允许内联 style 属性，用 CSSOM 设置
        return h("span", { class: "usage-bar" }, fill);
      })),
      h("span", { class: "usage-value" }, g.level === "issue" ? icon("alert") : g.value));
    return button;
  }

  private toggle(anchor: HTMLElement, id: string): void {
    const same = this.popover?.connection === id;
    this.popover?.close();
    if (same) return;
    const connection = this.connections.get(id), view = this.usage.get(id);
    if (!connection || !view) return;
    const element = h("div", { class: "menu usage-pop", role: "dialog", "aria-label": connection.name, tabindex: "-1" });
    const outside = (event: MouseEvent) => { if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); anchor.focus(); } };
    const close = () => {
      element.remove();
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", key, true);
      anchor.setAttribute("aria-expanded", "false");
      if (this.popover?.element === element) this.popover = undefined;
    };
    this.popover = { element, anchor, connection: id, close };
    this.fillPopover(element, connection, view);
    document.body.append(element);
    const rect = anchor.getBoundingClientRect();
    element.style.left = `${Math.min(rect.right + 8, window.innerWidth - element.offsetWidth - 8)}px`;
    element.style.top = `${Math.max(8, Math.min(rect.bottom - element.offsetHeight, window.innerHeight - element.offsetHeight - 8))}px`;
    anchor.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", key, true);
    element.focus();
  }

  private fillPopover(element: HTMLElement, connection: AIConnection, view: AIQuotaView): void {
    const snapshot = view.snapshot;
    const isClaude = connection.kind === "claude-code-subscription";
    const message = h("div", { role: "status" });
    const body: Array<HTMLElement | undefined> = [];
    if (snapshot?.source === "deepseek") {
      body.push(...snapshot.balances.map(balance => h("div", { class: "ai-quota-window" },
        h("strong", {}, `${amount(balance.currency, balance.total)} ${balance.currency}`),
        h("span", { class: "set-sub" }, t("Topped up {0} · Granted {1}", amount(balance.currency, balance.topped_up), amount(balance.currency, balance.granted))))));
      if (!snapshot.available) body.push(h("p", { class: "field-hint" }, t("DeepSeek reports insufficient balance for API calls.")));
    } else if (snapshot) {
      body.push(...[...snapshot.windows].sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity)).map(windowRow));
    }
    const actions = h("div", { class: "button-row" });
    const canRefresh = (isClaude && view.settings.claude_mode === "background") || (!isClaude && view.status !== "unsupported");
    if (canRefresh) {
      const refresh = h("button", { type: "button", class: "btn btn-small" }, icon("refresh"), t("Refresh usage"));
      refresh.onclick = async () => {
        refresh.disabled = true;
        clear(message);
        try {
          const next = await this.client.refreshAIUsage(connection.id);
          this.usage.set(next.connection, next);
          this.render();
        } catch (cause) { clear(message, failure(errorText(cause))); }
        finally { refresh.disabled = false; }
      };
      actions.append(refresh);
    }
    actions.append(h("button", { type: "button", class: "btn btn-small", onclick: () => { this.popover?.close(); this.openSettings(); } }, t("Monitoring settings")));
    clear(element,
      h("div", { class: "usage-pop-head" }, h("strong", {}, connection.name), h("span", { class: "set-sub" }, connection.host === "hub" ? "Hub" : connection.host)),
      h("p", { class: "set-sub usage-pop-status" }, usageSummary(view)),
      ...body,
      snapshot && h("p", { class: "field-hint" }, t("Last successful reading {0}", formatTime(snapshot.sampled_at))),
      actions, message);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.popover?.close();
  }
}

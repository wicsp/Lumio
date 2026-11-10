/**
 * 设置页「已连接的 agent」（ADR 0029 第 6 节）：谁能以 agent 身份访问 Lumio、最近活动、吊销。
 * 接入在那台机器上用 `lumio skill install` 完成（它用已登录的 CLI 发令牌），网页不显示也不保存令牌。
 */
import type { AgentInfo } from "@lumio/schema";
import { ApiClientError } from "@lumio/api-client";
import { errorText, type Client } from "./api.ts";
import { formatTime } from "./commands.ts";
import { clear, confirmDialog, failure, h, icon, toast } from "./dom.ts";
import { ago } from "./format.ts";
import { t } from "./i18n.ts";

type AgentKind = "codex" | "claude" | "pi";
const AGENT_KINDS: Array<[AgentKind, string]> = [["codex", "Codex"], ["claude", "Claude Code"], ["pi", "pi"]];
const INSTALL: Record<AgentKind, string> = { codex: "lumio skill install --for codex", claude: "lumio skill install --for claude", pi: "lumio skill install --for pi" };

export class AgentsSettings {
  readonly element = h("div", { class: "set-rows" });
  private kind: AgentKind = "codex";
  private active = true;

  constructor(private client: Client) {
    clear(this.element, h("p", { class: "set-empty" }, t("Loading…")));
    void this.load();
  }
  dispose(): void { this.active = false; }

  private async load(): Promise<void> {
    try {
      const agents = await this.client.agents();
      if (this.active) this.render(agents);
    } catch (cause) {
      if (!this.active) return;
      const missing = cause instanceof ApiClientError && cause.code === "NOT_FOUND";
      clear(this.element, h("p", { class: "set-empty" }, missing ? t("This Hub doesn't support connected agents yet. Run lumio upgrade.") : errorText(cause)));
    }
  }

  private render(agents: AgentInfo[]): void {
    const connected = agents.filter(agent => agent.tokens.length).sort((a, b) => (b.last_activity ?? "").localeCompare(a.last_activity ?? ""));
    const rows = connected.map(agent => this.row(agent));
    // 三种 agent 的安装命令（R4-8）：切换后显示对应的命令。
    const code = h("code", { class: "set-code" }, INSTALL[this.kind]);
    const tabs = h("div", { class: "segmented set-tabs", role: "group", "aria-label": t("Agent") }, ...AGENT_KINDS.map(([kind, label]) => {
      const tab = h("button", { type: "button", "aria-pressed": String(kind === this.kind) }, label);
      tab.addEventListener("click", () => {
        this.kind = kind; code.textContent = INSTALL[kind];
        tabs.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(button === tab)));
      });
      return tab;
    }));
    const howto = h("div", { class: "set-row set-howto" },
      icon("terminal"),
      h("span", { class: "set-label" }, t("Connect Codex, Claude Code or pi"),
        h("span", { class: "set-sub" }, t("On that machine, in a terminal logged in to this Hub, run:")),
        tabs, code),
      h("button", { type: "button", class: "btn btn-small", onclick: () => void navigator.clipboard?.writeText(INSTALL[this.kind]).then(() => toast(t("Copied"))) }, icon("link"), t("Copy")));
    clear(this.element, ...(rows.length ? rows : [h("p", { class: "set-empty" }, t("No agents connected yet."))]), howto);
  }

  private row(agent: AgentInfo): HTMLElement {
    const manual = agent.tokens.filter(token => token.kind === "manual");
    const rounds = agent.tokens.filter(token => token.kind === "job");
    const used = agent.tokens.map(token => token.last_used).filter(Boolean).sort().at(-1);
    const sub = [
      manual.length ? t(manual.length === 1 ? "{0} key" : "{0} keys", manual.length) : "",
      rounds.length ? t(rounds.length === 1 ? "in {0} running round" : "in {0} running rounds", rounds.length) : "",
    ].filter(Boolean).join(t(" · "));
    const last = agent.last_activity ?? used;
    const revoke = manual.length ? h("button", { type: "button", class: "btn btn-quiet btn-small set-danger" }, t("Revoke")) : null;
    revoke?.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: t("Revoke access"), message: t("Revoke access for {0}? It stops working immediately; reconnect with lumio skill install.", agent.actor.name), confirm: t("Revoke"), danger: true }))) return;
      revoke.disabled = true;
      try {
        await this.client.revokeAgent({ name: agent.actor.name });
        toast(t("Access revoked."));
        if (this.active) await this.load();
      } catch (cause) {
        revoke.disabled = false;
        if (this.active) this.element.append(failure(errorText(cause)));
      }
    });
    return h("div", { class: "set-row" },
      h("span", { class: `connection-dot${rounds.length ? "" : last ? "" : " off"}` }),
      h("span", { class: "set-label" }, agent.actor.name, h("span", { class: "set-sub" }, sub || t("No active keys"))),
      h("span", { class: "set-value muted", title: last ? formatTime(last) : "" }, last ? t("Active {0}", ago(last)) : t("Never used")),
      revoke);
  }
}

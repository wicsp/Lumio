/**
 * 设置 → 执行 →「Agent 并发」（PR #289）：每个 Agent 账号或后端一行。
 * 名称单独占一行，下面是带标签的输入框，窄栏（助手侧栏打开时）也不会把名称挤没。
 */
import { errorText, type Client } from "./api.ts";
import { clear, failure, h, toast } from "./dom.ts";
import { t } from "./i18n.ts";

type Rows = Awaited<ReturnType<Client["agentConcurrency"]>>;

export class AgentConcurrencySettings {
  readonly element = h("div", { class: "set-rows" });
  private active = true;

  constructor(private client: Client) {
    clear(this.element, h("p", { class: "set-empty" }, t("Loading…")));
    void this.load();
  }

  dispose(): void { this.active = false; }

  private async load(): Promise<void> {
    try {
      const rows = await this.client.agentConcurrency();
      if (this.active) this.render(rows);
    } catch (error) {
      if (this.active) clear(this.element, failure(errorText(error), () => void this.load()));
    }
  }

  private render(rows: Rows): void {
    if (!rows.length) { clear(this.element, h("p", { class: "set-empty" }, t("No agents yet."))); return; }
    clear(this.element, ...rows.map(row => {
      // 类型默认值只有一个数字，和名称排在同一行；具体执行器的几项带标签换到下一行。
      const compact = row.target.kind === "default";
      const field = (label: string, input: HTMLElement) => compact
        ? (input.setAttribute("aria-label", label), h("span", { class: "concurrency-field" }, input))
        : h("label", { class: "concurrency-field" }, h("span", { class: "set-sub" }, label), input);
      const group = h("input", { placeholder: t("None"), value: row.group ?? "", maxLength: 80 });
      const backend = row.target.kind === "runtime" && row.target.engine === "pi"
        ? h("input", { placeholder: t("Any"), value: row.target.backend ?? "", readOnly: !!row.target.backend, maxLength: 64 })
        : undefined;
      const limit = h("input", { type: "number", min: "1", step: "1", value: String(row.max_concurrent), required: true });
      const syncLimit = () => { limit.disabled = row.target.kind !== "default" && row.uses_default && !group.value.trim(); };
      group.addEventListener("input", syncLimit);
      syncLimit();
      const error = h("span", { role: "status", class: "set-sub" });
      const save = h("button", { type: "submit", class: "btn btn-small" }, t("Save"));
      const sub = row.target.kind === "default" ? t("Default limit for this agent type.") : row.uses_default ? t("Uses the default limit.") : "";
      return h("form", { class: `set-row concurrency-row${compact ? " compact" : ""}`, onsubmit: async (event: Event) => {
        event.preventDefault();
        if (save.disabled) return;
        save.disabled = true; error.textContent = "";
        try {
          const target = row.target.kind === "runtime" && backend?.value.trim() ? { ...row.target, backend: backend.value.trim() } : row.target;
          const updated = await this.client.setAgentConcurrency({ target, group: group.value.trim() || null, max_concurrent: limit.disabled ? null : Number(limit.value) });
          if (this.active) { this.render(updated); toast(t("Agent concurrency saved")); }
        } catch (cause) { error.textContent = errorText(cause); }
        finally { save.disabled = false; }
      } },
        h("span", { class: "set-label" }, row.name, sub ? h("span", { class: "set-sub" }, sub) : null),
        h("div", { class: "concurrency-fields" },
          row.target.kind === "default" ? null : field(t("Shared quota group"), group),
          backend && field(t("Pi provider"), backend),
          field(t("Job concurrency"), limit), save),
        error);
    }));
  }
}

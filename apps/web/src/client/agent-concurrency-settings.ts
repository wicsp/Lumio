/**
 * 设置 → 执行：默认 Agent 额度、账号例外和项目上限。
 */
import { errorText, type Client } from "./api.ts";
import { clear, failure, h, icon, toast } from "./dom.ts";
import { t } from "./i18n.ts";

type Rows = Awaited<ReturnType<Client["agentConcurrency"]>>;
const agentNames = { codex: "Codex", "claude-code": "Claude Code", pi: "Pi" };
const loading = () => h("p", { class: "set-empty" }, t("Loading…"));

export class AgentConcurrencySettings {
  readonly element = h("div", { class: "set-rows" });
  readonly projects = h("div", { class: "set-rows" });
  private active = true;
  private advancedOpen = false;

  constructor(private client: Client) {
    clear(this.element, loading());
    clear(this.projects, loading());
    void this.load();
    void this.loadProjects();
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

  private async loadProjects(): Promise<void> {
    try {
      const projects = (await this.client.workProjects()).filter(project => project.status !== "done");
      if (!this.active) return;
      clear(this.projects, ...(projects.length ? projects.map(project => h("a", {
        class: "set-row", href: `#work/${encodeURIComponent(project.id)}`,
      }, h("span", { class: "set-label" }, project.title,
        h("span", { class: "set-sub" }, t(project.auto_worktree ? "Automatic worktrees on" : "Automatic worktrees off"))),
        h("span", { class: "set-value" }, t("Up to {0} at once", project.max_concurrent ?? 1)),
        icon("chevron-right", "set-row-chevron"))) : [h("p", { class: "set-empty" }, t("No open projects."))]));
    } catch (error) {
      if (this.active) clear(this.projects, failure(errorText(error), () => void this.loadProjects()));
    }
  }

  private render(rows: Rows): void {
    if (!rows.length) { clear(this.element, h("p", { class: "set-empty" }, t("No agents yet."))); return; }
    const defaults = rows.filter(row => row.target.kind === "default");
    const exceptions = rows.filter(row => row.target.kind !== "default");
    const form = (row: Rows[number]) => {
      const compact = row.target.kind === "default";
      const name = row.target.kind === "default" ? agentNames[row.target.engine] : row.name;
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
      const sub = compact ? ""
        : row.group ? t("Shared limit for group {0}", row.group)
        : row.uses_default ? t("Default limit: {0}", row.max_concurrent) : t("Account limit: {0}", row.max_concurrent);
      return h("form", { class: `set-row concurrency-row${compact ? " compact" : ""}`, onsubmit: async (event: Event) => {
        event.preventDefault();
        if (save.disabled) return;
        save.disabled = true; error.textContent = "";
        try {
          const target = row.target.kind === "runtime" && backend?.value.trim() ? { ...row.target, backend: backend.value.trim() } : row.target;
          const updated = await this.client.setAgentConcurrency({ target, group: group.value.trim() || null, max_concurrent: limit.disabled ? null : Number(limit.value) });
          if (this.active) {
            this.advancedOpen = this.element.querySelector("details")?.open ?? false;
            this.render(updated);
            toast(t("Agent concurrency saved"));
          }
        } catch (cause) { error.textContent = errorText(cause); }
        finally { save.disabled = false; }
      } },
        h("span", { class: "set-label" }, name, sub ? h("span", { class: "set-sub" }, sub) : null),
        h("div", { class: "concurrency-fields" },
          row.target.kind === "default" ? null : field(t("Shared quota group"), group),
          backend && field(t("Pi provider"), backend),
          field(compact ? t("{0} default concurrency", name) : t("Job concurrency"), limit), save),
        error);
    };
    const advanced = exceptions.length ? h("details", { class: "set-fold concurrency-advanced" },
      h("summary", { class: "set-row" }, h("span", { class: "set-label" }, t("Accounts and providers")), icon("chevron-right", "set-fold-chevron")),
      h("div", { class: "set-fold-body" },
        h("p", { class: "field-hint concurrency-note" }, t("Use the same quota group for accounts or providers that share a limit across runtimes.")),
        h("div", { class: "set-rows" }, ...exceptions.map(form)))) : null;
    if (advanced) advanced.open = this.advancedOpen;
    clear(this.element, ...defaults.map(form), advanced);
  }
}

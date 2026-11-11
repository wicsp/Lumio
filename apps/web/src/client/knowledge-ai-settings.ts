/**
 * 设置 → AI 模型 →「资料摘要」（ADR 0057，I1-5）：选择给 Inbox 资料写卡片与深读的 Profile（`knowledge.summary` 用途绑定）。
 * 只能选 API 方式（引擎 lumio）的 Profile。向量用途在 I1-6 加入。
 */
import type { AIConfiguration, KnowledgeAIBinding } from "@lumio/schema";
import { errorText, isConflict, type Client } from "./api.ts";
import { newRequestId } from "./commands.ts";
import { clear, failure, h, toast } from "./dom.ts";
import { t } from "./i18n.ts";

export class KnowledgeAISettings {
  readonly element = h("div", { class: "knowledge-ai-settings" });
  private config: AIConfiguration = { connections: [], profiles: [] };
  private bindings: KnowledgeAIBinding[] = [];
  private loadError?: string;
  private active = true;

  constructor(private client: Client) {
    clear(this.element, h("p", { class: "set-empty" }, t("Loading…")));
  }

  dispose(): void { this.active = false; }

  update(config: AIConfiguration): void {
    this.config = config;
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const bindings = await this.client.knowledgeBindings();
      if (!this.active) return;
      this.bindings = bindings; this.loadError = undefined;
    } catch (cause) {
      if (!this.active) return;
      this.loadError = errorText(cause);
    }
    this.render();
  }

  private render(): void {
    if (this.loadError) { clear(this.element, failure(this.loadError, () => void this.load())); return; }
    const byId = new Map(this.config.connections.map(connection => [connection.id, connection]));
    const profiles = this.config.profiles.filter(profile => profile.engine === "lumio" && !!byId.get(profile.connection)?.base_url);
    const bound = this.bindings.find(binding => binding.purpose === "knowledge.summary");
    const message = h("div", { role: "status" });
    const select = h("select", { "aria-label": t("Summary model") },
      h("option", { value: "" }, t("Off")),
      ...profiles.map(profile => h("option", { value: profile.id }, `${profile.name} · ${byId.get(profile.connection)?.name ?? ""}`)));
    select.value = bound?.profile ?? "";
    select.addEventListener("change", () => void (async () => {
      select.disabled = true; clear(message);
      try {
        const profile = select.value || null;
        this.bindings = await this.client.saveKnowledgeBinding({ request_id: newRequestId(), purpose: "knowledge.summary", profile, ...(bound ? { expected_revision: bound.revision } : {}) });
        toast(profile ? t("New saves will get an AI card.") : t("AI cards are off. Saved items still go into the Inbox."));
        this.render();
      } catch (cause) {
        clear(message, failure(isConflict(cause) ? t("This was changed somewhere else. Reload and try again.") : errorText(cause)));
        select.value = bound?.profile ?? "";
      } finally { select.disabled = false; }
    })());
    clear(this.element, h("div", { class: "set-form-wrap" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Summary model")), select,
        h("span", { class: "field-hint" }, profiles.length
          ? t("Writes the short card for each saved item, and the deep read when you ask. The extracted text is sent to this model's service.")
          : t("Add an API profile first. Codex sessions can't write cards."))),
      message));
  }
}

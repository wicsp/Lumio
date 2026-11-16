/**
 * 设置 → AI 模型 →「资料摘要」（ADR 0057，I1-5）：选择给 Inbox 资料写卡片的 Profile（`knowledge.summary` 用途绑定），
 * 以及可选的看图 Profile（`knowledge.vision`，ADR 0066 第 6 节，C1-5）：只用于整理桌面小助手存下的截图。
 * 只能选 API 方式（引擎 lumio）的 Profile；模型是否支持图像由人判断，Hub 调用失败时退回本机识字结果。
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
    const summary = this.field("knowledge.summary", t("Summary model"), profiles, byId, profiles.length
      ? t("Writes the short card for each saved item, and the deep read when you ask. The extracted text is sent to this model's service.")
      : t("Add an API profile first. Codex sessions can't write cards."),
      profile => toast(profile ? t("New saves will get an AI card.") : t("AI cards are off. Saved items still go into the Inbox.")));
    // 看图（ADR 0066 第 6 节）：可选，只用于把桌面小助手的截图整理成原文；不绑定时用本机识字的结果。
    const vision = this.field("knowledge.vision", t("Screenshot model"), profiles, byId, (connection) => connection
      ? t("Optional. Desktop helper screenshots you save (with the pointer marked) are sent to {0} to tidy them into text; the model must accept images. Chat-only screenshots aren't sent.", connection)
      : t("Optional. Off: saved screenshots use the text your Mac recognized on its own, and no screenshot leaves this Hub."),
      profile => toast(profile ? t("Saved screenshots will be tidied by this model.") : t("Screenshots stay on this Hub.")));
    clear(this.element, h("div", { class: "set-form-wrap" }, summary, vision));
  }

  private field(purpose: KnowledgeAIBinding["purpose"], label: string, profiles: AIConfiguration["profiles"], byId: Map<string, AIConfiguration["connections"][number]>,
    hint: string | ((connection: string | undefined) => string), saved: (profile: string | null) => void): HTMLElement {
    const bound = this.bindings.find(binding => binding.purpose === purpose);
    const message = h("div", { role: "status" });
    const hintText = (profile: string | undefined) => typeof hint === "string" ? hint
      : hint(profile ? byId.get(profiles.find(item => item.id === profile)?.connection ?? "")?.name : undefined);
    const hintNode = h("span", { class: "field-hint" }, hintText(bound?.profile));
    const select = h("select", { "aria-label": label },
      h("option", { value: "" }, t("Off")),
      ...profiles.map(profile => h("option", { value: profile.id }, `${profile.name} · ${byId.get(profile.connection)?.name ?? ""}`)));
    select.value = bound?.profile ?? "";
    select.addEventListener("change", () => void (async () => {
      select.disabled = true; clear(message);
      try {
        const profile = select.value || null;
        this.bindings = await this.client.saveKnowledgeBinding({ request_id: newRequestId(), purpose, profile, ...(bound ? { expected_revision: bound.revision } : {}) });
        saved(profile);
        this.render();
      } catch (cause) {
        clear(message, failure(isConflict(cause) ? t("This was changed somewhere else. Reload and try again.") : errorText(cause)));
        select.value = bound?.profile ?? "";
        hintNode.textContent = hintText(bound?.profile);
      } finally { select.disabled = false; }
    })());
    return h("div", { class: "knowledge-ai-field" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, label), select, hintNode),
      message);
  }
}

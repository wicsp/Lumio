/**
 * 设置 → AI 模型 →「资料摘要」（ADR 0057，I1-5）：选择给 Inbox 资料写卡片的 Profile（`knowledge.summary` 用途绑定），
 * 以及可选的看图 Profile（`knowledge.vision`，ADR 0066 第 6 节）：用于收藏转录，也允许 DeepSeek Flash 对话看图。
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
    const vision = this.field("knowledge.vision", t("Screenshot model"), profiles, byId, (connection) => connection
      ? t("Saved screenshots are sent to {0} for transcription. When you ask about a screenshot with official DeepSeek Flash, DeepSeek receives the screenshot, recognized text and your question.", connection)
      : t("When off, screenshots stay on this Hub and Lumio uses the text recognized on your device."),
      profile => toast(profile ? t("Screenshot vision is on.") : t("Screenshots stay on this Hub.")));
    const vectors = this.config.profiles.filter(profile => profile.engine === "embedding" && !!byId.get(profile.connection)?.base_url);
    const embedding = this.field("knowledge.embedding", t("Semantic search"), vectors, byId, connection => connection
      ? t("Public note text and search queries are sent to {0} to match by meaning.", connection)
      : t("Full-text search is active. Select an embedding profile to search by meaning."),
      profile => toast(profile ? t("Semantic indexing will start in the background.") : t("Full-text search is active.")));
    clear(this.element, h("div", { class: "set-form-wrap" }, summary, vision, embedding, this.newEmbeddingProfile(vectors) ?? null));
  }

  private newEmbeddingProfile(profiles: AIConfiguration["profiles"]): HTMLElement | undefined {
    const connections = this.config.connections.filter(item => item.base_url && ["dashscope", "doubao", "openai-compatible"].includes(item.kind));
    if (!connections.length) return;
    const connection = h("select", {}, ...connections.map(item => h("option", { value: item.id }, item.name)));
    const model = h("input", { type: "text", required: true, spellcheck: "false", value: connections[0]?.kind === "dashscope" ? "text-embedding-v4" : "" });
    connection.addEventListener("change", () => { model.value = connections.find(item => item.id === connection.value)?.kind === "dashscope" ? "text-embedding-v4" : ""; });
    const button = h("button", { type: "submit", class: "btn" }, t("Enable semantic search"));
    const message = h("div", { role: "status" });
    const form = h("form", { class: "form-stack" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Connection")), connection),
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Embedding model")), model),
      h("p", { class: "field-hint" }, t("Enabling sends public note text and search queries to the selected service.")), button, message);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const name = model.value.trim();
      if (!name || button.disabled) return;
      button.disabled = true;
      void (async () => {
        let profile = profiles.find(row => row.connection === connection.value && row.model === name);
        if (!profile) {
          profile = await this.client.saveAIProfile({ name, model: name, connection: connection.value, engine: "embedding", thinking: "default" });
          this.config = { ...this.config, profiles: [...this.config.profiles, profile] };
        }
        const bound = this.bindings.find(item => item.purpose === "knowledge.embedding");
        this.bindings = await this.client.saveKnowledgeBinding({ request_id: newRequestId(), purpose: "knowledge.embedding", profile: profile.id,
          ...(bound ? { expected_revision: bound.revision } : {}) });
        if (this.active) { this.render(); toast(t("Semantic indexing will start in the background.")); }
      })().catch(cause => { clear(message, failure(errorText(cause))); button.disabled = false; });
    });
    return h("details", { class: "knowledge-ai-field" }, h("summary", {}, t("Add an embedding profile")), form);
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

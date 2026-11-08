/**
 * 设置页「AI 模型」（ADR 0041/0042）：Profile 与连接。
 * 连接是「去哪里调用模型」（API 地址与密钥，或某台执行器上的官方 Codex 登录）；
 * Profile 是「用哪个模型、怎么思考」，助手和执行器共用。密钥只写不读。
 */
import type { AIConfiguration, AIConnection, AIProfile, AIRuntime, NativeSession } from "@lumio/schema";
import { errorText, type Client } from "./api.ts";
import { clear, failure, h, icon, openDialog, toast } from "./dom.ts";
import { t } from "./i18n.ts";

type Group = (title: string, hint: string | undefined, body: HTMLElement, action?: HTMLElement) => HTMLElement;
type Kind = AIConnection["kind"];

export const CONNECTION_KINDS: ReadonlyArray<readonly [Kind, string]> = [
  ["codex-account", "Codex account"], ["deepseek", "DeepSeek API"], ["doubao", "Doubao API"], ["openai-compatible", "Compatible API"],
];
const BASE_URL: Partial<Record<Kind, string>> = { deepseek: "https://api.deepseek.com/v1", doubao: "https://ark.cn-beijing.volces.com/api/v3" };
const DEEPSEEK_EFFORTS = ["low", "high", "max"];

export const kindLabel = (kind: Kind) => t(CONNECTION_KINDS.find(([value]) => value === kind)?.[1] ?? kind);

/** Profile 一行的副标题：引擎 · 模型 · 思考强度。 */
export function profileSummary(profile: AIProfile, connection?: AIConnection): string {
  return [connection ? connection.name : t("Missing connection"), profile.model === "default" ? t("Client default model") : profile.model, profile.effort ?? t("Default effort")].join(" · ");
}

/** 连接一行的副标题：服务 · 位置 · 密钥状态。 */
export function connectionSummary(connection: AIConnection): string {
  const where = connection.kind === "codex-account" ? connection.host : connection.base_url ? new URL(connection.base_url).host : t("Hub");
  const key = connection.kind === "codex-account" ? t("Official sign-in") : connection.api_key_set ? t("Key saved") : t("No key");
  return [kindLabel(connection.kind), where, key].join(" · ");
}

export class AISettings {
  readonly element = h("div", { class: "set-stack" });
  private active = true;
  private config: AIConfiguration = { connections: [], profiles: [] };
  private runtimes: AIRuntime[] = [];
  private sessions: NativeSession[] = [];
  private profileRows = h("div", { class: "set-rows" });
  private connectionRows = h("div", { class: "set-rows" });
  private newProfile = h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => this.editProfile() }, icon("plus"), t("New profile"));
  private newConnection = h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => this.editConnection() }, icon("plus"), t("Add connection"));

  constructor(private client: Client, group: Group) {
    this.element.append(
      group(t("AI profiles"), t("Choose an API or an official Codex session. Profiles share model settings; each conversation keeps its own permissions and history."), this.profileRows, this.newProfile),
      group(t("Connections"), t("Where models are called: an API address and key kept on the Hub, or an official Codex sign-in on a runtime."), this.connectionRows, this.newConnection));
    clear(this.profileRows, h("p", { class: "set-empty" }, t("Loading…")));
    clear(this.connectionRows, h("p", { class: "set-empty" }, t("Loading…")));
    void this.load();
  }

  dispose(): void { this.active = false; }

  private async load(): Promise<void> {
    try {
      const [config, runtimes, sessions] = await Promise.all([this.client.aiConfiguration(), this.client.aiRuntimes(), this.client.nativeSessions()]);
      if (!this.active) return;
      this.config = config; this.runtimes = runtimes; this.sessions = sessions;
      this.render();
    } catch (cause) {
      if (!this.active) return;
      clear(this.profileRows, failure(errorText(cause)));
      clear(this.connectionRows);
    }
  }

  private render(): void {
    const byId = new Map(this.config.connections.map(connection => [connection.id, connection]));
    this.newProfile.disabled = !this.config.connections.length;
    this.newProfile.title = this.config.connections.length ? "" : t("Add a connection first.");
    clear(this.profileRows, ...(this.config.profiles.length ? this.config.profiles.map(profile => this.item(
      profile.engine === "codex" ? "terminal" : "assistant", profile.name, profileSummary(profile, byId.get(profile.connection)), () => this.editProfile(profile)))
      : [h("p", { class: "set-empty" }, this.config.connections.length ? t("No profiles yet. Create one to choose a model for the assistant.") : t("Add a connection first, then create a profile."))]));
    clear(this.connectionRows, ...(this.config.connections.length ? this.config.connections.map(connection => this.item(
      connection.kind === "codex-account" ? "device" : "globe", connection.name, connectionSummary(connection), () => this.editConnection(connection)))
      : [h("p", { class: "set-empty" }, t("No connections yet."))]));
  }

  private item(glyph: string, title: string, sub: string, edit: () => void): HTMLElement {
    return h("button", { type: "button", class: "set-row", onclick: edit, title: t("Edit") },
      h("span", { class: "set-row-badge", "aria-hidden": "true" }, icon(glyph)),
      h("span", { class: "set-label" }, title, h("span", { class: "set-sub" }, sub)),
      icon("chevron", "icon set-row-chevron"));
  }

  private field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint && h("span", { class: "field-hint" }, hint));
  }

  private editConnection(old?: AIConnection): void {
    const name = h("input", { required: true, value: old?.name ?? "", placeholder: t("Connection name"), autocomplete: "off" });
    const kind = h("select", { disabled: !!old }, ...CONNECTION_KINDS.map(([value, label]) => h("option", { value, selected: (old?.kind ?? "deepseek") === value }, t(label))));
    const host = h("select", { disabled: !!old }, ...this.runtimes.map(runtime => h("option", { value: runtime.name, selected: old?.host === runtime.name },
      runtime.online ? runtime.name : `${runtime.name} · ${t("Offline")}`)));
    const base = h("input", { type: "url", value: old?.base_url ?? "", placeholder: "https://…/v1", autocomplete: "off", spellcheck: "false" });
    const key = h("input", { type: "password", autocomplete: "new-password", spellcheck: "false",
      placeholder: old?.api_key_set ? t("Saved. Leave blank to keep it.") : t("Leave blank if the service needs no key") });
    const api = h("div", { class: "form-stack" }, this.field(t("API address"), base), this.field(t("API key"), key, t("Stored only on the Hub, never shown again, and never sent to agents.")));
    const native = h("div", { class: "form-stack" },
      this.runtimes.length ? this.field(t("Runtime"), host) : h("p", { class: "notice" }, t("No runtimes yet. Run lumio runtime add <name> to pair a machine.")),
      h("p", { class: "field-hint" }, t("Sign in through the official Codex client for each isolated conversation. Your personal Codex configuration stays separate.")));
    const sync = () => {
      const codex = kind.value === "codex-account";
      api.hidden = codex; native.hidden = !codex;
      const preset = BASE_URL[kind.value as Kind];
      if (!old && preset && (!base.value || Object.values(BASE_URL).includes(base.value))) base.value = preset;
      base.required = !codex;
    };
    kind.addEventListener("change", sync);
    sync();
    const message = h("div", { role: "status" });
    const save = h("button", { type: "submit", class: "btn btn-primary" }, t("Save"));
    const form = h("form", { class: "form-stack", autocomplete: "off" }, this.field(t("Name"), name), this.field(t("Service"), kind, old ? t("The service and location can't change after creation.") : undefined), native, api, message);
    const dialog = openDialog(old ? t("Edit connection") : t("Add connection"), form, [save]);
    save.setAttribute("form", form.id = `ai-connection-${Date.now()}`);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const codex = kind.value === "codex-account";
      if (codex && !host.value) { clear(message, failure(t("No runtimes yet. Run lumio runtime add <name> to pair a machine."))); return; }
      save.disabled = true;
      void this.client.saveAIConnection({ name: name.value.trim(), kind: kind.value as Kind, host: codex ? host.value : "hub",
        ...(codex ? {} : { base_url: base.value.trim(), ...(key.value ? { api_key: key.value } : {}) }) }, old?.id)
        .then(() => { key.value = ""; dialog.close(); toast(t("Saved.")); void this.load(); })
        .catch((cause: unknown) => { clear(message, failure(errorText(cause))); save.disabled = false; });
    });
  }

  private editProfile(old?: AIProfile): void {
    const connections = this.config.connections;
    const name = h("input", { required: true, value: old?.name ?? "", placeholder: t("Profile name"), autocomplete: "off" });
    const connection = h("select", {}, ...connections.map(c => h("option", { value: c.id, selected: old?.connection === c.id }, `${c.name} · ${kindLabel(c.kind)}`)));
    const model = h("input", { required: true, value: old?.model ?? "", placeholder: t("Model name, as the service spells it"), autocomplete: "off", spellcheck: "false" });
    const thinking = h("select", {}, ...(["default", "off", "on"] as const).map(value => h("option", { value, selected: (old?.thinking ?? "default") === value },
      t(value === "default" ? "Provider default" : value === "on" ? "Thinking on" : "Thinking off"))));
    const effort = h("select", {});
    const modelHint = h("span", { class: "field-hint" });
    const thinkingField = this.field(t("Thinking mode"), thinking);
    const sync = () => {
      const picked = connections.find(c => c.id === connection.value);
      const codex = picked?.kind === "codex-account";
      if (codex && !model.value) model.value = "default";
      modelHint.textContent = codex ? t("For Codex, default uses the client model. Available models and effort levels appear after official sign-in.") : "";
      const known = this.sessions.flatMap(s => s.connection.id === picked?.id ? s.view.models : []).find(m => m.id === model.value);
      const values = picked?.kind === "deepseek" ? DEEPSEEK_EFFORTS : known?.efforts ?? [];
      const wanted = effort.value || old?.effort || "";
      clear(effort, h("option", { value: "" }, t("Default effort")), ...values.map(v => h("option", { value: v, selected: v === wanted }, v)));
      effort.disabled = !values.length;
      thinkingField.hidden = picked?.kind !== "deepseek";
      if (thinkingField.hidden) thinking.value = "default";
    };
    connection.addEventListener("change", sync);
    model.addEventListener("input", sync);
    const modelField = h("label", { class: "field" }, h("span", { class: "field-label" }, t("Model")), model, modelHint);
    sync();
    const message = h("div", { role: "status" });
    const save = h("button", { type: "submit", class: "btn btn-primary" }, t("Save"));
    const form = h("form", { class: "form-stack", autocomplete: "off" },
      this.field(t("Name"), name), this.field(t("Connection"), connection), modelField,
      h("div", { class: "field-row" }, thinkingField, this.field(t("Thinking effort"), effort)), message);
    const dialog = openDialog(old ? t("Edit profile") : t("New profile"), form, [save]);
    save.setAttribute("form", form.id = `ai-profile-${Date.now()}`);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const picked = connections.find(c => c.id === connection.value);
      if (!picked) return;
      save.disabled = true;
      void this.client.saveAIProfile({ name: name.value.trim(), connection: picked.id, engine: picked.kind === "codex-account" ? "codex" : "lumio",
        model: model.value.trim(), thinking: thinking.value as AIProfile["thinking"], ...(effort.value ? { effort: effort.value } : {}) }, old?.id)
        .then(() => { dialog.close(); toast(t("Saved.")); void this.load(); })
        .catch((cause: unknown) => { clear(message, failure(errorText(cause))); save.disabled = false; });
    });
  }
}

/**
 * 设置页「AI 模型」（ADR 0041/0042）：Profile 与连接。
 * 连接是「去哪里调用模型」（API 地址与密钥，或某台执行器上的官方 Codex 登录）；
 * Profile 是「用哪个模型、怎么思考」，助手和执行器共用。密钥只写不读。
 */
import type { AIConfiguration, AIConnection, AIProfile, AIQuotaView, AIRuntime, NativeSession, NativeConnectionView, NativeConnectionAction } from "@lumio/schema";
import { DASHSCOPE_BASE_URLS, TYPESAFE_JEV_BASE_URL } from "@lumio/schema";
import { SpeechSettings } from "./speech-settings.ts";
import { KnowledgeAISettings } from "./knowledge-ai-settings.ts";
import { errorText, type Client } from "./api.ts";
import { clear, failure, h, icon, openDialog, toast } from "./dom.ts";
import { t } from "./i18n.ts";
import { defaultAssistantProfile, saveDefaultAssistantProfile } from "./assistant-profile.ts";
import { newRequestId } from "./commands.ts";
import { usageDetails } from "./ai-usage.ts";

type Group = (title: string, hint: string | undefined, body: HTMLElement, action?: HTMLElement) => HTMLElement;
type Kind = AIConnection["kind"];

export const CONNECTION_KINDS: ReadonlyArray<readonly [Kind, string]> = [
  ["codex-account", "Codex account"], ["deepseek", "DeepSeek API"], ["doubao", "Doubao API"], ["openai-compatible", "Compatible API"],
  ["typesafe-jev", "TypeSafe Jev"], ["claude-code-subscription", "Claude Code subscription"], ["dashscope", "Alibaba Cloud Model Studio (speech)"],
];
const BASE_URL: Partial<Record<Kind, string>> = { deepseek: "https://api.deepseek.com/v1", doubao: "https://ark.cn-beijing.volces.com/api/v3" };
const DEEPSEEK_EFFORTS = ["low", "high", "max"];

export const kindLabel = (kind: Kind) => t(CONNECTION_KINDS.find(([value]) => value === kind)?.[1] ?? kind);

export function profileConnections(connections: readonly AIConnection[]): AIConnection[] {
  return connections.filter(connection => connection.kind !== "typesafe-jev" && connection.kind !== "claude-code-subscription" && connection.kind !== "dashscope");
}

/** Profile 一行的副标题：引擎 · 模型 · 思考强度。 */
export function profileSummary(profile: AIProfile, connection?: AIConnection): string {
  if (profile.engine === "speech") return [connection ? connection.name : t("Missing connection"), profile.model, t("Voice input")].join(" · ");
  return [connection ? connection.name : t("Missing connection"), profile.model === "default" ? t("Client default model") : profile.model, profile.effort ?? t("Default effort")].join(" · ");
}

const authLabel = (view: NativeConnectionView): string =>
  t({ ready: "Signed in", signed_out: "Signed out", authorizing: "Waiting for authorization", offline: "Runtime disconnected", error: "Codex sign-in failed" }[view.state]);

/** 连接一行的副标题：服务、位置与连接级授权或密钥状态。 */
export function connectionSummary(connection: AIConnection, view?: NativeConnectionView, hasLegacyChat = false, usage?: AIQuotaView): string {
  if (connection.kind === "claude-code-subscription") {
    const source = usage ? t(usage.settings.claude_mode === "background" ? "Background refresh" : "Session sampling") : undefined;
    return [kindLabel(connection.kind), connection.host, source].filter(Boolean).join(" · ");
  }
  if (connection.kind === "codex-account") {
    const status = !view ? t("Official sign-in") : view.state === "signed_out" && hasLegacyChat
      ? t("Only existing chats are signed in") : authLabel(view);
    return [kindLabel(connection.kind), connection.host, status].join(" · ");
  }
  const where = connection.base_url ? new URL(connection.base_url).host : t("Hub");
  return [kindLabel(connection.kind), where, connection.api_key_set ? t("Key saved") : t("No key")].join(" · ");
}

export class AISettings {
  readonly element = h("div", { class: "set-stack" });
  private active = true;
  private config: AIConfiguration = { connections: [], profiles: [] };
  private runtimes: AIRuntime[] = [];
  private sessions: NativeSession[] = [];
  private defaultRows = h("div", { class: "set-rows" });
  private auth = new Map<string, NativeConnectionView>();
  private profileRows = h("div", { class: "set-rows" });
  private connectionRows = h("div", { class: "set-rows" });
  private usage = new Map<string, AIQuotaView>();
  private usageVersion = 0;
  private usageTimer?: ReturnType<typeof setInterval>;
  private newProfile = h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => this.editProfile() }, icon("plus"), t("New profile"));
  private newConnection = h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => this.editConnection() }, icon("plus"), t("Add connection"));

  private speech: SpeechSettings;
  private knowledge: KnowledgeAISettings;

  constructor(private client: Client, group: Group) {
    this.speech = new SpeechSettings(client, kind => this.editConnection(undefined, kind), () => void this.load());
    this.knowledge = new KnowledgeAISettings(client);
    this.element.append(
      group(t("Default assistant model"), t("New chats start with this profile. This preference is saved in this browser."), this.defaultRows),
      group(t("AI profiles"), t("Choose an API or an official Codex session. Profiles share model settings; each conversation keeps its own permissions and history."), this.profileRows, this.newProfile),
      group(t("Connections"), t("Manage API connections, runtime sign-ins, and usage monitoring."), this.connectionRows, this.newConnection),
      group(t("Voice input"), t("Dictate into text boxes with the mic button. Audio goes through the Hub to the speech service and isn't stored."), this.speech.element),
      group(t("Inbox cards"), t("When you save a link, AI writes a short card from the original text."), this.knowledge.element));
    for (const rows of [this.defaultRows, this.connectionRows, this.profileRows]) {
      clear(rows, h("p", { class: "set-empty" }, t("Loading…")));
    }
    void this.load();
    this.usageTimer = setInterval(() => void this.loadUsage(), 30_000);
  }

  dispose(): void { this.active = false; clearInterval(this.usageTimer); this.speech.dispose(); this.knowledge.dispose(); }

  private async loadUsage(): Promise<void> {
    const version = ++this.usageVersion;
    try {
      const data = await this.client.aiUsage();
      if (!this.active || version !== this.usageVersion) return;
      const next = new Map(data.map(value => [value.connection, value]));
      if (JSON.stringify([...next]) === JSON.stringify([...this.usage])) return;
      this.usage = next;
      this.renderConnections();
    } catch { /* A Hub without the usage route can still manage connections. */ }
  }

  private updateUsage = (usage: AIQuotaView) => {
    if (!this.active) return;
    this.usageVersion++;
    this.usage.set(usage.connection, usage);
    this.renderConnections();
  };

  private async load(): Promise<void> {
    try {
      const [config, runtimes, sessions] = await Promise.all([this.client.aiConfiguration(), this.client.aiRuntimes(), this.client.nativeSessions()]);
      if (!this.active) return;
      const prior = new Map(this.config.connections.map(connection => [connection.id, connection.revision]));
      for (const connection of config.connections) {
        if (connection.revision !== prior.get(connection.id)) this.usage.delete(connection.id);
      }
      this.config = config; this.runtimes = runtimes; this.sessions = sessions;
      this.render();
      this.speech.update(config);
      this.knowledge.update(config);
      void this.loadUsage();
      await Promise.all(config.connections.filter(c => c.kind === "codex-account").map(async c => {
        try { this.auth.set(c.id, await this.client.nativeConnection(c.id)); } catch { /* Older Hub. */ }
      }));
      if (this.active && this.config === config) this.render();
    } catch (cause) {
      if (!this.active) return;
      clear(this.defaultRows, failure(errorText(cause), () => this.load()));
      clear(this.profileRows);
      clear(this.connectionRows);
    }
  }

  private render(): void {
    this.renderDefault();
    const byId = new Map(this.config.connections.map(connection => [connection.id, connection]));
    const hasChatConnection = profileConnections(this.config.connections).length > 0;
    this.newProfile.disabled = !hasChatConnection;
    this.newProfile.title = hasChatConnection ? "" : t("Add a chat connection first.");
    clear(this.profileRows, ...(this.config.profiles.length ? this.config.profiles.map(profile => this.item(
      profile.engine === "codex" ? "terminal" : profile.engine === "speech" ? "mic" : "assistant", profile.name, profileSummary(profile, byId.get(profile.connection)),
      () => profile.engine === "speech" ? this.speech.rename(profile) : this.editProfile(profile)))
      : [h("p", { class: "set-empty" }, hasChatConnection ? t("No profiles yet. Create one to choose a model for the assistant.") : t("Add a chat connection first, then create a profile."))]));
    this.renderConnections();
  }

  private renderConnections(): void {
    const expanded = new Set([...this.connectionRows.querySelectorAll<HTMLDetailsElement>("details[open]")].map(node => node.dataset.connection));
    const ordered = [...this.config.connections].sort((a, b) => Number(!!this.usage.get(b.id)?.attention) - Number(!!this.usage.get(a.id)?.attention));
    clear(this.connectionRows, ...(ordered.length ? ordered.map(connection => {
      const usage = this.usage.get(connection.id);
      const row = this.item(["codex-account", "claude-code-subscription"].includes(connection.kind) ? "device" : "globe", connection.name,
        connectionSummary(connection, this.auth.get(connection.id), this.legacyChatUses(connection), usage), () => this.editConnection(connection));
      const details = usage && (usage.aliyun_billing_configured !== undefined || ["deepseek", "codex-account", "claude-code-subscription"].includes(connection.kind))
        ? usageDetails(connection, usage, this.client, this.updateUsage) : undefined;
      if (details && expanded.has(connection.id)) details.setAttribute("open", "");
      return h("div", { class: "ai-connection-row" }, row, details);
    })
      : [h("p", { class: "set-empty" }, t("No connections yet."))]));
  }

  private legacyChatUses(connection: AIConnection): boolean {
    return this.sessions.some(session => session.connection.id === connection.id && !session.connection_auth &&
      !["closed", "login_required"].includes(session.view.state) && !!session.view.account);
  }

  private renderDefault(): void {
    const profiles = this.config.profiles.filter(profile => profile.engine !== "speech");
    const owner = profiles[0]?.owner;
    if (!owner) {
      clear(this.defaultRows, h("p", { class: "set-empty" }, t("Add a chat connection and create a profile to choose a default.")));
      return;
    }
    const select = h("select", { "aria-label": t("Default assistant model") },
      h("option", { value: "" }, t("No default profile")),
      ...profiles.map(profile => h("option", { value: profile.id }, profile.name)));
    select.value = defaultAssistantProfile(profiles);
    const message = h("div", { role: "status" });
    select.addEventListener("change", () => {
      if (saveDefaultAssistantProfile(owner, select.value)) {
        clear(message);
        toast(t("Saved."));
      } else {
        select.value = defaultAssistantProfile(profiles);
        clear(message, failure(t("This browser could not save your default profile.")));
      }
    });
    clear(this.defaultRows, h("div", { class: "set-form-wrap" }, select, message));
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

  private editConnection(old?: AIConnection, preset?: Kind): void {
    const name = h("input", { required: true, maxLength: 100, value: old?.name ?? "", placeholder: t("Connection name"), autocomplete: "off" });
    const kind = h("select", { disabled: !!old }, ...CONNECTION_KINDS.map(([value, label]) => h("option", { value, selected: (old?.kind ?? preset ?? "deepseek") === value }, t(label))));
    const host = h("select", { disabled: !!old },
      old && old.host !== "hub" && !this.runtimes.some(runtime => runtime.name === old.host)
        ? h("option", { value: old.host }, `${old.host} · ${t("Offline")}`) : undefined,
      ...this.runtimes.map(runtime => h("option", { value: runtime.name, selected: old?.host === runtime.name },
      runtime.online ? runtime.name : `${runtime.name} · ${t("Offline")}`)));
    const base = h("input", { type: "url", value: old?.base_url ?? "", placeholder: "https://…/v1", autocomplete: "off", spellcheck: "false" });
    const key = h("input", { type: "password", autocomplete: "new-password", spellcheck: "false" });
    const jevHint = h("p", { class: "field-hint" }, t("TypeSafe Jev is for structured decisions and is unavailable in chat profiles."));
    const speechHint = h("p", { class: "field-hint" }, t("For voice input only (Beijing region). Audio and your vocabulary are sent to Alibaba Cloud."));
    const api = h("div", { class: "form-stack" }, this.field(t("API address"), base), this.field(t("API key"), key, t("Stored only on the Hub, never shown again, and never sent to agents.")), jevHint, speechHint);
    const authSection = h("section", { class: "codex-auth", "aria-label": t("Codex sign-in") });
    const samplingHint = h("p", { class: "field-hint" }, t("After saving, open Usage & balance to set up sampling."));
    const native = h("div", { class: "form-stack" },
      (this.runtimes.length || old && old.host !== "hub") ? this.field(t("Runtime"), host) : h("p", { class: "notice" }, t("No runtimes yet. Run lumio runtime add <name> to pair a machine.")),
      authSection, samplingHint);
    let editableAddress = base.value;
    const sync = () => {
      const codex = kind.value === "codex-account";
      const claude = kind.value === "claude-code-subscription";
      const jev = kind.value === "typesafe-jev";
      const speech = kind.value === "dashscope";
      speechHint.hidden = !speech;
      api.hidden = codex || claude; native.hidden = !(codex || claude);
      authSection.hidden = !codex;
      samplingHint.hidden = !claude;
      jevHint.hidden = !jev;
      if (jev || speech) {
        if (!base.readOnly) editableAddress = base.value;
        // 语音首版只支持北京区域（ADR 0055 第 3 节）。
        base.value = jev ? TYPESAFE_JEV_BASE_URL : old?.base_url ?? DASHSCOPE_BASE_URLS.beijing;
      } else if (base.readOnly) {
        base.value = editableAddress;
      }
      base.readOnly = jev || speech;
      const preset = BASE_URL[kind.value as Kind];
      if (!old && preset && (!base.value || Object.values(BASE_URL).includes(base.value))) base.value = preset;
      base.required = !(codex || claude);
      key.required = (jev || speech) && !old?.api_key_set;
      key.placeholder = old?.api_key_set ? t("Saved. Leave blank to keep it.")
        : jev ? t("Enter your TypeSafe API key") : speech ? t("Enter your Model Studio API key") : t("Leave blank if the service needs no key");
    };
    kind.addEventListener("change", () => { key.value = ""; sync(); });
    sync();
    const message = h("div", { role: "status" });
    const save = h("button", { type: "submit", class: "btn btn-primary" });
    const form = h("form", { class: "form-stack", autocomplete: "off" }, this.field(t("Name"), name), this.field(t("Service"), kind, old ? t("The service and location can't change after creation.") : undefined), native, api, message);
    const dialog = openDialog(old?.name ?? t("Add connection"), form, [save]);
    save.setAttribute("form", form.id = `ai-connection-${Date.now()}`);
    let connection = old;
    let view: NativeConnectionView | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;

    const isCodex = () => kind.value === "codex-account";
    const isClaude = () => kind.value === "claude-code-subscription";
    const updateFooter = () => {
      save.textContent = t(isCodex() ? "Finish" : "Save");
      save.disabled = busy || (isCodex() && !old && view?.state !== "ready") || (isClaude() && !host.value);
    };
    const button = (label: string, run: () => void, primary = false) =>
      h("button", { type: "button", class: `btn btn-small${primary ? " btn-primary" : ""}`, onclick: run }, t(label));

    const renderAuth = () => {
      clear(authSection, h("div", { class: "codex-auth-head" },
        h("strong", {}, t("Codex sign-in")),
        h("span", { class: "codex-auth-state", role: "status" }, view ? authLabel(view) : connection ? t("Loading…") : "")));
      if (!connection) {
        authSection.append(h("p", { class: "field-hint" }, t("Sign in once for this connection. Each assistant chat keeps its own history and tools.")),
          button("Sign in with Codex", () => void changeAuth("login"), true));
        return;
      }
      if (view?.state === "authorizing" && view.login_url && view.login_code) {
        authSection.append(h("p", { class: "field-hint" }, t("Enter this one-time code on the official page.")),
          h("div", { class: "button-row" }, h("code", { class: "native-code" }, view.login_code),
            h("a", { href: view.login_url, target: "_blank", rel: "noopener noreferrer", class: "btn btn-primary btn-small" }, t("Open official sign-in")),
            button("Cancel authorization", () => void changeAuth("cancel"))));
      } else if (view?.state === "ready") {
        authSection.append(h("p", { class: "field-hint" }, t("New chats can use this connection.")),
          button("Sign out of Codex", () => void changeAuth("logout")));
      } else if (view?.state === "offline") {
        authSection.append(button("Refresh", () => void changeAuth()));
      } else if (view) {
        if (this.legacyChatUses(connection)) authSection.append(h("p", { class: "field-hint" },
          t("Older chats can still use their own sign-in. Sign in here once to use this connection in new chats.")));
        if (view.error) authSection.append(h("p", { class: "field-hint" }, t(
          view.error === "native.version_unsupported" ? "This runtime has an unsupported Codex version."
            : "Codex authorization failed. Check that device code sign-in is enabled in your ChatGPT security settings and try again.")));
        authSection.append(button("Sign in with Codex", () => void changeAuth("login"), true));
      }
    };

    const changeAuth = async (action?: NativeConnectionAction["action"]) => {
      if (busy || !dialog.open || !isCodex()) return;
      if (!connection && (!form.reportValidity() || !host.value)) return;
      clearTimeout(timer);
      busy = true;
      updateFooter();
      if (action) for (const control of authSection.querySelectorAll("button")) control.disabled = true;
      if (!connection) { kind.disabled = true; host.disabled = true; }
      clear(message);
      try {
        if (!connection) {
          connection = await this.client.saveAIConnection({ name: name.value.trim(), kind: "codex-account", host: host.value });
        }
        if (!dialog.open) return;
        const next = action ? await this.client.nativeConnectionAction(connection.id, { request_id: newRequestId("codex-auth"), action })
          : await this.client.nativeConnection(connection.id);
        this.auth.set(connection.id, next);
        if (!dialog.open) return;
        const changed = !view || view.state !== next.state || view.login_code !== next.login_code || view.login_url !== next.login_url || view.error !== next.error;
        view = next;
        if (changed) renderAuth();
        if (next.state === "authorizing") timer = setTimeout(() => void changeAuth(), 2000);
      } catch (cause) {
        if (dialog.open) {
          renderAuth();
          clear(message, failure(errorText(cause), connection ? () => void changeAuth() : undefined));
        }
      } finally {
        busy = false;
        if (!connection) { kind.disabled = false; host.disabled = false; }
        for (const control of authSection.querySelectorAll("button")) control.disabled = false;
        updateFooter();
        if (!dialog.open && this.active) void this.load();
      }
    };

    kind.addEventListener("change", updateFooter);
    updateFooter();
    if (old?.kind === "codex-account") {
      view = this.auth.get(old.id);
      renderAuth();
      void changeAuth();
    } else renderAuth();
    dialog.addEventListener("close", () => {
      clearTimeout(timer);
      if (isCodex() && connection && this.active) void this.load();
    }, { once: true });

    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (save.disabled) return;
      busy = true;
      updateFooter();
      clear(message);
      try {
        const updatedName = name.value.trim();
        if (!isCodex() || (connection && connection.name !== updatedName)) {
          const runtime = isCodex() || isClaude();
          connection = await this.client.saveAIConnection({ name: updatedName, kind: kind.value as Kind, host: runtime ? host.value : "hub",
            ...(runtime ? {} : { base_url: base.value.trim(), ...(key.value ? { api_key: key.value } : {}) }) }, connection?.id);
        }
        if (isCodex() && connection && view?.state === "ready") {
          const current = await this.client.aiConfiguration();
          const { id, name } = connection;
          if (!current.profiles.some(profile => profile.connection === id)) {
            await this.client.saveAIProfile({ connection: id, name, engine: "codex", model: "default", thinking: "default" });
          }
        }
        key.value = "";
        dialog.close();
        toast(t("Saved."));
        if (!isCodex() && this.active) void this.load();
      } catch (cause) {
        if (dialog.open) clear(message, failure(errorText(cause)));
      } finally {
        busy = false;
        updateFooter();
      }
    });
  }

  private editProfile(old?: AIProfile): void {
    const connections = profileConnections(this.config.connections);
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
      const known = (picked && this.auth.get(picked.id)?.models.length ? this.auth.get(picked.id)!.models :
        this.sessions.flatMap(s => s.connection.id === picked?.id ? s.view.models : [])).find(m => m.id === model.value);
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

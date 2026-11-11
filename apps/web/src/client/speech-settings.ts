/**
 * 设置 → AI 模型 →「语音输入」（ADR 0055，S1-4）：选择语音识别用的 Profile（语音用途绑定）与维护热词表。
 * 语音 Profile 的引擎是 speech，只能配阿里云百炼（dashscope）连接；首版只支持北京区域的 Fun-ASR。
 */
import { DASHSCOPE_BASE_URLS, SPEECH_TERM_LIMITS, SpeechVocabularyUpdate, type AIConfiguration, type AIConnection, type AIProfile, type SpeechBinding, type SpeechVocabulary } from "@lumio/schema";
import { errorText, isConflict, type Client } from "./api.ts";
import { newRequestId } from "./commands.ts";
import { clear, failure, h, openDialog, toast } from "./dom.ts";
import { t } from "./i18n.ts";
import { speechService } from "./speech-input.ts";

export const FUN_ASR_MODEL = "fun-asr-realtime";
const MAX_TERMS = 200;

/** 文本框里一行一个热词；空行忽略，首尾空白去掉。 */
export function parseTerms(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/** 用契约校验；返回第一条给人看的错误，或 undefined。 */
export function vocabularyProblem(terms: string[]): string | undefined {
  if (terms.length > MAX_TERMS) return t("Up to {0} terms.", MAX_TERMS);
  const result = SpeechVocabularyUpdate.safeParse({ request_id: "web-check-vocabulary", expected_revision: 1, terms, include_project_names: false });
  if (result.success) return undefined;
  const issue = result.error.issues[0];
  const index = typeof issue?.path[1] === "number" ? issue.path[1] : undefined;
  if (index === undefined) return issue?.message.includes("重复") ? t("Each term can appear only once.") : t("Check the vocabulary.");
  const term = terms[index] ?? "";
  if (/[^\x20-\x7e]/.test(term)) return t("“{0}” is too long. Terms with Chinese or other non-ASCII characters can have up to {1} characters.", term, SPEECH_TERM_LIMITS.max_non_ascii_chars);
  return t("“{0}” is too long. English terms can have up to {1} words.", term, SPEECH_TERM_LIMITS.max_ascii_words);
}

const asrReady = (profile: AIProfile, connection?: AIConnection) =>
  profile.engine === "speech" && profile.model === FUN_ASR_MODEL && connection?.kind === "dashscope" && connection.base_url === DASHSCOPE_BASE_URLS.beijing;

export class SpeechSettings {
  readonly element = h("div", { class: "speech-settings" });
  private config: AIConfiguration = { connections: [], profiles: [] };
  private bindings: SpeechBinding[] = [];
  private vocabulary?: SpeechVocabulary;
  private loadError?: string;
  private active = true;

  constructor(private client: Client, private addConnection: (kind: "dashscope") => void, private reloadAI: () => void) {
    clear(this.element, h("p", { class: "set-empty" }, t("Loading…")));
  }

  dispose(): void { this.active = false; }

  /** AI 配置加载或变化后调用。 */
  update(config: AIConfiguration): void {
    this.config = config;
    void this.load();
  }

  private get hub() { return speechService()?.session.hub; }

  private async load(): Promise<void> {
    const hub = this.hub;
    if (!hub) { this.render(); return; }
    try {
      const [bindings, vocabulary] = await Promise.all([hub.speechBindings(), hub.speechVocabulary().catch(() => undefined)]);
      if (!this.active) return;
      this.bindings = bindings; this.vocabulary = vocabulary; this.loadError = undefined;
    } catch (cause) {
      if (!this.active) return;
      this.loadError = errorText(cause);
    }
    this.render();
  }

  private render(): void {
    if (this.loadError) { clear(this.element, failure(this.loadError, () => void this.load())); return; }
    const rows: HTMLElement[] = [];
    if (typeof window !== "undefined" && !window.isSecureContext) {
      rows.push(h("p", { class: "notice" }, t("Voice input needs HTTPS or localhost. This page uses plain HTTP, so the mic button is hidden. Set up HTTPS (for example with tailscale serve or a reverse proxy) to use it.")));
    }
    rows.push(this.recognition());
    if (this.vocabulary) rows.push(this.vocabularyEditor(this.vocabulary));
    clear(this.element, ...rows);
  }

  private recognition(): HTMLElement {
    const byId = new Map(this.config.connections.map(connection => [connection.id, connection]));
    const speechConnections = this.config.connections.filter(connection => connection.kind === "dashscope");
    const profiles = this.config.profiles.filter(profile => asrReady(profile, byId.get(profile.connection)));
    const bound = this.bindings.find(binding => binding.purpose === "speech.asr");
    const message = h("div", { role: "status" });
    if (!speechConnections.length) {
      return h("div", { class: "set-form-wrap" },
        h("p", { class: "set-empty" }, t("Add an Alibaba Cloud Model Studio connection (Beijing) to turn on voice input.")),
        h("button", { type: "button", class: "btn btn-small", onclick: () => this.addConnection("dashscope") }, t("Add connection")));
    }
    const withoutProfile = speechConnections.filter(connection => connection.base_url === DASHSCOPE_BASE_URLS.beijing && !profiles.some(profile => profile.connection === connection.id));
    const select = h("select", { "aria-label": t("Speech recognition") },
      h("option", { value: "" }, t("Off")),
      ...profiles.map(profile => h("option", { value: profile.id, selected: bound?.profile === profile.id }, `${profile.name} · ${byId.get(profile.connection)?.name ?? ""}`)),
      ...withoutProfile.map(connection => h("option", { value: `new:${connection.id}` }, t("Fun-ASR with {0} (create)", connection.name))));
    select.value = bound?.profile ?? "";
    select.addEventListener("change", () => void (async () => {
      const hub = this.hub;
      if (!hub) return;
      select.disabled = true; clear(message);
      try {
        let profile: string | null = select.value || null;
        if (profile?.startsWith("new:")) {
          const created = await this.client.saveAIProfile({ name: "Fun-ASR", connection: profile.slice(4), engine: "speech", model: FUN_ASR_MODEL, thinking: "default" });
          profile = created.id;
        }
        await hub.saveSpeechBinding({ request_id: newRequestId(), purpose: "speech.asr", profile, ...(bound ? { expected_revision: bound.revision } : {}) });
        toast(profile ? t("Voice input is on.") : t("Voice input is off."));
        await speechService()?.refresh();
        this.reloadAI();
      } catch (cause) {
        clear(message, failure(isConflict(cause) ? t("This was changed somewhere else. Reload and try again.") : errorText(cause)));
        select.value = bound?.profile ?? "";
      } finally { select.disabled = false; }
    })());
    return h("div", { class: "set-form-wrap" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Speech recognition")), select,
        h("span", { class: "field-hint" }, t("Audio is sent to Alibaba Cloud Model Studio (Beijing) for recognition. Lumio doesn't store audio."))),
      message);
  }

  private vocabularyEditor(vocabulary: SpeechVocabulary): HTMLElement {
    const area = h("textarea", { rows: "6", spellcheck: "false", "aria-label": t("Vocabulary"), placeholder: t("One term per line, such as project names, tools and citekeys") });
    area.value = vocabulary.terms.join("\n");
    const projects = h("input", { type: "checkbox", checked: vocabulary.include_project_names });
    const count = h("span", { class: "field-hint" });
    const message = h("div", { role: "status" });
    const save = h("button", { type: "button", class: "btn btn-small" }, t("Save vocabulary"));
    const check = () => {
      const terms = parseTerms(area.value);
      const problem = vocabularyProblem(terms);
      count.textContent = t("{0} of {1} terms", terms.length, MAX_TERMS);
      clear(message, problem ? failure(problem) : null);
      save.disabled = !!problem;
    };
    area.addEventListener("input", check);
    check();
    save.addEventListener("click", () => void (async () => {
      const hub = this.hub;
      if (!hub) return;
      const terms = parseTerms(area.value);
      if (vocabularyProblem(terms)) return;
      save.disabled = true;
      try {
        this.vocabulary = await hub.saveSpeechVocabulary({ request_id: newRequestId(), expected_revision: vocabulary.revision, terms, include_project_names: projects.checked });
        toast(t("Vocabulary saved. It syncs to the speech service before the next recording."));
        this.render();
      } catch (cause) {
        clear(message, failure(isConflict(cause) ? t("The vocabulary changed somewhere else. Reload and try again.") : errorText(cause)));
        save.disabled = false;
      }
    })());
    const sync = vocabulary.sync.map(state => {
      const connection = this.config.connections.find(value => value.id === state.connection);
      const label = t(state.state === "synced" ? "Synced" : state.state === "pending" ? "Syncing" : "Sync failed");
      return `${connection?.name ?? state.connection} · ${label}`;
    });
    return h("div", { class: "set-form-wrap form-stack" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Vocabulary")), area, count,
        h("span", { class: "field-hint" }, t("Helps recognize names and terms. The list is sent to and stored by the speech service, so don't include anything private."))),
      h("label", { class: "check" }, projects, t("Also include project names (private projects are skipped)")),
      sync.length ? h("p", { class: "field-hint" }, t("Sync status: {0}", sync.join("; "))) : null,
      h("div", { class: "speech-actions" }, save, message));
  }

  /** 改语音 Profile 的名称（模型与连接固定）。 */
  rename(profile: AIProfile): void {
    const name = h("input", { required: true, maxLength: 100, value: profile.name, autocomplete: "off" });
    const message = h("div", { role: "status" });
    const save = h("button", { type: "submit", class: "btn btn-primary" }, t("Save"));
    const form = h("form", { class: "form-stack", autocomplete: "off" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Name")), name,
        h("span", { class: "field-hint" }, t("Speech profiles use {0} and are only for voice input.", profile.model))), message);
    const dialog = openDialog(t("Edit profile"), form, [save]);
    save.setAttribute("form", form.id = `speech-profile-${Date.now()}`);
    form.addEventListener("submit", event => {
      event.preventDefault();
      save.disabled = true;
      void this.client.saveAIProfile({ name: name.value.trim(), connection: profile.connection, engine: "speech", model: profile.model, thinking: "default" }, profile.id)
        .then(() => { dialog.close(); toast(t("Saved.")); this.reloadAI(); })
        .catch((cause: unknown) => { clear(message, failure(errorText(cause))); save.disabled = false; });
    });
  }
}

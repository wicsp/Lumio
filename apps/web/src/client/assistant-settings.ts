import {AISettings} from "./ai-settings.ts";
/**
 * 设置页「助手模型」（ADR 0027 第 4 节、0029 第 7 节）。
 * 密钥只写不读；保存前默认先测试连接，失败不保存；保存后 Hub 立即使用，不需要重启。
 * 地址预设只是填写帮助，不预设默认供应商或模型（ADR 0025 第 7 节）。
 */
import { ApiClientError } from "@lumio/api-client";
import type { AssistantConfigView } from "@lumio/schema";
import { errorText, type HubExtras } from "./api.ts";
import { clear, failure, h, icon, toast } from "./dom.ts";
import { t } from "./i18n.ts";
import { PROVIDER_PRESETS } from "./providers.ts";

export { PROVIDER_PRESETS };


const PROBLEM: Record<string, string> = {
  "assistant-config-address": "Couldn't reach a compatible API at this address. Check the URL; it should end at the API base (often /v1).",
  "assistant-config-auth": "The service rejected the API key.",
  "assistant-config-model": "The service doesn't accept this model name.",
  "assistant-config-response": "The service answered, but not in the expected Chat Completions format.",
  "assistant-config-timeout": "The service didn't answer in time.",
};

export function configProblem(cause: unknown): string {
  if (cause instanceof ApiClientError && cause.reason && PROBLEM[cause.reason]) return t(PROBLEM[cause.reason]!);
  return errorText(cause);
}

export class AssistantSettings {
  readonly element = h("div", { class: "set-rows" });
  private active = true;
  private legacy=h("div",{class:"set-rows"});
  private profiles?:AISettings;

  constructor(private hub: HubExtras) {
    if(hub.ai){this.profiles=new AISettings(hub.ai);this.element.append(this.profiles.element,h("details",{},h("summary",{},t("Existing API configuration")),this.legacy));}
    else this.element.append(this.legacy);
    clear(this.legacy, h("p", { class: "set-empty" }, t("Loading…")));
    void this.load();
  }
  dispose(): void { this.active = false;this.profiles?.dispose(); }

  private async load(): Promise<void> {
    try {
      const view = await this.hub.assistantConfig();
      if (this.active) this.render(view);
    } catch (cause) {
      if (!this.active) return;
      const missing = cause instanceof ApiClientError && cause.code === "NOT_FOUND";
      clear(this.legacy, h("p", { class: "set-empty" }, missing
        ? t("This Hub can't be configured from the browser yet. Run lumio hub assistant setup on the Hub machine.")
        : errorText(cause)));
    }
  }

  private render(view: AssistantConfigView): void {
    const configured = Boolean(view.base_url && view.model);
    const summary = h("div", { class: "set-row" },
      h("span", { class: `connection-dot${configured ? "" : " off"}` }),
      h("span", { class: "set-label" }, configured ? view.model! : t("Not configured"),
        configured ? h("span", { class: "set-sub" }, view.base_url!) : h("span", { class: "set-sub" }, t("Chat is unavailable until a model is set."))),
      h("span", { class: "set-value muted" }, view.api_key_set ? t("Key saved") : t("No key")));
    if (!view.managed) {
      clear(this.legacy, summary, h("p", { class: "set-empty" }, t("This configuration comes from the Hub's service environment, so it can't be changed here.")));
      return;
    }

    const url = h("input", { type: "url", name: "base_url", required: true, value: view.base_url ?? "", placeholder: "https://…/v1", autocomplete: "off", spellcheck: "false" });
    const model = h("input", { type: "text", name: "model", required: true, value: view.model ?? "", placeholder: t("Model name, as the service spells it"), autocomplete: "off", spellcheck: "false" });
    const key = h("input", { type: "password", name: "api_key", value: "", autocomplete: "new-password", spellcheck: "false",
      placeholder: view.api_key_set ? t("Saved. Leave blank to keep it.") : t("Leave blank if the service needs no key") });
    const presets = h("div", { class: "preset-row" }, ...PROVIDER_PRESETS.map(([name, base]) => {
      const chip = h("button", { type: "button", class: "preset", "aria-pressed": String(url.value === base), onclick: () => {
        url.value = base; url.dispatchEvent(new Event("input")); model.focus();
      } }, name);
      return chip;
    }));
    url.addEventListener("input", () => presets.querySelectorAll<HTMLButtonElement>(".preset").forEach((chip, i) => chip.setAttribute("aria-pressed", String(url.value === PROVIDER_PRESETS[i]![1]))));

    const message = h("div", { role: "status" });
    const save = h("button", { type: "submit", class: "btn btn-primary btn-small" }, icon("check"), t("Test and save"));
    const skip = h("button", { type: "button", class: "btn btn-quiet btn-small", title: t("Save without contacting the service first") }, t("Save without testing"));
    const remove = configured ? h("button", { type: "button", class: "btn btn-quiet btn-small set-danger" }, t("Remove")) : null;
    const form = h("form", { class: "set-form", autocomplete: "off" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("API address")), url, presets),
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Model")), model),
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("API key")), key,
        h("span", { class: "field-hint" }, t("Stored only on the Hub, never shown again, and never sent to agents."))),
      message,
      h("div", { class: "button-row" }, save, skip, h("span", { class: "bar-spacer" }), remove));

    let busy = false;
    const submit = async (check: boolean) => {
      if (busy || !form.reportValidity()) return;
      busy = true; save.disabled = skip.disabled = true; if (remove) remove.disabled = true;
      clear(message, h("p", { class: "muted" }, check ? t("Testing the connection…") : t("Saving…")));
      try {
        const saved = await this.hub.saveAssistantConfig({ base_url: url.value.trim(), model: model.value.trim(),
          ...(key.value ? { api_key: key.value } : {}), check });
        key.value = "";
        if (!this.active) return;
        toast(check ? t("Connection works. Saved.") : t("Saved."));
        this.render(saved);
      } catch (cause) {
        if (this.active) clear(message, failure(configProblem(cause)));
      } finally { busy = false; save.disabled = skip.disabled = false; if (remove) remove.disabled = false; }
    };
    form.addEventListener("submit", event => { event.preventDefault(); void submit(true); });
    skip.addEventListener("click", () => void submit(false));
    remove?.addEventListener("click", async () => {
      if (busy || !confirm(t("Remove the assistant model? Chat stops working until a model is set again."))) return;
      busy = true;
      try { const cleared = await this.hub.clearAssistantConfig(); if (this.active) { toast(t("Removed.")); this.render(cleared); } }
      catch (cause) { if (this.active) clear(message, failure(errorText(cause))); }
      finally { busy = false; }
    });
    clear(this.legacy, summary, h("div", { class: "set-form-wrap" }, form));
  }
}

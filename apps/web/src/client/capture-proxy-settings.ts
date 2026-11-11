import { CAPTURE_PROXY_LIMITS, type CaptureProxySettings, type CaptureProxyUpdate } from "@lumio/schema";
import { errorText, isConflict, type Client } from "./api.ts";
import { clear, failure, h, loading } from "./dom.ts";
import { t } from "./i18n.ts";

export function captureProxySettings(client: Pick<Client, "captureProxySettings" | "saveCaptureProxySettings">) {
  const element = h("div");
  let active = true;

  async function load() {
    clear(element, loading());
    try {
      const settings = await client.captureProxySettings();
      if (active) render(settings);
    } catch (error) {
      if (active) clear(element, failure(errorText(error), () => void load()));
    }
  }

  function render(settings: CaptureProxySettings, saved = false) {
    const custom = settings.mode === "custom" ? settings : undefined;
    const mode = h("select", {},
      h("option", { value: "environment", selected: !custom }, t("Follow the Hub service environment")),
      h("option", { value: "custom", selected: !!custom }, t("Use a custom proxy")));
    const address = h("input", {
      type: "password", autocomplete: "new-password", spellcheck: "false", maxlength: CAPTURE_PROXY_LIMITS.address,
      placeholder: custom?.proxy_origin ?? "http://127.0.0.1:7890",
    });
    const bypass = h("input", { type: "text", value: custom?.no_proxy ?? "", autocomplete: "off",
      spellcheck: "false", maxlength: CAPTURE_PROXY_LIMITS.bypass });
    const field = (label: string, control: HTMLElement, hint?: string) =>
      h("label", { class: "field" }, h("span", { class: "field-label" }, label), control,
        hint && h("span", { class: "field-hint" }, hint));
    const customFields = h("div", { class: "form-stack" },
      field(t("Proxy address"), address, custom ? t("Current address is {0}. Leave blank to keep it.", custom.proxy_origin) : undefined),
      field("NO_PROXY", bypass, t("Comma-separated hosts to connect to directly.")));
    const status = h("p", { class: "field-hint", role: "status" }, saved ? t("Capture proxy saved. It applies to the next fetch.") : "");
    const error = h("div");
    const save = h("button", { type: "submit", class: "btn btn-small" }, t("Save"));
    const form = h("form", { class: "set-form-wrap form-stack", autocomplete: "off" },
      field(t("Proxy mode"), mode), customFields, h("div", {}, save), status, error);
    const sync = () => {
      customFields.hidden = mode.value !== "custom";
      address.required = !customFields.hidden && !custom;
      if (customFields.hidden) address.value = "";
    };
    sync();
    mode.addEventListener("change", sync);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (save.disabled || !active) return;
      const input: CaptureProxyUpdate = mode.value === "custom"
        ? { mode: "custom", expected_revision: settings.revision, no_proxy: bypass.value,
          ...(address.value.trim() ? { proxy_url: address.value.trim() } : {}) }
        : { mode: "environment", expected_revision: settings.revision };
      for (const control of [mode, address, bypass, save]) control.disabled = true;
      status.textContent = t("Saving…");
      clear(error);
      try {
        const updated = await client.saveCaptureProxySettings(input);
        address.value = "";
        if (active) render(updated, true);
      } catch (cause) {
        if (!active) return;
        status.textContent = "";
        clear(error, h("p", { class: "field-hint", role: "alert" }, errorText(cause)));
        if (isConflict(cause)) {
          error.append(h("button", { type: "button", class: "btn btn-small", onclick: () => void load() }, t("Reload proxy settings")));
        }
        for (const control of [mode, address, bypass, save]) control.disabled = false;
      }
    });
    clear(element, form);
  }

  void load();
  return { element, dispose() { active = false; clear(element); } };
}

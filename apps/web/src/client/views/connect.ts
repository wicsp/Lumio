/** Pairing is single-use; keep an unverified candidate only in this view's memory. */
import { createSession, errorText, LoginError } from "../api.ts";
import { h, icon } from "../dom.ts";
import { pickLang, pickTheme, themeIcon } from "../settings.ts";
import { lang, t } from "../i18n.ts";

export class ConnectView {
  constructor(root: HTMLElement, onToken: (token: string, remember: boolean) => Promise<void>, notice?: string, retry?: () => void) {
    const message = h("p", { class: "state state-error", role: "alert", hidden: !notice }, notice ?? "");
    const show = (text: string) => { message.textContent = text; message.hidden = false; };
    const remember = h("input", { type: "checkbox", name: "remember-device" });
    let pending = false, candidate: string | undefined;
    const retrySaved = retry ? h("button", { type: "button", class: "btn", onclick: () => { if (!pending) retry(); } }, t("Retry saved session")) : undefined;
    const retryVerification = h("button", { type: "button", class: "btn", hidden: true, onclick: async () => {
      if (pending || !candidate) return; busy(true); try { await verify(candidate); } finally { busy(false); }
    } }, t("Retry verification"));
    const busy = (on: boolean) => {
      pending = on;
      for (const form of [codeForm, tokenForm]) form.querySelectorAll("button, input").forEach(el => ((el as HTMLInputElement).disabled = on));
      remember.disabled = retryVerification.disabled = on; if (retrySaved) retrySaved.disabled = on;
    };
    const verify = async (value: string) => {
      try { await onToken(value, remember.checked); candidate = undefined; retryVerification.hidden = true; }
      catch (error) {
        if (error instanceof LoginError && error.retryable) {
          candidate = value; retryVerification.hidden = false;
          show(t("{0} Click Retry verification — you don't need a new pairing code.", error.message));
        } else { candidate = undefined; retryVerification.hidden = true; show(error instanceof Error ? error.message : errorText(error)); }
      }
    };
    const start = () => { candidate = undefined; retryVerification.hidden = true; message.hidden = true; busy(true); };
    const code = h("input", { name: "code", class: "code-input", autocomplete: "one-time-code", required: true, spellcheck: "false", placeholder: t("Pairing code"), "aria-label": t("Pairing code") });
    const codeForm = h("form", { class: "connect-form" }, code,
      h("p", { class: "field-hint" }, t("Run lumio login-code --name web on the Hub machine. Valid for 10 minutes, single use.")),
      h("button", { type: "submit", class: "btn btn-primary" }, t("Connect")));
    codeForm.addEventListener("submit", async event => {
      event.preventDefault(); if (pending) return; start();
      const session = createSession(undefined, () => {});
      try { const joined = await session.client.clientJoin(code.value.trim()); code.value = ""; await verify(joined.token); }
      catch (error) { show(error instanceof Error && !("code" in error) ? error.message : errorText(error)); }
      finally { session.close(); busy(false); }
    });
    const token = h("input", { name: "token", type: "password", autocomplete: "off", required: true, spellcheck: "false", placeholder: t("Paste a human access token"), "aria-label": t("Access token") });
    const tokenForm = h("form", { class: "connect-form" }, token, h("button", { type: "submit", class: "btn" }, t("Connect with token")));
    tokenForm.addEventListener("submit", async event => {
      event.preventDefault(); if (pending) return; start();
      try { const value = token.value.trim(); token.value = ""; await verify(value); } finally { busy(false); }
    });
    root.append(h("main", { class: "connect" },
      h("aside", { class: "connect-art", "aria-hidden": "true" },
        h("h2", {}, t("Your knowledge, tasks and agents on one desk.")),
        h("p", {}, t("Lumio connects to your own Hub. Your data stays on your machine; the browser is just a window."))),
      h("section", { class: "connect-panel" }, h("div", { class: "connect-card", "aria-labelledby": "connect-title" },
        h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("span", {}, "Lumio"),
          h("span", { class: "foot-tools" },
            h("button", { type: "button", class: "icon-btn", title: t("Theme"), "aria-label": t("Theme"), onclick: (event: Event) => pickTheme(event.currentTarget as HTMLElement) }, themeIcon()),
            h("button", { type: "button", class: "icon-btn lang-btn", title: t("Language"), "aria-label": t("Language"), onclick: (event: Event) => pickLang(event.currentTarget as HTMLElement) }, icon("globe"), lang() === "zh" ? "中文" : "English"))),
        h("h1", { id: "connect-title" }, t("Connect to your Hub")),
        message, retrySaved, retryVerification,
        codeForm,
        h("label", { class: "check" }, remember, t("Stay signed in on this device")),
        h("p", { class: "field-hint" }, t("You won't need to pair again after closing the browser. Only use this on your own device.")),
        h("div", { class: "or" }, t("or")),
        h("details", {}, h("summary", {}, t("Use an existing access token")), tokenForm)))));
    code.focus();
  }
}

/** Pairing is single-use; keep an unverified candidate only in this view's memory. */
import { createSession, errorText, LoginError } from "../api.ts";
import { h } from "../dom.ts";

export class ConnectView {
  constructor(root: HTMLElement, onToken: (token: string, remember: boolean) => Promise<void>, notice?: string, retry?: () => void) {
    const message = h("p", { class: "state state-error", role: "alert", hidden: !notice }, notice ?? "");
    const show = (text: string) => { message.textContent = text; message.hidden = false; };
    const remember = h("input", { type: "checkbox", name: "remember-device" });
    let pending = false, candidate: string | undefined;
    const retrySaved = retry ? h("button", { type: "button", class: "btn", onclick: () => { if (!pending) retry(); } }, "重试已保存的连接") : undefined;
    const retryVerification = h("button", { type: "button", class: "btn", hidden: true, onclick: async () => {
      if (pending || !candidate) return; busy(true); try { await verify(candidate); } finally { busy(false); }
    } }, "重试验证");
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
          show(`${error.message}。可点「重试验证」，不用重新获取配对码。`);
        } else { candidate = undefined; retryVerification.hidden = true; show(error instanceof Error ? error.message : errorText(error)); }
      }
    };
    const start = () => { candidate = undefined; retryVerification.hidden = true; message.hidden = true; busy(true); };
    const code = h("input", { name: "code", class: "code-input", autocomplete: "one-time-code", required: true, spellcheck: "false", placeholder: "配对码", "aria-label": "配对码" });
    const codeForm = h("form", { class: "connect-form" }, code,
      h("p", { class: "field-hint" }, "在 Hub 所在的机器上运行 lumio login-code --name web 获取。10 分钟内有效，只能用一次。"),
      h("button", { type: "submit", class: "btn btn-primary" }, "连接"));
    codeForm.addEventListener("submit", async event => {
      event.preventDefault(); if (pending) return; start();
      const session = createSession(undefined, () => {});
      try { const joined = await session.client.clientJoin(code.value.trim()); code.value = ""; await verify(joined.token); }
      catch (error) { show(error instanceof Error && !("code" in error) ? error.message : errorText(error)); }
      finally { session.close(); busy(false); }
    });
    const token = h("input", { name: "token", type: "password", autocomplete: "off", required: true, spellcheck: "false", placeholder: "粘贴人类访问令牌", "aria-label": "访问令牌" });
    const tokenForm = h("form", { class: "connect-form" }, token, h("button", { type: "submit", class: "btn" }, "用令牌连接"));
    tokenForm.addEventListener("submit", async event => {
      event.preventDefault(); if (pending) return; start();
      try { const value = token.value.trim(); token.value = ""; await verify(value); } finally { busy(false); }
    });
    root.append(h("main", { class: "connect" },
      h("aside", { class: "connect-art", "aria-hidden": "true" },
        h("h2", {}, "知识、任务与 agent，放在同一张桌面上。"),
        h("p", {}, "Lumio 连接你自己的 Hub。数据留在你的机器上，浏览器只是一扇窗。")),
      h("section", { class: "connect-panel" }, h("div", { class: "connect-card", "aria-labelledby": "connect-title" },
        h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("span", {}, "Lumio")),
        h("h1", { id: "connect-title" }, "连接到你的 Hub"),
        message, retrySaved, retryVerification,
        codeForm,
        h("label", { class: "check" }, remember, "在这台设备上保持登录"),
        h("p", { class: "field-hint" }, "勾选后关闭浏览器再打开也不用重新配对。只在自己的设备上勾选。"),
        h("div", { class: "or" }, "或"),
        h("details", {}, h("summary", {}, "使用已有的访问令牌"), tokenForm)))));
    code.focus();
  }
}

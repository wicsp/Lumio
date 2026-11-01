/** Pairing is single-use; keep an unverified candidate only in this view's memory. */
import { createSession, errorText, LoginError } from "../api.ts";
import { field, h, icon } from "../dom.ts";

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
    const code = h("input", { name: "code", autocomplete: "one-time-code", required: true, spellcheck: "false" });
    const codeForm = h("form", { class: "connect-form" }, field("配对码", code, "在 Hub 所在机器运行 lumio login-code --name web 获取，10 分钟内有效，只能用一次"),
      h("button", { type: "submit", class: "btn btn-primary" }, "用配对码连接"));
    codeForm.addEventListener("submit", async event => {
      event.preventDefault(); if (pending) return; start();
      const session = createSession(undefined, () => {});
      try { const joined = await session.client.clientJoin(code.value.trim()); code.value = ""; await verify(joined.token); }
      catch (error) { show(error instanceof Error && !("code" in error) ? error.message : errorText(error)); }
      finally { session.close(); busy(false); }
    });
    const token = h("input", { name: "token", type: "password", autocomplete: "off", required: true, spellcheck: "false" });
    const tokenForm = h("form", { class: "connect-form" }, field("访问令牌", token, "已有的人类访问令牌"),
      h("button", { type: "submit", class: "btn" }, "用令牌连接"));
    tokenForm.addEventListener("submit", async event => {
      event.preventDefault(); if (pending) return; start();
      try { const value = token.value.trim(); token.value = ""; await verify(value); } finally { busy(false); }
    });
    root.append(h("main", { class: "connect" }, h("section", { class: "connect-card", "aria-labelledby": "connect-title" },
      h("div", { class: "brand" }, h("span", { class: "brand-mark" }, icon("brand")), h("span", {}, "lumio", h("span", { class: "brand-dot" }, "."))),
      h("h1", { id: "connect-title" }, "连接你的研究工作台"), h("p", { class: "muted" }, "让知识有所积累，让每一步有所推进。"),
      message, retrySaved, retryVerification,
      h("div", { class: "remember-choice" }, h("label", { class: "check" }, remember, "记住这台设备"), h("p", { class: "field-hint" }, "勾选后，在这个浏览器中关闭再打开也能保持登录。仅在自己的设备上使用；未勾选时，关闭标签页后需重新配对。")),
      codeForm, h("div", { class: "divider" }, "或"), tokenForm)));
    code.focus();
  }
}

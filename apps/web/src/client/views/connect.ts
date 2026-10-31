/**
 * 连接屏幕（ADR 0026）：一次性配对码（clientJoin）或已有的人类访问令牌。凭据不写入地址栏或存储。
 */
import { createSession, errorText } from "../api.ts";
import { field, h, icon } from "../dom.ts";

export class ConnectView {
  constructor(root: HTMLElement, onToken: (token: string) => Promise<void>, notice?: string) {
    const message = h("p", { class: "state state-error", role: "alert", hidden: !notice }, notice ?? "");
    const show = (text: string) => { message.textContent = text; message.hidden = false; };
    const busy = (form: HTMLFormElement, on: boolean) => form.querySelectorAll("button, input").forEach((el) => ((el as HTMLInputElement).disabled = on));

    const code = h("input", { name: "code", autocomplete: "one-time-code", required: true, spellcheck: "false" });
    const codeForm = h("form", { class: "connect-form" }, field("配对码", code, "在 Hub 所在机器运行 lumio login-code --name web 获取，10 分钟内有效，只能用一次"),
      h("button", { type: "submit", class: "btn btn-primary" }, "用配对码连接"));
    codeForm.addEventListener("submit", async (event) => {
      event.preventDefault(); busy(codeForm, true); message.hidden = true;
      const session = createSession(undefined, () => {});
      try { const joined = await session.client.clientJoin(code.value.trim()); code.value = ""; await onToken(joined.token); }
      catch (error) { show(error instanceof Error && !("code" in error) ? error.message : errorText(error)); busy(codeForm, false); }
      finally { session.close(); }
    });

    const token = h("input", { name: "token", type: "password", autocomplete: "off", required: true, spellcheck: "false" });
    const tokenForm = h("form", { class: "connect-form" }, field("访问令牌", token, "已有的人类令牌；只保存在本页内存中，刷新后需重新输入"),
      h("button", { type: "submit", class: "btn" }, "用令牌连接"));
    tokenForm.addEventListener("submit", async (event) => {
      event.preventDefault(); busy(tokenForm, true); message.hidden = true;
      try { const value = token.value.trim(); token.value = ""; await onToken(value); }
      catch (error) { show(error instanceof Error ? error.message : errorText(error)); busy(tokenForm, false); }
    });

    root.append(h("main", { class: "connect" }, h("section", { class: "connect-card", "aria-labelledby": "connect-title" },
      h("div",{class:"brand"},h("span",{class:"brand-mark"},icon("brand")),h("span",{},"lumio",h("span",{class:"brand-dot"},"."))),h("h1", { id: "connect-title" }, "连接你的研究工作台"), h("p", { class: "muted" }, "让知识有所积累，让每一步有所推进。"),
      message, codeForm, h("div", { class: "divider" }, "或"), tokenForm)));
    code.focus();
  }
}

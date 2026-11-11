/** 设置页：用 Lumio 里生成的配对码，把这个浏览器连接到 Hub（换取一个 human 令牌，只存在本机插件存储里）。 */
import { normalizeHub } from "./page.ts";
import { clearConnection, failureText, h, hubClient, hubPattern, loadConnection, saveConnection, t } from "./shared.ts";

const root = document.getElementById("root")!;

async function render(): Promise<void> {
  const connection = await loadConnection();
  const usage = h("section", {}, h("h2", {}, t("How to use")),
    h("p", { class: "hint" }, t("Click the Lumio button, or press Alt+Shift+S, on the page you're reading. Right-click a link to save just the link.")));
  if (connection) {
    root.replaceChildren(h("h1", {}, "Lumio"),
      h("section", {}, h("p", { class: "lead ok" }, t("Connected to {0}", connection.hub)),
        h("button", { type: "button", class: "btn", onclick: async () => { await clearConnection(); void render(); } }, t("Disconnect"))),
      usage);
    return;
  }
  const hub = h("input", { id: "hub", value: "http://127.0.0.1:7420", spellcheck: "false", autocomplete: "off" });
  const code = h("input", { id: "code", spellcheck: "false", autocomplete: "one-time-code", required: true });
  const message = h("p", { class: "status", role: "status" });
  const submit = h("button", { type: "submit", class: "btn primary" }, t("Connect"));
  const form = h("form", {},
    h("label", { for: "hub" }, t("Hub address")), hub,
    h("label", { for: "code" }, t("Pairing code")), code,
    h("p", { class: "hint" }, t("In Lumio, open Settings → Hub & runtimes → Browser extension and create a pairing code.")),
    submit, message);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const origin = normalizeHub(hub.value);
    if (!origin) { message.replaceChildren(h("span", { class: "error" }, t("Enter a valid address, e.g. http://127.0.0.1:7420"))); return; }
    // permissions.request 必须在用户手势里同步发起，所以不能先 await 别的东西。
    void chrome.permissions.request({ origins: [hubPattern(origin)] }).then(async granted => {
      if (!granted) { message.replaceChildren(h("span", { class: "error" }, t("Chrome needs permission to reach your Hub."))); return; }
      submit.disabled = true; message.replaceChildren(t("Connecting…"));
      try {
        const joined = await hubClient({ hub: origin }).clientJoin(code.value.trim());
        await saveConnection({ hub: origin, token: joined.token, actor: joined.actor });
        void render();
      } catch (error) {
        message.replaceChildren(h("span", { class: "error" }, failureText(error)));
      } finally { submit.disabled = false; }
    });
  });
  root.replaceChildren(h("h1", {}, "Lumio"), h("section", {}, h("h2", {}, t("Connect this browser to Lumio")), form), usage);
}

void render();

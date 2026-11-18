/** 设置页：用 Lumio 里生成的配对码，把这个浏览器连接到 Hub（换取一个 human 令牌，只存在本机插件存储里）。 */
import { normalizeHub } from "./page.ts";
import { clearConnection, failureText, h, hubClient, hubPattern, loadConnection, saveConnection, t } from "./shared.ts";
import { desktopSite, isBridgeSecret, loadDesktopConnection, saveDesktopConnection, sitePermission } from "./desktop-bridge.ts";

const root = document.getElementById("root")!;

async function desktopSettings() {
  const desktop = await loadDesktopConnection();
  const message = h("p", { role: "status", class: "status" });
  const id = h("input", { readonly: true, value: chrome.runtime.id, id: "desktop-extension-id" });
  const section = h("section", {}, h("h2", {}, t("Desktop capture")),
    h("label", { for: id.id }, t("Extension ID")), id,
    h("p", { class: "hint" }, t("Copy this ID into Lumio Capture, then paste the local pairing code here.")));
  if (!desktop) {
    const secret = h("input", { type: "password", autocomplete: "off", required: true, id: "desktop-secret" });
    const form = h("form", {}, h("label", { for: secret.id }, t("Desktop pairing code")), secret,
      h("button", { type: "submit", class: "btn" }, t("Pair desktop capture")));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const value = secret.value.trim();
      if (!isBridgeSecret(value)) { message.textContent = t("Enter the desktop pairing code exactly as shown."); return; }
      void chrome.permissions.request({ origins: ["http://127.0.0.1/*"] }).then(async granted => {
        if (!granted) { message.textContent = t("Allow the extension to connect to Lumio Capture on this Mac."); return; }
        await saveDesktopConnection({ secret: value, origins: [] });
        await render();
      }).catch(() => { message.textContent = t("Could not save desktop capture settings."); });
    });
    section.append(form, message);
    return section;
  }
  const site = h("input", { type: "url", required: true, id: "desktop-site", placeholder: "https://example.com" });
  const form = h("form", {}, h("label", { for: site.id }, t("Website to allow for F18")), site,
    h("button", { type: "submit", class: "btn" }, t("Allow website")));
  form.addEventListener("submit", event => {
    event.preventDefault();
    const origin = desktopSite(site.value);
    if (!origin) { message.textContent = t("Enter an HTTP or HTTPS website."); return; }
    void chrome.permissions.request({ origins: [sitePermission(origin)] }).then(async granted => {
      if (!granted) { message.textContent = t("Website permission was declined."); return; }
      const current = await loadDesktopConnection();
      if (current?.secret !== desktop.secret) return;
      await saveDesktopConnection({ ...current, origins: [...new Set([...current.origins, origin])] });
      await render();
    }).catch(() => { message.textContent = t("Could not save desktop capture settings."); });
  });
  const list = h("ul", {}, ...desktop.origins.map(origin => h("li", {}, origin, " ",
    h("button", { type: "button", class: "btn", onclick: async () => {
      const current = await loadDesktopConnection();
      if (current?.secret !== desktop.secret) return;
      await saveDesktopConnection({ ...current, origins: current.origins.filter(value => value !== origin) });
      await render();
    } }, t("Remove")))));
  section.append(h("p", { class: "hint" }, t("F18 reads the current page only on websites you allow here.")), form, list,
    h("button", { type: "button", class: "btn", onclick: async () => { await saveDesktopConnection(); await render(); } }, t("Forget desktop pairing")), message);
  return section;
}

async function render(): Promise<void> {
  const connection = await loadConnection();
  const desktop = await desktopSettings();
  const usage = h("section", {}, h("h2", {}, t("How to use")),
    h("p", { class: "hint" }, t("Click the Lumio button, or press Alt+Shift+S, on the page you're reading. Right-click a link to save just the link.")));
  if (connection) {
    root.replaceChildren(h("h1", {}, "Lumio"),
      h("section", {}, h("p", { class: "lead ok" }, t("Connected to {0}", connection.hub)),
        h("button", { type: "button", class: "btn", onclick: async () => { await clearConnection(); void render(); } }, t("Disconnect"))),
      usage, desktop);
    return;
  }
  const hub = h("input", { id: "hub", value: "http://127.0.0.1:7420", spellcheck: "false", autocomplete: "off" });
  const code = h("input", { id: "code", spellcheck: "false", autocomplete: "one-time-code", required: true });
  const message = h("p", { class: "status", role: "status" });
  const submit = h("button", { type: "submit", class: "btn primary" }, t("Connect"));
  const form = h("form", {},
    h("label", { for: "hub" }, t("Hub address")), hub,
    h("label", { for: "code" }, t("Pairing code")), code,
    h("p", { class: "hint" }, t("In Lumio, open Settings → Capture → Browser extension and create a pairing code.")),
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
        message.replaceChildren(h("span", { class: "error" }, failureText(error, "pairing")));
      } finally { submit.disabled = false; }
    });
  });
  root.replaceChildren(h("h1", {}, "Lumio"), h("section", {}, h("h2", {}, t("Connect this browser to Lumio")), form), usage, desktop);
}

void render();

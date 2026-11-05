/**
 * 浏览器入口（ADR 0026、0028）：先应用主题与语言，再实例化应用、恢复会话并挂载视图。
 */
import { App } from "./app.ts";
import { lang, t } from "./i18n.ts";
import { applyTheme } from "./theme.ts";

applyTheme();
document.documentElement.lang = lang() === "zh" ? "zh-CN" : "en";
const root = document.getElementById("app");
if (!root) throw new Error(t("Missing #app element"));

const app = new App(root);
app.mount();

// 点开推送通知时，service worker 让已打开的页面跳到对应位置（ADR 0031 第 4 节）。
navigator.serviceWorker?.addEventListener("message", event => {
  const data = event.data as { type?: unknown; path?: unknown } | null;
  if (data?.type === "lumio-navigate" && typeof data.path === "string" && /^#[a-z]+(\/[A-Za-z0-9_-]+)?$/.test(data.path)) location.hash = data.path;
});

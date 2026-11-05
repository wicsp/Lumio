/**
 * Service worker（ADR 0031 第 4 节）：只处理推送、点击跳转与通知打开的页面刷新，不做离线缓存，也不拦截请求。
 * 推送内容只有标题、事件类型与站内路径（#work/task_… 等）；正文按事件类型在本地生成。
 * 以字符串形式提供给 Hub（/sw.js），这样打包与发布流程不变。
 */
export const SERVICE_WORKER = `"use strict";
const TEXT = {
  en: { "turn.answer": "Waiting for your answer", "turn.review": "Ready for your review", "turn.failed": "A round failed", "proposal.pending": "Waiting for your approval" },
  zh: { "turn.answer": "等你回答", "turn.review": "等你验收", "turn.failed": "执行失败", "proposal.pending": "等你批准" },
};
const PATH = /^#[a-z]+(\\/[A-Za-z0-9_-]+)?$/;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const lang = String(self.navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  const kind = typeof data.kind === "string" ? data.kind : "";
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 120) : "Lumio";
  const path = typeof data.path === "string" && PATH.test(data.path) ? data.path : "#overview";
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, { body: TEXT[lang][kind] || "Lumio", tag: path, data: { path }, icon: "/assets/icon-192.png", badge: "/assets/icon-192.png" }),
    // 页面开着时让它马上刷新，不用等定时刷新（R4-8）。
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) if (new URL(client.url).origin === self.location.origin) client.postMessage({ type: "lumio-refresh" });
    }),
  ]));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.path;
  const path = typeof raw === "string" && PATH.test(raw) ? raw : "#overview";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      client.postMessage({ type: "lumio-navigate", path });
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow("/" + path);
  })());
});
`;

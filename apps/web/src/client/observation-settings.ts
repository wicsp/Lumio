import { clear, confirmDialog, h } from "./dom.ts";
import { t } from "./i18n.ts";
import type { UsageObservations } from "./usage-observations.ts";

export function observationSettings(store: UsageObservations) {
  const root = h("div", { class: "set-rows" });
  const status = h("p", { role: "status", class: "muted" });
  const actions = h("div", { class: "detail-actions" });
  const refresh = async () => {
    const [enabled, count] = await Promise.all([store.enabled(), store.count()]);
    status.textContent = t("{0} observations on this browser", count);
    const action = (label: string, run: () => Promise<void>) =>
      h("button", { type: "button", class: "btn btn-small", onclick: async () => {
        try { await run(); await refresh(); } catch { unavailable(); }
      } }, label);
    clear(actions, action(enabled ? t("Pause recording") : t("Resume recording"), () => store.change(!enabled)),
      action(t("Export observations"), async () => {
        const data = await store.export();
        const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
        h("a", { href: url, download: "lumio-usage-observations.json" }).click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }), action(t("Clear observations"), async () => {
        if (await confirmDialog({ title: t("Clear observations on this browser?"), confirm: t("Clear observations"), danger: true })) await store.change("clear");
      }));
  };
  const unavailable = () => { status.textContent = t("Observation storage unavailable."); clear(actions); };
  root.append(h("p", {}, t("The latest 5,000 workbench events stay on this browser. Only page, action, outcome and timing are recorded.")), status, actions);
  return { element: root, refresh: () => { void refresh().catch(unavailable); } };
}

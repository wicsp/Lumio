/**
 * 设置页「通知」（ADR 0031 第 4 节）：在本设备开启推送、发测试通知、选择接收哪些事件、管理其他设备。
 * 只在轮到你回应（回答、验收、失败）和有待批准的提议时推送；通知里只有任务标题，点开跳到对应页面。
 * 推送需要 HTTPS；iPhone / iPad 要 iOS 16.4 以上，并从主屏幕打开 Lumio。
 */
import { NOTIFICATION_KINDS, type NotificationKind, type PushDevice } from "@lumio/schema";
import { ApiClientError } from "@lumio/api-client";
import { errorText, type Client } from "./api.ts";
import { formatTime } from "./commands.ts";
import { clear, confirmDialog, failure, h, icon, toast } from "./dom.ts";
import { ago } from "./format.ts";
import { t, translated } from "./i18n.ts";

const DEVICE_KEY = "lumio.web.push-device";
const KIND_LABELS: Record<NotificationKind, string> = translated({
  "turn.answer": "An agent asks you a question",
  "turn.review": "Work is ready for your review or a checkpoint",
  "turn.failed": "A round fails",
  "proposal.pending": "An agent asks for your approval",
  "ai.quota_low": "An AI connection reaches its usage threshold",
});

/** 不能开启的原因；能开启时返回 undefined。 */
export function pushBlocker(env: { secure: boolean; supported: boolean; ios: boolean; standalone: boolean }): string | undefined {
  if (!env.secure) return t("Notifications need HTTPS. Open Lumio through its https:// address (for example via Tailscale Serve).");
  if (env.ios && !env.standalone) return t("On iPhone and iPad, add Lumio to the Home Screen (Share → Add to Home Screen), open it from there, then turn notifications on. Requires iOS 16.4 or later.");
  if (!env.supported) return t("This browser doesn't support push notifications.");
  return undefined;
}

function environment() {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    secure: window.isSecureContext,
    supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
    ios: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    standalone: window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true,
  };
}

const storedDevice = () => { try { return localStorage.getItem(DEVICE_KEY) ?? undefined; } catch { return undefined; } };
const storeDevice = (id?: string) => { try { if (id) localStorage.setItem(DEVICE_KEY, id); else localStorage.removeItem(DEVICE_KEY); } catch { /* storage may be disabled */ } };

export function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(base64), bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
const sameKey = (key: ArrayBuffer | null | undefined, expected: Uint8Array) => !!key && key.byteLength === expected.length && new Uint8Array(key).every((byte, i) => byte === expected[i]);

export class NotificationSettings {
  readonly element = h("div", { class: "set-rows" });
  private active = true;
  private busy = false;

  constructor(private client: Client) {
    clear(this.element, h("p", { class: "set-empty" }, t("Loading…")));
    void this.load();
  }
  dispose(): void { this.active = false; }

  private async load(): Promise<void> {
    let devices: PushDevice[];
    try { devices = await this.client.pushDevices(); } catch (cause) {
      if (!this.active) return;
      const missing = cause instanceof ApiClientError && cause.code === "NOT_FOUND";
      clear(this.element, h("p", { class: "set-empty" }, missing ? t("This Hub doesn't support notifications yet. Run lumio upgrade.") : errorText(cause)));
      return;
    }
    if (!this.active) return;
    const env = environment(), blocker = pushBlocker(env);
    let mine = devices.find(device => device.id === storedDevice());
    // 浏览器那边的订阅已不存在（清过数据、权限被撤销）时，不把它当成本设备。
    if (mine && !blocker) {
      const registration = await navigator.serviceWorker.getRegistration("/").catch(() => undefined);
      const subscription = await registration?.pushManager.getSubscription().catch(() => null);
      if (!subscription || Notification.permission !== "granted") mine = undefined;
    }
    if (!this.active) return;
    this.render(devices, mine, blocker);
  }

  private render(devices: PushDevice[], mine: PushDevice | undefined, blocker: string | undefined): void {
    const error = h("div", { role: "alert" });
    const rows: Node[] = [];
    const denied = !blocker && Notification.permission === "denied";
    const toggle = h("button", { type: "button", class: `btn btn-small${mine ? "" : " btn-primary"}`, disabled: !!blocker || denied }, icon("bell"), mine ? t("Turn off") : t("Turn on"));
    toggle.addEventListener("click", () => void this.guard(error, async () => { if (mine) await this.disable(mine); else await this.enable(); }));
    rows.push(h("div", { class: "set-row" },
      h("span", { class: "set-label" }, t("This device"),
        h("span", { class: "set-sub" }, blocker ?? (denied ? t("Notifications are blocked for this site. Allow them in the browser or system settings, then reload.") : mine ? t("On · {0}", mine.label) : t("Off")))),
      toggle));
    if (mine) {
      for (const kind of NOTIFICATION_KINDS) {
        const box = h("input", { type: "checkbox", checked: mine.events.includes(kind), "aria-label": KIND_LABELS[kind] });
        box.addEventListener("change", () => void this.guard(error, async () => {
          const events = box.checked ? [...new Set([...mine!.events, kind])] : mine!.events.filter(value => value !== kind);
          mine = await this.client.updatePushDevice(mine!.id, { events });
        }, () => { box.checked = !box.checked; }));
        rows.push(h("label", { class: "set-row set-check-row" }, h("span", { class: "set-label" }, KIND_LABELS[kind]), box));
      }
    }
    if (devices.length) {
      const test = h("button", { type: "button", class: "btn btn-small" }, icon("send"), t("Send a test"));
      test.addEventListener("click", () => void this.guard(error, async () => {
        const result = await this.client.testPush();
        if (result.delivered) toast(t("Test sent. It should arrive in a few seconds."));
        else clear(error, failure(result.error ?? t("The test couldn't be delivered to every device.")));
        void this.load();
      }));
      rows.push(h("div", { class: "set-row" }, h("span", { class: "set-label" }, t("Test notification"), h("span", { class: "set-sub" }, t("Sends to all your devices."))), test));
    }
    for (const device of devices.filter(device => device.id !== mine?.id)) {
      const remove = h("button", { type: "button", class: "btn btn-small btn-quiet" }, t("Remove"));
      remove.addEventListener("click", () => void this.guard(error, async () => {
        if (!(await confirmDialog({ title: t("Stop sending notifications to {0}?", device.label), confirm: t("Remove"), danger: true }))) return;
        await this.client.removePushDevice(device.id);
        void this.load();
      }));
      const status = device.last_error ? t("Last attempt failed: {0}", device.last_error) : device.last_success ? t("Last delivered {0}", ago(device.last_success)) : t("Added {0}", ago(device.created));
      rows.push(h("div", { class: "set-row" }, icon("device"),
        h("span", { class: "set-label" }, device.label, h("span", { class: `set-sub${device.last_error ? " is-error" : ""}`, title: formatTime(device.last_success ?? device.created) }, status)),
        remove));
    }
    clear(this.element, ...rows, error);
  }

  private async guard(error: HTMLElement, work: () => Promise<void>, undo?: () => void): Promise<void> {
    if (this.busy) { undo?.(); return; }
    this.busy = true; clear(error);
    try { await work(); } catch (cause) { undo?.(); clear(error, failure(cause instanceof ApiClientError ? errorText(cause) : t("Couldn't change notifications on this device: {0}", cause instanceof Error ? cause.message : String(cause)))); }
    finally { this.busy = false; }
  }

  /** 必须由点击触发：请求权限、注册 service worker、订阅推送、交给 Hub。 */
  private async enable(): Promise<void> {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { toast(t("Notifications weren't allowed."), "error"); void this.load(); return; }
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const key = base64UrlBytes((await this.client.pushKey()).public_key);
    let subscription = await registration.pushManager.getSubscription();
    // Hub 的签名密钥变了（例如换了 Hub）时，旧订阅不再可用。
    if (subscription && !sameKey(subscription.options.applicationServerKey, key)) { await subscription.unsubscribe(); subscription = null; }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error(t("the browser returned an incomplete subscription"));
    const device = await this.client.subscribePush({ endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
    storeDevice(device.id);
    toast(t("Notifications are on for this device."));
    await this.load();
  }

  private async disable(device: PushDevice): Promise<void> {
    const registration = await navigator.serviceWorker.getRegistration("/");
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
    await this.client.removePushDevice(device.id).catch(cause => { if (!(cause instanceof ApiClientError && cause.code === "NOT_FOUND")) throw cause; });
    storeDevice(undefined);
    toast(t("Notifications are off for this device."));
    await this.load();
  }
}

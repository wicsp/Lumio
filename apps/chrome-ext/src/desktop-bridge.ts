import { GlanceBrowserPage } from "@lumio/schema";
import { snapshotPage } from "./inject.ts";
import { buildCapture, strategyFor } from "./page.ts";

const bridgeKey = "lumio.desktop.capture";
const bridgeAlarm = "lumio.desktop.reconnect";
const endpoint = "ws://127.0.0.1:7421/";

export interface DesktopConnection { secret: string; origins: string[] }

export const isBridgeSecret = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function desktopSite(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.origin;
  } catch { /* Input is not a usable website. */ }
}

export function sitePermission(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export async function loadDesktopConnection(): Promise<DesktopConnection | undefined> {
  const value = (await chrome.storage.local.get(bridgeKey))[bridgeKey] as DesktopConnection | undefined;
  if (!isBridgeSecret(value?.secret) || !Array.isArray(value.origins)) return;
  return { secret: value.secret, origins: value.origins.filter(origin => typeof origin === "string" && desktopSite(origin) === origin) };
}

export function saveDesktopConnection(value?: DesktopConnection) {
  return value ? chrome.storage.local.set({ [bridgeKey]: value }) : chrome.storage.local.remove(bridgeKey);
}

async function proofKey(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const encode = (text: string) => new TextEncoder().encode(text);
type DesktopMessage = { type?: unknown; nonce?: unknown; proof?: unknown; id?: unknown; expires?: unknown };

let socket: WebSocket | undefined;
let generation = 0;
let revision = 0;
let changedAt = 0;

async function snapshot(origins: string[], started: number, expires: number, id: string): Promise<GlanceBrowserPage | undefined> {
  if (Date.now() > expires || changedAt >= started) return;
  const initialRevision = revision;
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true });
  const tab = window.tabs?.find(value => value.active);
  if (!window.focused || window.incognito || !tab?.id || !tab.url || tab.status === "unloaded" ||
    tab.incognito || strategyFor(tab.url) !== "page") return;
  const origin = desktopSite(tab.url);
  if (!origin || !origins.includes(origin) || !await chrome.permissions.contains({ origins: [sitePermission(origin)] })) return;
  if (revision !== initialRevision || Date.now() > expires) return;
  const [captured] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: snapshotPage });
  if (!captured?.result || !captured.documentId || captured.result.url !== tab.url ||
    revision !== initialRevision || Date.now() > expires) return;
  // This targets the original document even if the tab has reloaded at the same URL.
  await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [captured.documentId] }, func: () => true });
  const active = await chrome.tabs.get(tab.id);
  if (!active.active || active.incognito || active.url !== tab.url ||
    !await chrome.permissions.contains({ origins: [sitePermission(origin)] }) ||
    revision !== initialRevision || Date.now() > expires) return;
  const { request } = buildCapture({ url: tab.url, strategy: "page", page: captured.result, requestId: id });
  if (!request.content) return;
  const parsed = GlanceBrowserPage.safeParse({ ...request.content, url: tab.url, title: request.title });
  return parsed.data;
}

async function connect(reset = false): Promise<void> {
  const attempt = ++generation;
  if (reset && socket) { socket.close(); socket = undefined; }
  if (socket) return;
  const settings = await loadDesktopConnection();
  if (generation !== attempt) return;
  if (!settings || !await chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] })) {
    if (generation === attempt) await chrome.alarms.clear(bridgeAlarm);
    return;
  }
  if (generation !== attempt || socket) return;
  if (!await chrome.alarms.get(bridgeAlarm)) await chrome.alarms.create(bridgeAlarm, { periodInMinutes: 1 });
  if (generation !== attempt || socket) return;
  const key = await proofKey(settings.secret);
  if (generation !== attempt || socket) return;
  const ws = new WebSocket(endpoint);
  socket = ws;
  let nonce: string | undefined;
  let authenticated = false;
  let inFlight = false;
  let previous: string | undefined;
  const send = (value: unknown) => { if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const handshake = setTimeout(() => { if (!authenticated) ws.close(); }, 3000);
  const keepalive = setInterval(() => { if (authenticated) send({ type: "keepalive" }); }, 20_000);
  ws.onclose = () => {
    clearTimeout(handshake);
    clearInterval(keepalive);
    if (socket === ws) {
      socket = undefined;
      setTimeout(() => void connect().catch(() => {}), 2500);
    }
  };
  ws.onmessage = event => {
    void (async () => {
      const message = JSON.parse(String(event.data)) as DesktopMessage;
      if (message.type === "challenge" && !nonce && typeof message.nonce === "string" && uuid.test(message.nonce)) {
        nonce = message.nonce;
        const mac = await crypto.subtle.sign("HMAC", key, encode("extension:" + nonce));
        send({ type: "proof", proof: btoa(String.fromCharCode(...new Uint8Array(mac))) });
      } else if (message.type === "ready" && nonce && !authenticated && typeof message.proof === "string" &&
        await crypto.subtle.verify("HMAC", key, Uint8Array.from(atob(message.proof), c => c.charCodeAt(0)), encode("desktop:" + nonce))) {
        authenticated = true;
        clearTimeout(handshake);
        send({ type: "ready" });
      } else if (authenticated && message.type === "capture" && typeof message.id === "string" &&
        uuid.test(message.id) && typeof message.expires === "number" && Number.isSafeInteger(message.expires) &&
        message.expires >= Date.now() && message.expires - Date.now() <= 800 && !inFlight && previous !== message.id) {
        const { id, expires } = message;
        previous = id;
        inFlight = true;
        try {
          const page = await snapshot(settings.origins, expires - 800, expires, id);
          send({ type: "page", id, page });
        } catch { send({ type: "page", id }); }
        finally { inFlight = false; }
      } else ws.close();
    })().catch(() => ws.close());
  };
}

export function startDesktopBridge(): void {
  const bump = () => { revision++; changedAt = Date.now(); };
  chrome.tabs.onActivated.addListener(bump);
  chrome.tabs.onUpdated.addListener((_, change, tab) => {
    if (tab.active && (change.url || change.status === "loading")) bump();
  });
  chrome.windows.onFocusChanged.addListener(bump);
  chrome.storage.onChanged.addListener(changes => {
    if (bridgeKey in changes) void connect(true).catch(() => {});
  });
  chrome.permissions.onRemoved.addListener(() => void connect(true).catch(() => {}));
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === bridgeAlarm) void connect().catch(() => {}); });
  void connect().catch(() => {});
}

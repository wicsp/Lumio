import { expect, mock, test } from "bun:test";
import { isBridgeSecret, loadDesktopSecret, requestDesktopPageAccess, saveDesktopSecret, snapshotDesktopPage } from "../src/desktop-bridge.ts";

async function withChrome(browser: object, run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: browser });
  try { await run(); }
  finally {
    if (original) Object.defineProperty(globalThis, "chrome", original);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
}

test("desktop capture requests one permission for both web schemes and preserves existing pairing", async () => {
  const secret = "1a".repeat(32);
  const request = mock(async () => true);
  const set = mock(async () => {});
  const get = async () => ({ "lumio.desktop.capture": { secret, origins: ["https://old.example"] } });
  await withChrome({ permissions: { request }, storage: { local: { get, set } } }, async () => {
    expect(await loadDesktopSecret()).toBe(secret);
    expect(await requestDesktopPageAccess()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ origins: ["http://*/*", "https://*/*"] });
    await saveDesktopSecret(secret);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ "lumio.desktop.capture": { secret } });
  });
});

test("one browser grant covers public and intranet pages while protected pages and revoked access return no attachment", async () => {
  const tab = { id: 1, active: true, incognito: false, status: "complete", url: "" };
  let granted = true, revokeMidRead = false;
  const contains = mock(async () => granted);
  const executeScript = mock(async () => {
    if (revokeMidRead) granted = false;
    return [{ documentId: "fixture", result: { url: tab.url, title: "Fixture", text: "Example body", html: "<p>Example body</p>" } }];
  });
  await withChrome({
    permissions: { contains }, scripting: { executeScript },
    windows: { getLastFocused: async () => ({ focused: true, tabs: [tab] }) },
    tabs: { get: async () => tab },
  }, async () => {
    const read = () => snapshotDesktopPage(Date.now(), Date.now() + 800, "fixture");
    for (const url of ["https://arxiv.org/abs/2601.00001", "http://127.0.0.1:8123/article"]) {
      tab.url = url;
      expect(await read()).toMatchObject({ url, body: "<p>Example body</p>" });
    }
    expect(contains).toHaveBeenCalledWith({ origins: ["http://*/*", "https://*/*"] });
    const scripts = executeScript.mock.calls.length;
    for (const url of ["chrome://extensions", "file:///fixture", "https://user:placeholder@example.com"]) {
      tab.url = url;
      expect(await read()).toBeUndefined();
    }
    tab.url = "https://another.example/article";
    tab.incognito = true;
    expect(await read()).toBeUndefined();
    tab.incognito = false;
    granted = false;
    expect(await read()).toBeUndefined();
    expect(executeScript).toHaveBeenCalledTimes(scripts);
    granted = true;
    revokeMidRead = true;
    expect(await read()).toBeUndefined();
  });
});

test("the bridge only accepts a full randomly generated pairing-code shape", () => {
  expect(isBridgeSecret("1a".repeat(32))).toBe(true);
  expect(isBridgeSecret("123456")).toBe(false);
  expect(isBridgeSecret("x".repeat(64))).toBe(false);
});

import { expect, test } from "bun:test";
import { desktopSite, isBridgeSecret, sitePermission } from "../src/desktop-bridge.ts";

test("desktop capture requests a browser permission by host and records the exact allowed origin", () => {
  expect(desktopSite("http://127.0.0.1:8123/article")).toBe("http://127.0.0.1:8123");
  expect(sitePermission("http://127.0.0.1:8123")).toBe("http://127.0.0.1/*");
  expect(desktopSite("https://private.example.com/a#b")).toBe("https://private.example.com");
  expect(sitePermission("https://private.example.com")).toBe("https://private.example.com/*");
  expect(desktopSite("https://example:secret@private.example.com")).toBeUndefined();
  expect(desktopSite("chrome://extensions")).toBeUndefined();
  expect(desktopSite("file:///private/tmp/example")).toBeUndefined();
});

test("the bridge only accepts a full randomly generated pairing-code shape", () => {
  expect(isBridgeSecret("1a".repeat(32))).toBe(true);
  expect(isBridgeSecret("123456")).toBe(false);
  expect(isBridgeSecret("x".repeat(64))).toBe(false);
});

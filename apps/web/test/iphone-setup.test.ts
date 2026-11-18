import { describe, expect, test } from "bun:test";
import { encode } from "uqr";
import { IPhoneShortcutPairing } from "@lumio/schema";
import { isIOSDevice, PAIR_SHORTCUT_NAME, pairingUrl, phoneHubDefault, shortcutInstallUrl, unreachableFromPhone } from "../src/client/iphone-setup.ts";

describe("iPhone 快捷指令设置", () => {
  test.each(["zh", "en"] as const)("配对二维码启动“Lumio 收藏”，携带地址、配对码和 %s 界面语言", language => {
    const url = new URL(pairingUrl("http://192.168.1.20:7420//", "abcdefghijklmnopqrstuvwxyz234567", language));
    expect(url.protocol).toBe("shortcuts:");
    expect(url.searchParams.get("name")).toBe(PAIR_SHORTCUT_NAME);
    expect(url.searchParams.get("input")).toBe("text");
    expect(IPhoneShortcutPairing.parse(JSON.parse(url.searchParams.get("text")!))).toEqual({ hub: "http://192.168.1.20:7420", code: "abcdefghijklmnopqrstuvwxyz234567", language: language === "zh" ? "zh-CN" : "en-US" });
  });

  test("配对链接装得进一个二维码", () => {
    const { size } = encode(pairingUrl("https://lumio.example-tailnet.ts.net", "abcdefghijklmnopqrstuvwxyz234567", "zh"), { ecc: "M" });
    expect(size).toBeLessThanOrEqual(73);
  });

  test("安装链接指向仓库里签名的文件，文件名就是快捷指令名", () => {
    const url = shortcutInstallUrl("Lumio 问一问");
    expect(url.startsWith("https://raw.githubusercontent.com/wicsp/Lumio/main/apps/mobile/signed/")).toBe(true);
    expect(decodeURIComponent(url.split("/").at(-1)!)).toBe("Lumio 问一问.shortcut");
  });

  test("识别手机访问不到的地址", () => {
    for (const hub of ["http://127.0.0.1:7420", "http://localhost:7420", "http://[::1]:7420", "http://0.0.0.0:7420", "不是地址"])
      expect(unreachableFromPhone(hub)).toBe(true);
    for (const hub of ["http://192.168.1.20:7420", "https://mac.tail1234.ts.net", "http://macsp.local:7420"])
      expect(unreachableFromPhone(hub)).toBe(false);
  });

  test("识别在 iPhone/iPad 上打开", () => {
    expect(isIOSDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)", "iPhone", 5)).toBe(true);
    expect(isIOSDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5)).toBe(true);
    expect(isIOSDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0)).toBe(false);
    expect(isIOSDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32", 0)).toBe(false);
  });

  test("在手机上打开时，Hub 地址默认用当前页面的地址", () => {
    expect(phoneHubDefault("http://127.0.0.1:7420", "http://192.168.1.20:7420")).toBe("http://192.168.1.20:7420");
    expect(phoneHubDefault("https://mac.tail1234.ts.net", "http://192.168.1.20:7420")).toBe("https://mac.tail1234.ts.net");
    expect(phoneHubDefault("http://127.0.0.1:7420", "http://127.0.0.1:7420")).toBe("http://127.0.0.1:7420");
  });
});

import { describe, expect, test } from "bun:test";
import { encode } from "uqr";
import { PAIR_SHORTCUT_NAME, pairingUrl, shortcutInstallUrl, unreachableFromPhone } from "../src/client/iphone-setup.ts";

describe("iPhone 快捷指令设置", () => {
  test("配对二维码启动“Lumio 收藏”，并把地址和配对码作为文字输入传过去", () => {
    const url = new URL(pairingUrl("http://192.168.1.20:7420//", "abcdefghijklmnopqrstuvwxyz234567"));
    expect(url.protocol).toBe("shortcuts:");
    expect(url.searchParams.get("name")).toBe(PAIR_SHORTCUT_NAME);
    expect(url.searchParams.get("input")).toBe("text");
    expect(JSON.parse(url.searchParams.get("text")!)).toEqual({ hub: "http://192.168.1.20:7420", code: "abcdefghijklmnopqrstuvwxyz234567" });
  });

  test("配对链接装得进一个二维码", () => {
    const { size } = encode(pairingUrl("https://lumio.example-tailnet.ts.net", "abcdefghijklmnopqrstuvwxyz234567"), { ecc: "M" });
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
});

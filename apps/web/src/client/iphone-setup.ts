/**
 * iPhone 捕获快捷指令（apps/mobile）的安装与扫码配对。
 *
 * 安装：二维码指向仓库里签好名的快捷指令文件（所有用户共用，不含地址或令牌）。
 * 配对：二维码内容是 `shortcuts://run-shortcut?name=Lumio%20收藏&input=text&text={"hub":…,"code":…}`，
 * 相机扫码启动"Lumio 收藏"，它用配对码换取令牌并存到 iCloud 云盘，之后两个快捷指令都能用。
 * 快捷指令的名字与 apps/mobile/src/shortcuts.ts 的 PAIR_SHORTCUT_NAME 一致。
 */

export const PAIR_SHORTCUT_NAME = "Lumio 收藏";

const SIGNED_BASE = "https://raw.githubusercontent.com/wicsp/Lumio/main/apps/mobile/signed/";

export const IPHONE_SHORTCUTS = [
  { name: "Lumio 收藏", use: "save" },
  { name: "Lumio 问一问", use: "ask" },
] as const;

export function shortcutInstallUrl(name: string): string {
  return `${SIGNED_BASE}${encodeURIComponent(`${name}.shortcut`)}`;
}

export function pairingUrl(hub: string, code: string): string {
  const payload = JSON.stringify({ hub: hub.trim().replace(/\/+$/, ""), code });
  return `shortcuts://run-shortcut?name=${encodeURIComponent(PAIR_SHORTCUT_NAME)}&input=text&text=${encodeURIComponent(payload)}`;
}

/** 手机访问不到的地址：本机回环、未指定地址或 localhost。 */
export function unreachableFromPhone(hub: string): boolean {
  try {
    const host = new URL(hub).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::" || host === "::1" || host.startsWith("127.");
  } catch { return true; }
}

/** 是否在 iPhone/iPad 上打开（iPadOS 的 Safari 报告为 MacIntel，用触点数区分）。 */
export function isIOSDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

/** 配对用的 Hub 地址默认值：Hub 报告的地址手机访问不到、而当前页面的地址可以时（例如就在手机上打开），用当前页面的地址。 */
export function phoneHubDefault(hubUrl: string, pageOrigin: string): string {
  return unreachableFromPhone(hubUrl) && !unreachableFromPhone(pageOrigin) ? pageOrigin : hubUrl;
}

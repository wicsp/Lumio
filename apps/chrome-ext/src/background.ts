/** 后台：右键菜单"把链接存到 Lumio"（只存链接，由 Hub 下载），结果用工具栏角标提示。 */
import { failureText, hubClient, loadConnection, newRequestId } from "./shared.ts";
import { strategyFor } from "./page.ts";

const MENU = "lumio-save-link";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU, title: chrome.i18n.getMessage("saveLink"), contexts: ["link"] });
});

async function badge(text: string, color: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => void chrome.action.setBadgeText({ text: "" }), 4000);
}

chrome.contextMenus.onClicked.addListener(async info => {
  if (info.menuItemId !== MENU || !info.linkUrl || strategyFor(info.linkUrl) === "unsupported") return;
  const connection = await loadConnection();
  if (!connection) { void chrome.runtime.openOptionsPage(); return; }
  try {
    await hubClient(connection).capture({ request_id: newRequestId("ext-link"), channel: "extension", url: info.linkUrl });
    await badge("✓", "#2f7d4f");
  } catch (error) {
    await badge("!", "#b3261e");
    console.warn("Lumio:", failureText(error));
  }
});

/**
 * 设置页的二级菜单（ADR 0028）：桌面左侧分类、右侧内容；窄屏先列出分类，点进去再看内容。
 * 地址是 `#settings/<分类>`；没有分类时桌面显示「通用」，窄屏显示分类列表。
 */
export type SettingsSection = "general" | "notifications" | "ai" | "devices" | "agents" | "data" | "about";

export interface SettingsSectionInfo {
  key: SettingsSection;
  label: string;
  hint: string;
  icon: string;
}

/** 文案是英文原文，显示时再用 t() 翻译。 */
export const SETTINGS_SECTIONS: readonly SettingsSectionInfo[] = [
  { key: "general", label: "General", hint: "Appearance, language and shortcuts", icon: "user" },
  { key: "notifications", label: "Notifications", hint: "When Lumio may notify you", icon: "bell" },
  { key: "ai", label: "AI models", hint: "Profiles, connections and the assistant model", icon: "assistant" },
  { key: "devices", label: "Hub & runtimes", hint: "This Hub and the machines that run agents", icon: "device" },
  { key: "agents", label: "Connected agents", hint: "Agents outside Lumio that can read and edit", icon: "link" },
  { key: "data", label: "Data", hint: "Recently deleted items", icon: "trash" },
  { key: "about", label: "About", hint: "Version and source code", icon: "help" },
];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "general";

/** 未知或空的分类返回 undefined：窄屏显示分类列表，桌面显示默认分类。 */
export function settingsSection(id: string | undefined): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find(section => section.key === id)?.key;
}

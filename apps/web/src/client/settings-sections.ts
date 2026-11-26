/**
 * 设置页的二级菜单（ADR 0028）：桌面左侧分类、右侧内容；窄屏先列出分类，点进去再看内容。
 * 地址是 `#settings/<分类>`；没有分类时桌面显示「通用」，窄屏显示分类列表。
 * 分类按用途分成几组显示（个人 / AI 与执行 / 资料），组名只是导航里的小标题，不进地址。
 */
export type SettingsSection = "general" | "controls" | "notifications" | "ai" | "execution" | "devices" | "agents" | "capture" | "data" | "about";

export interface SettingsSectionInfo {
  key: SettingsSection;
  label: string;
  icon: string;
  /** 导航里的分组小标题（英文原文）；空字符串表示不显示标题。 */
  group: string;
}

/** 文案是英文原文，显示时再用 t() 翻译。顺序即导航顺序，同组的分类必须相邻。 */
export const SETTINGS_SECTIONS: readonly SettingsSectionInfo[] = [
  { key: "general", label: "General", icon: "user", group: "Personal" },
  { key: "controls", label: "Keyboard & gamepad", icon: "settings", group: "Personal" },
  { key: "notifications", label: "Notifications", icon: "bell", group: "Personal" },
  { key: "ai", label: "AI models", icon: "assistant", group: "AI & agents" },
  { key: "execution", label: "Execution", icon: "execution", group: "AI & agents" },
  { key: "devices", label: "Hub & runtimes", icon: "device", group: "AI & agents" },
  { key: "agents", label: "Connected agents", icon: "link", group: "AI & agents" },
  { key: "capture", label: "Capture", icon: "inbox", group: "Library" },
  { key: "data", label: "Data", icon: "trash", group: "Library" },
  { key: "about", label: "About", icon: "help", group: "" },
];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "general";

/** 未知或空的分类返回 undefined：窄屏显示分类列表，桌面显示默认分类。 */
export function settingsSection(id: string | undefined): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find(section => section.key === id)?.key;
}

/** 按 `group` 把相邻的分类收成导航分组。 */
export function settingsNavGroups(sections: readonly SettingsSectionInfo[] = SETTINGS_SECTIONS): Array<{ title: string; sections: SettingsSectionInfo[] }> {
  const groups: Array<{ title: string; sections: SettingsSectionInfo[] }> = [];
  for (const section of sections) {
    const last = groups.at(-1);
    if (last && last.title === section.group) last.sections.push(section);
    else groups.push({ title: section.group, sections: [section] });
  }
  return groups;
}

/** 折叠分组记住展开状态（只存在当前浏览器）；读不到存储时用默认值。 */
const FOLD_KEY = "lumio.settings.fold.";
export function foldOpen(key: string, fallback: boolean): boolean {
  try { const saved = localStorage.getItem(FOLD_KEY + key); return saved === null ? fallback : saved === "1"; } catch { return fallback; }
}
export function rememberFold(key: string, open: boolean): void {
  try { localStorage.setItem(FOLD_KEY + key, open ? "1" : "0"); } catch { /* 存储不可用时只影响下次的默认状态。 */ }
}

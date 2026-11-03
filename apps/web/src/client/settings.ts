/** 主题与语言的选择菜单（ADR 0028），侧栏、连接页与命令面板共用。 */
import { icon, openMenu } from "./dom.ts";
import { lang, setLang, t, type Lang } from "./i18n.ts";
import { setTheme, themeChoice, type ThemeChoice } from "./theme.ts";

export const THEMES: Array<[ThemeChoice, string, string]> = [["system", "Follow system", "monitor"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]];
export const LANGS: Array<[Lang, string]> = [["en", "English"], ["zh", "中文"]];

export const themeIcon = () => icon(THEMES.find(([key]) => key === themeChoice())![2]);

export function pickTheme(anchor: HTMLElement): void {
  openMenu(anchor, THEMES.map(([value, label, name]) => ({ value, label: t(label), icon: icon(name), selected: themeChoice() === value })), value => setTheme(value as ThemeChoice));
}
/** 语言名称用各自的语言写，不翻译。 */
export function pickLang(anchor: HTMLElement): void {
  openMenu(anchor, LANGS.map(([value, label]) => ({ value, label, selected: lang() === value })), value => setLang(value as Lang));
}

/** 窄屏底栏没有侧栏底部，主题、语言与退出登录收在「我」菜单里。 */
export function pickAccount(anchor: HTMLElement, logout: () => void): void {
  const theme = THEMES.find(([key]) => key === themeChoice())!;
  const language = LANGS.find(([key]) => key === lang())!;
  openMenu(anchor, [
    { value: "theme", label: t("Theme"), icon: icon(theme[2]), hint: t(theme[1]) },
    { value: "lang", label: t("Language"), icon: icon("globe"), hint: language[1] },
    { value: "logout", label: t("Sign out"), icon: icon("logout") },
  ], value => {
    if (value === "theme") pickTheme(anchor);
    else if (value === "lang") pickLang(anchor);
    else logout();
  });
}

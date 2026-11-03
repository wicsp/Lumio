/**
 * Web 主题（ADR 0028）：跟随系统 / 浅色 / 深色。选择保存在本浏览器，实际主题写到 <html data-theme>，
 * PWA 窗口的标题栏颜色（theme-color）同步更新。
 */
export type ThemeChoice = "system" | "light" | "dark";
const KEY = "lumio.web.theme";
const COLORS = { light: "#f6f7f5", dark: "#151917" } as const;

let choice: ThemeChoice = read();
let media: MediaQueryList | undefined;
const listeners = new Set<(choice: ThemeChoice) => void>();

function read(): ThemeChoice {
  try { const value = globalThis.localStorage?.getItem(KEY); return value === "light" || value === "dark" ? value : "system"; } catch { return "system"; }
}
export const themeChoice = (): ThemeChoice => choice;
export function resolvedTheme(): "light" | "dark" {
  if (choice !== "system") return choice;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 把当前选择应用到页面；页面启动时调用一次。 */
export function applyTheme(): void {
  if (typeof document === "undefined") return;
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta => meta.remove());
  const meta = document.createElement("meta");
  meta.name = "theme-color"; meta.content = COLORS[theme];
  document.head.append(meta);
  if (!media && typeof matchMedia === "function") {
    media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => { if (choice === "system") applyTheme(); });
  }
}

export function setTheme(next: ThemeChoice): void {
  choice = next;
  try { if (next === "system") globalThis.localStorage?.removeItem(KEY); else globalThis.localStorage?.setItem(KEY, next); } catch { /* storage may be disabled */ }
  applyTheme();
  for (const listener of listeners) listener(next);
}
export function onTheme(listener: (choice: ThemeChoice) => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }

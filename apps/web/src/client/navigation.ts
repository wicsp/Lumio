/** 模块之间共用的导航类型（单独成文件，避免视图与模块互相引用）。 */
import type { ResourceRef } from "@lumio/schema";
export type Section = "overview" | "personal" | "inbox" | "knowledge" | "work" | "execution" | "assistant" | "approvals" | "settings" | "trash";
export type Navigate = (section: Section, id?: string, intent?: string) => void;

/** 窄屏底栏直接显示有 short 的模块，其余收在「更多」。 */
export const SECTIONS: readonly { key: Exclude<Section, "settings" | "trash">; label: string; short?: string; icon: string; key2: string }[] = [
  { key: "overview", label: "Today", short: "Today", icon: "home", key2: "1" },
  { key: "work", label: "Work", short: "Work", icon: "work", key2: "2" },
  { key: "knowledge", label: "Knowledge", short: "Knowledge", icon: "knowledge", key2: "3" },
  { key: "inbox", label: "Inbox", short: "Inbox", icon: "inbox", key2: "4" },
  { key: "execution", label: "Execution", icon: "execution", key2: "5" },
  { key: "assistant", label: "Assistant", short: "Assistant", icon: "assistant", key2: "6" },
  { key: "personal", label: "Personal", short: "Personal", icon: "calendar", key2: "8" },
  { key: "approvals", label: "Approvals", icon: "approvals", key2: "7" },
];

export interface Pane {
  /** 当前已加载的主对象；由模块内导航更新，不依赖工作台 URL。 */
  readonly focus?: ResourceRef;
  canLeave?(): boolean;
  beforeLeave?(): Promise<boolean>;
  dispose?(): void;
  /** A previously mounted module is visible again. */
  resume?(): void;
  readonly dirty?: boolean;
  /** 来自命令面板或快捷键的动作，例如 "new"。 */
  intent?(name: string): void;
  /** 在当前模块内打开某个对象（不重建模块）；模块自己负责未保存确认。 */
  open?(id: string): void;
  /** 静默刷新当前内容（回到前台、收到推送、定时）；有未保存的输入时模块自己跳过。 */
  liveRefresh?(): void;
}

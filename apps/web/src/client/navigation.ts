/** 模块之间共用的导航类型（单独成文件，避免视图与模块互相引用）。 */
export type Section = "overview" | "knowledge" | "work" | "execution" | "assistant" | "approvals" | "settings";
export type Navigate = (section: Section, id?: string, intent?: string) => void;

export interface Pane {
  canLeave?(): boolean;
  beforeLeave?(): Promise<boolean>;
  dispose?(): void;
  readonly dirty?: boolean;
  /** 来自命令面板或快捷键的动作，例如 "new"。 */
  intent?(name: string): void;
  /** 在当前模块内打开某个对象（不重建模块）；模块自己负责未保存确认。 */
  open?(id: string): void;
  /** 静默刷新当前内容（回到前台、收到推送、定时）；有未保存的输入时模块自己跳过。 */
  liveRefresh?(): void;
}

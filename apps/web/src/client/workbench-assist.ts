/**
 * 共用工作台的纯逻辑（ADR 0060，A1-5）：焦点快照、展示动作的落点、何时可以替人跳转。
 * 不碰 DOM，便于单测；界面在 main-dock.ts 与 views/workbench.ts。
 */
import {
  type AIConfiguration, FOCUS_LIMITS, FocusSnapshot, MODULE_ID_PREFIXES, ResourceRef, WORKBENCH_SECTIONS,
  type WorkbenchAction, type WorkbenchSection,
} from "@lumio/schema";
import type { Section } from "./navigation.ts";
import { defaultAssistantProfile } from "./assistant-profile.ts";
import { t } from "./i18n.ts";
import type { Notice } from "@lumio/schema";

const ID = /^([a-z]+)_[0-9A-HJKMNP-TV-Z]{26}$/;

/** 一个 Lumio ID 对应的 ResourceRef；不是已知模块的 ID 时返回 undefined。 */
export function refOf(id: string | undefined, label?: string): ResourceRef | undefined {
  const prefix = id?.match(ID)?.[1];
  if (!id || !prefix) return undefined;
  for (const [module, prefixes] of Object.entries(MODULE_ID_PREFIXES)) {
    if ((prefixes as readonly string[]).includes(prefix)) {
      const parsed = ResourceRef.safeParse({ module, id, ...(label?.trim() ? { label: label.trim().slice(0, 200) } : {}) });
      return parsed.success ? parsed.data : undefined;
    }
  }
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string) => [...segmenter.segment(text)].map(part => part.segment);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** 按字素截断，不切开 emoji 或组合字符。 */
export function truncateGraphemes(text: string, max: number): string {
  const parts = graphemes(text);
  return parts.length <= max ? text : parts.slice(0, max).join("");
}

export interface FocusInput {
  section: Section;
  /** 当前已加载的对象 ID，或路由里的对象 ID（如 `#work/task_…`）。 */
  id?: string;
  label?: string;
  revision?: string;
  /** 页面里选中的文字。 */
  selection?: string;
}

const isWorkbenchSection = (section: Section): section is WorkbenchSection =>
  (WORKBENCH_SECTIONS as readonly string[]).includes(section);

/**
 * 当前页面的焦点快照。选中文字先按字素截到上限，整包仍超过字节上限时继续缩短；
 * 什么都没有时返回 undefined（不发 focus）。设置、回收站不在分区里，只发选中的文字。
 */
export function buildFocus(input: FocusInput): FocusSnapshot | undefined {
  const ref = refOf(input.id, input.label);
  const primary = ref && { ...ref, ...(input.revision ? { revision: input.revision } : {}) };
  const section = isWorkbenchSection(input.section) ? input.section : undefined;
  let selection = input.selection?.trim() ? truncateGraphemes(input.selection.trim(), FOCUS_LIMITS.max_selection_graphemes) : undefined;
  const selected = section === "knowledge" && primary?.module === "knowledge" ? [primary] : [];
  const snapshot = () => ({ ...(section ? { section } : {}), ...(primary ? { primary } : {}), selected, ...(selection ? { selection_text: selection } : {}) });
  while (selection && bytes(snapshot()) > FOCUS_LIMITS.max_bytes) {
    const parts = graphemes(selection);
    selection = parts.length > 1 ? parts.slice(0, Math.floor(parts.length * 0.8)).join("") : undefined;
  }
  if (!section && !primary && !selection) return undefined;
  const parsed = FocusSnapshot.safeParse(snapshot());
  return parsed.success ? parsed.data : undefined;
}

/** 人刚动过页面的这段时间内，助手不替人跳转（ADR 0060 第 3 节）。 */
export const IDLE_BEFORE_NAVIGATE_MS = 3000;

export interface PageActivity {
  now: number;
  /** A navigation requested by the current chat may follow activity before that message, never activity after it. */
  requestedAt?: number;
  /** 最近一次输入、滚动、点击或按键的时间。 */
  lastActivity: number;
  /** 焦点在输入框、文本区或可编辑区域里，或有打开的对话框。 */
  editing: boolean;
  /** 页面可见且窗口有焦点。 */
  attentive: boolean;
}

export function canNavigateNow(activity: PageActivity): boolean {
  return activity.attentive && !activity.editing && (activity.requestedAt === undefined
    ? activity.now - activity.lastActivity >= IDLE_BEFORE_NAVIGATE_MS
    : activity.lastActivity <= activity.requestedAt);
}

type Navigate = Extract<WorkbenchAction, { action: "navigate" }>;

/** 跳转动作落到哪个页面。Hub 已校验目标属于该分区，这里只换算路由。 */
export function navigateRoute(action: Navigate): [Section, string | undefined] {
  return [action.section, action.target?.id];
}

/** 话题分隔线上显示的名称：有标签用标签，否则用 ID 等待补全。 */
export function anchorLabels(anchors: readonly ResourceRef[], titles: ReadonlyMap<string, string> = new Map()): string[] {
  return anchors.map(ref => titles.get(ref.id) ?? ref.label ?? ref.id);
}

/**
 * 主对话只接受 API 连接的 Lumio Profile（A1-3）。优先本浏览器为该账号选的默认 Profile，
 * 否则取第一个可用的；都没有时不指定，由 Hub 的旧 API 设置兜底。
 */
export function mainProfile(config: AIConfiguration, storage?: Pick<Storage, "getItem" | "setItem">): string | undefined {
  const usable = config.profiles.filter(profile => profile.engine === "lumio" &&
    config.connections.some(connection => connection.id === profile.connection && connection.host === "hub" && !!connection.base_url));
  const saved = defaultAssistantProfile(usable, storage);
  return saved || usable[0]?.id;
}

const NOTICE_SOURCE: Record<Notice["source"], string> = {
  turn: "Run result", proposal: "Approval", capture: "New source", watchdog: "Watchdog report", exploration: "Exploration",
};

/** 提醒的标题：来源说明按界面语言显示（Hub 在后台生成提醒，没有请求语言），巡检报告只显示来源。 */
export function noticeTitle(notice: Pick<Notice, "source" | "title">): string {
  const source = t(NOTICE_SOURCE[notice.source]);
  return notice.source === "watchdog" ? source : t("{0} · {1}", source, notice.title);
}

/** 一行预览里的摘要：去掉 Markdown 记号，合并空白。 */
export function noticePreview(summary: string, max = 140): string {
  return summary.replace(/[*_`#>]+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, max);
}

import { z } from "zod";
import { idOf, RequestId, Sha256, Timestamp } from "./common.ts";
import { ResourceRef } from "./work.ts";

/**
 * 全局捕获键的"所见"（Glance，`gln_`；ADR 0066，C1-1）。
 *
 * macOS 菜单栏小助手（`apps/desktop`）在人按下触发键时采集一份所见：前台窗口截图、光标与按住期间的轨迹、选中文字、
 * 本机识字块、App 与窗口标题、已知浏览器的网址。所见记录存在 `hub.sqlite`，属于 Hub 的跨模块协调数据（与捕获 `cap_` 同级），
 * 截图存为 Hub 托管文件（`art_`），不进 vault。所见不是 ResourceRef：它通过 `used_by` 与捕获或消息关联。
 *
 * 小助手是 human 客户端：用 `POST /v2/setup/client-invites` 生成配对码（令牌标签如 `desktop@macbook`）、`POST /v2/setup/client/join` 换取 human 令牌，
 * 不需要新的配对接口。只有人按下物理按键时才采集；Hub 没有任何接口能让小助手截屏或录音。
 *
 * 坐标一律是**截图像素坐标**（原点在左上角），小助手负责从屏幕坐标换算（Retina 缩放、多显示器）。
 * 截图、识字、窗口标题都是屏幕上的第三方内容：作为数据放在边界内，**不能作为人批准任何事的证据**（ADR 0066 第 5 节）。
 *
 * HTTP（全部只授予 human，且只能操作自己的所见）：
 * - `POST   /v2/glances`：`multipart/form-data`，`meta` 部分为 GlanceCreate（JSON），可选 `image` 部分为截图（JPEG / PNG）→ Glance。
 *   同一 `request_id` 重复提交返回原来的所见。有 `meta.image` 时必须带 `image` 部分，且实际格式、尺寸、字节数与声明一致；
 *   网址属于本 Hub 的 Web 时 Hub 丢弃截图与识字，只把路由解析为 `lumio`（ADR 0066 第 3 节）。
 * - `GET    /v2/glances/<id>`：Glance
 * - `GET    /v2/glances/<id>/image`：截图本身（截图已删除时 404）
 * - `DELETE /v2/glances/<id>`：GlanceDeleteResult；只能删除未被使用（`used_by` 为空）的所见，用于按住时按 Esc 取消
 * 新建捕获见 `CaptureCreate.glance`（inbox.ts），对话见 `AssistantChatRequest.glance`（assistant.ts）。
 */

/** 上限与默认值。小助手与 Hub 按这些常量执行，Hub 复验。 */
export const GLANCE_LIMITS = {
  /** 截图长边像素上限（小助手缩放后上传）。 */
  max_image_edge: 2048,
  /** 截图字节上限。 */
  max_image_bytes: 4 * 1024 * 1024,
  /** 按住期间光标轨迹的点数上限；超出时小助手均匀抽稀。 */
  max_trail_points: 200,
  /** 选中文字的字符上限（按 UTF-16 码元计）。 */
  max_selection_chars: 20_000,
  /** 识字块个数上限。 */
  max_ocr_blocks: 2000,
  /** 全部识字块文字合计的字符上限。 */
  max_ocr_chars: 100_000,
  /** 窗口标题字符上限。 */
  max_window_title_chars: 500,
  /** 只用于对话、没有存成资料的截图的默认保留天数（Hub 配置可改）。 */
  default_retention_days: 30,
} as const;

/** 小助手的交互默认值（只在客户端使用；写在契约里是为了 Web 设置页与文档引用同一个数）。 */
export const GLANCE_CLIENT_DEFAULTS = {
  /** 按下到松开短于此时长为轻点（收藏），否则为按住（说话）。 */
  tap_threshold_ms: 250,
  /** 按住期间采样光标的频率。 */
  trail_sample_hz: 20,
} as const;

const HttpUrl = z.url({ protocol: /^https?$/ }).max(2048);
const Pixel = z.number().int().nonnegative();

/** 截图中的一个点。 */
export const GlancePoint = z.strictObject({ x: Pixel, y: Pixel });

/** 轨迹上的一个点；`t_ms` 是距按下时刻的毫秒数，必须不减。 */
export const GlanceTrailPoint = z.strictObject({ x: Pixel, y: Pixel, t_ms: z.number().int().nonnegative() });

/** 截图中的矩形框。 */
export const GlanceBox = z.strictObject({ x: Pixel, y: Pixel, w: z.number().int().positive(), h: z.number().int().positive() });

/** 一块识字结果（小助手本机识别，ADR 0066 第 3 节）。 */
export const GlanceOcrBlock = z.strictObject({
  text: z.string().min(1).max(5000),
  box: GlanceBox,
  confidence: z.number().min(0).max(1).optional(),
});

/** 前台 App。 */
export const GlanceApp = z.strictObject({
  bundle_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/).optional(),
  name: z.string().trim().min(1).max(200),
});

/** 上传的截图声明；实际文件在 multipart 的 `image` 部分。 */
export const GlanceImageMeta = z.strictObject({
  format: z.enum(["jpeg", "png"]),
  width: z.number().int().positive().max(GLANCE_LIMITS.max_image_edge),
  height: z.number().int().positive().max(GLANCE_LIMITS.max_image_edge),
});

/**
 * 上传所见的元数据（multipart 的 `meta` 部分）。
 * - 至少有截图、网址、选中文字之一；
 * - 光标、轨迹、识字块都依附于截图，没有截图时不能出现，且都必须落在截图范围内；
 * - 排除名单里的 App 不上传所见（小助手在本地拦下，ADR 0066 第 5 节）。
 */
export const GlanceCreate = z
  .strictObject({
    request_id: RequestId,
    captured: Timestamp.describe("按下触发键的时刻"),
    app: GlanceApp,
    window_title: z.string().max(GLANCE_LIMITS.max_window_title_chars).optional(),
    url: HttpUrl.optional().describe("前台是已知浏览器时读到的当前标签页网址"),
    image: GlanceImageMeta.optional(),
    pointer: GlancePoint.optional().describe("按下时的光标；光标不在该窗口内时缺省"),
    trail: z.array(GlanceTrailPoint).max(GLANCE_LIMITS.max_trail_points).default([]).describe("按住期间的光标轨迹；轻点时为空"),
    selection_text: z.string().min(1).max(GLANCE_LIMITS.max_selection_chars).optional(),
    ocr: z.array(GlanceOcrBlock).max(GLANCE_LIMITS.max_ocr_blocks).default([]),
    ocr_engine: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}@[0-9]+$/).optional().describe("形如 apple-vision@1；有识字块时必填"),
  })
  .superRefine((glance, ctx) => {
    if (glance.image === undefined && glance.url === undefined && glance.selection_text === undefined)
      ctx.addIssue({ code: "custom", message: "至少要有截图、网址或选中文字之一" });
    if (glance.ocr.length > 0 && glance.ocr_engine === undefined)
      ctx.addIssue({ code: "custom", path: ["ocr_engine"], message: "有识字块时必须写明识字引擎" });
    const chars = glance.ocr.reduce((sum, block) => sum + block.text.length, 0);
    if (chars > GLANCE_LIMITS.max_ocr_chars)
      ctx.addIssue({ code: "custom", path: ["ocr"], message: `识字文字合计最多 ${GLANCE_LIMITS.max_ocr_chars} 字符` });
    for (let i = 1; i < glance.trail.length; i++)
      if (glance.trail[i]!.t_ms < glance.trail[i - 1]!.t_ms)
        ctx.addIssue({ code: "custom", path: ["trail", i, "t_ms"], message: "轨迹时间必须不减" });
    const image = glance.image;
    if (image === undefined) {
      for (const key of ["pointer", "trail", "ocr"] as const) {
        const value = glance[key];
        if (value !== undefined && !(Array.isArray(value) && value.length === 0))
          ctx.addIssue({ code: "custom", path: [key], message: "没有截图时不能带光标、轨迹或识字块" });
      }
      return;
    }
    const inside = (x: number, y: number) => x < image.width && y < image.height;
    if (glance.pointer && !inside(glance.pointer.x, glance.pointer.y))
      ctx.addIssue({ code: "custom", path: ["pointer"], message: "光标不在截图范围内" });
    glance.trail.forEach((point, i) => {
      if (!inside(point.x, point.y)) ctx.addIssue({ code: "custom", path: ["trail", i], message: "轨迹点不在截图范围内" });
    });
    glance.ocr.forEach((block, i) => {
      if (block.box.x + block.box.w > image.width || block.box.y + block.box.h > image.height)
        ctx.addIssue({ code: "custom", path: ["ocr", i, "box"], message: "识字框超出截图范围" });
    });
  });

/**
 * Hub 挑出的"指向的段落"（ADR 0066 第 3 节）：
 * `selection` 选中文字；`region` 轨迹围出的区域；`point` 光标所在段落；`none` 没有指向，用整窗识字。
 */
export const GlancePointing = z.strictObject({
  method: z.enum(["selection", "region", "point", "none"]),
  text: z.string().max(GLANCE_LIMITS.max_selection_chars).optional().describe("method 为 none 时缺省"),
  blocks: z.array(z.number().int().nonnegative()).max(GLANCE_LIMITS.max_ocr_blocks).default([]).describe("所用识字块在 ocr 中的下标"),
  region: GlanceBox.optional().describe("method 为 region 时轨迹围出的区域"),
});

/** 同轮模型回复选择的相关内容；摘录由 Hub 对照原文验证（ADR 0076）。 */
export const GlanceContextRetention = z.strictObject({
  text: z.array(z.string().trim().min(1).max(2000)).max(8),
  image: z.boolean(),
  source: z.boolean(),
});
export const GlanceAssistantReply = z.strictObject({
  reply: z.string().max(500000),
  context: GlanceContextRetention,
});

/** 所见记录。 */
export const Glance = z.strictObject({
  id: idOf("gln"),
  owner: idOf("act"),
  captured: Timestamp,
  app: GlanceApp,
  window_title: z.string().max(GLANCE_LIMITS.max_window_title_chars).optional(),
  url: HttpUrl.optional(),
  image: z
    .strictObject({
      file: idOf("art"),
      format: GlanceImageMeta.shape.format,
      width: GlanceImageMeta.shape.width,
      height: GlanceImageMeta.shape.height,
      bytes: z.number().int().positive().max(GLANCE_LIMITS.max_image_bytes),
      sha256: Sha256,
      purged: Timestamp.optional().describe("截图已按保留期删除的时间；记录与哈希仍在"),
    })
    .optional(),
  pointer: GlancePoint.optional(),
  trail: z.array(GlanceTrailPoint).max(GLANCE_LIMITS.max_trail_points),
  selection_text: z.string().max(GLANCE_LIMITS.max_selection_chars).optional(),
  ocr: z.array(GlanceOcrBlock).max(GLANCE_LIMITS.max_ocr_blocks),
  ocr_engine: z.string().optional(),
  pointing: GlancePointing,
  /** 网址属于本 Hub 的 Web 时，由路由解析出的对象；这时没有截图与识字，按焦点处理。 */
  lumio: ResourceRef.optional(),
  /** 用在了哪里。都为空的所见可以删除；只用于对话的截图按保留期删除。 */
  used_by: z.strictObject({
    capture: idOf("cap").optional(),
    message: idOf("amsg").optional(),
  }),
  created: Timestamp,
  context_retention: GlanceContextRetention.extend({
    status: z.enum(["pending", "retained", "discarded"]),
    finalized: Timestamp.optional(),
    enrichment_pending: z.boolean().optional(),
  }).optional(),
});

export const GlanceDeleteResult = z.strictObject({ id: idOf("gln"), deleted: z.literal(true) });

// ───────────────────────── 主对话里的收藏工具（ADR 0066 第 4 节） ─────────────────────────

/**
 * 内置助手在 human 拥有的主对话里的收藏工具。不登记进 `CAPABILITIES`，外部 agent 看不到。
 * 只能把**当前这条人的消息所附的所见**存为资料，等同轻点收藏；不能指定别的所见或任意内容。
 */
export const CAPTURE_TOOLS = ["capture.glance"] as const;
export const CaptureToolName = z.enum(CAPTURE_TOOLS);

/** `capture.glance` 的参数。所见由 Hub 从当前消息取得，不由模型传入。 */
export const CaptureGlanceToolArgs = z.strictObject({
  title: z.string().trim().min(1).max(200).optional().describe("资料标题；缺省由 Hub 生成"),
  reason: z.string().trim().min(1).max(500).optional().describe("人说的为什么存、想拿它干嘛；作为写卡片时的提示"),
});

export const CaptureGlanceToolResult = z.strictObject({
  capture: idOf("cap"),
  title: z.string().max(500).optional(),
});

export type GlancePoint = z.infer<typeof GlancePoint>;
export type GlanceTrailPoint = z.infer<typeof GlanceTrailPoint>;
export type GlanceBox = z.infer<typeof GlanceBox>;
export type GlanceOcrBlock = z.infer<typeof GlanceOcrBlock>;
export type GlanceApp = z.infer<typeof GlanceApp>;
export type GlanceImageMeta = z.infer<typeof GlanceImageMeta>;
export type GlanceCreate = z.infer<typeof GlanceCreate>;
export type GlancePointing = z.infer<typeof GlancePointing>;
export type Glance = z.infer<typeof Glance>;
export type GlanceDeleteResult = z.infer<typeof GlanceDeleteResult>;
export type CaptureToolName = z.infer<typeof CaptureToolName>;
export type CaptureGlanceToolArgs = z.infer<typeof CaptureGlanceToolArgs>;
export type CaptureGlanceToolResult = z.infer<typeof CaptureGlanceToolResult>;

export type GlanceContextRetention = z.infer<typeof GlanceContextRetention>;
export type GlanceAssistantReply = z.infer<typeof GlanceAssistantReply>;

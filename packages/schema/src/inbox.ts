import { z } from "zod";
import { Id, idOf, RequestId, Revision, Sha256, Timestamp } from "./common.ts";
import { READING_STATUSES, ReadingStatus } from "./entities.ts";
import { NoteRef } from "./query.ts";

/**
 * Inbox 与外部资料入库（ADR 0057，I1-1）。
 *
 * 捕获记录（Capture，`cap_`）存在 `hub.sqlite`，属于 Hub 的跨模块协调数据；Inbox 就是"未分拣的捕获"。
 * 解析成功即生成知识实体（`paper` 或 `source`）、原文文件（`files/originals/`）与 AI 卡片（AI 笔记）。
 *
 * HTTP（只授予 human，ADR 0057 第 7 节）：
 * - `POST /v2/inbox/captures`：CaptureCreate → CaptureCreateResult
 * - `GET  /v2/inbox/captures?untriaged=true|false&limit=`：CaptureList（新的在前）
 * - `GET  /v2/inbox/captures/<id>`：Capture
 * - `POST /v2/inbox/captures/<id>/commands`：CaptureCommand → Capture
 * - `GET/PUT /v2/inbox/proxy-settings`：CaptureProxySettings / CaptureProxyUpdate（ADR 0062）
 * - `GET/PUT /v2/ai/knowledge-bindings`：KnowledgeAIBinding[] / KnowledgeAIBindingUpdate
 * Inbox 的"可能相关"复用编辑器相关推荐（`KnowledgeReferencesRequest`，ADR 0035），以捕获出的实体为来源，不另设接口。
 */

/** 上限。Hub 与客户端按这些常量执行。 */
export const CAPTURE_LIMITS = {
  /** 网址最大长度。 */
  max_url_chars: 2048,
  /** 随捕获送来的正文（浏览器插件或手动粘贴）最大字符数。 */
  max_content_chars: 2_000_000,
  /** Hub 抓取网页的最大字节数。 */
  max_fetch_bytes: 10 * 1024 * 1024,
  /** Hub 抓取网页的超时（毫秒）。 */
  fetch_timeout_ms: 20_000,
  /** 最多跟随的重定向次数，每次都重新检查地址（ADR 0057 第 7 节）。 */
  max_redirects: 5,
  /** 卡片输入的默认 token 上限（Hub 配置可改）。 */
  default_card_input_tokens: 8000,
} as const;

/** 原文目录（相对 vault 根目录）。不扫描为实体、不进链接图（ADR 0057 第 1 节）。 */
export const ORIGINALS_DIRECTORY = "files/originals";

const HttpUrl = z.url({ protocol: /^https?$/ }).max(CAPTURE_LIMITS.max_url_chars);

export const CAPTURE_PROXY_LIMITS = { address: CAPTURE_LIMITS.max_url_chars, bypass: 4096 } as const;
const ProxyEndpoint = z.string().trim().pipe(z.url({ protocol: /^https?$/ }).max(CAPTURE_PROXY_LIMITS.address).refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.pathname === "/" && !url.search && !url.hash;
}));
const ProxyOrigin = ProxyEndpoint.refine(value => URL.canParse(value) && new URL(value).origin === value);
const NoProxy = z.string().trim().max(CAPTURE_PROXY_LIMITS.bypass);

export const CaptureProxySettings = z.discriminatedUnion("mode", [
  z.strictObject({ revision: Revision, mode: z.literal("environment") }),
  z.strictObject({ revision: Revision, mode: z.literal("custom"), proxy_origin: ProxyOrigin, no_proxy: NoProxy }),
]);
export type CaptureProxySettings = z.infer<typeof CaptureProxySettings>;

export const CaptureProxyUpdate = z.discriminatedUnion("mode", [
  z.strictObject({ expected_revision: Revision, mode: z.literal("environment") }),
  z.strictObject({ expected_revision: Revision, mode: z.literal("custom"), proxy_url: ProxyEndpoint.optional(), no_proxy: NoProxy }),
]);
export type CaptureProxyUpdate = z.infer<typeof CaptureProxyUpdate>;

/** Private file record. The URL may contain credentials. Use CaptureProxySettings for responses. */
export const CaptureProxyRecord = z.discriminatedUnion("mode", [
  z.strictObject({ revision: Revision, mode: z.literal("environment") }),
  z.strictObject({ revision: Revision, mode: z.literal("custom"), proxy_url: ProxyEndpoint, no_proxy: NoProxy }),
]);
export type CaptureProxyRecord = z.infer<typeof CaptureProxyRecord>;

/** 捕获从哪里来。 */
export const CaptureChannel = z.enum(["web", "cli", "extension", "share"]);

/** 资料类型：由 Hub 判断。`text` 是只有粘贴正文、没有网址的资料。 */
export const CaptureKind = z.enum(["paper", "web", "video", "podcast", "text"]);

/**
 * 处理状态。`ready` 指实体与原文已经生成；卡片单独记在 `card`，没有卡片不影响资料入库。
 * 失败不自动重试（ADR 0005），由人发 `retry`。
 */
export const CaptureState = z.enum(["queued", "extracting", "ready", "failed"]);

/** 卡片状态：`none` 表示没有配置 `knowledge.summary` 用途；`deep` 表示已按全文生成深读总结。 */
export const CaptureCardState = z.enum(["none", "pending", "ready", "deep", "failed"]);

/** 分拣结果：设置阅读状态，或丢弃。 */
export const CaptureTriage = z.enum([...READING_STATUSES, "discard"]);

/** 失败原因。`blocked`：地址是回环、内网或链路本地，或重定向到这些地址。 */
export const CaptureErrorCode = z.enum([
  "blocked", "fetch_failed", "too_large", "timeout", "unsupported", "login_required", "extract_failed", "runtime_unavailable", "summary_failed",
]);
export const CaptureError = z.strictObject({ code: CaptureErrorCode, message: z.string().min(1).max(500) });

/** 随捕获送来的正文。浏览器插件送的是人当前看到的页面。 */
export const CaptureContent = z.strictObject({
  format: z.enum(["html", "markdown", "text"]),
  body: z.string().min(1).max(CAPTURE_LIMITS.max_content_chars),
});

/** 新建捕获：至少要有网址或正文。 */
export const CaptureCreate = z
  .strictObject({
    request_id: RequestId,
    channel: CaptureChannel,
    url: HttpUrl.optional(),
    title: z.string().trim().min(1).max(500).optional(),
    content: CaptureContent.optional(),
    /** 捕获时就分拣（例如插件上点了"存档"）；省略时进入 Inbox，状态为 to-read。 */
    triage: ReadingStatus.optional(),
  })
  .refine(v => v.url !== undefined || v.content !== undefined, "Provide a URL or content");

export const Capture = z.strictObject({
  id: idOf("cap"),
  owner: idOf("act"),
  channel: CaptureChannel,
  /** 规范化后的网址（去跟踪参数、统一 arXiv/DOI 形式），用于去重。 */
  url: HttpUrl.optional(),
  /** 人给的原始网址，与规范化结果不同时才有。 */
  original_url: HttpUrl.optional(),
  title: z.string().max(500).optional(),
  kind: CaptureKind.optional().describe("Hub 判断出类型之前缺省"),
  state: CaptureState,
  card: CaptureCardState,
  entity: NoteRef.optional().describe("生成的 paper 或 source；ready 之前缺省"),
  ai_note: idOf("ain").optional(),
  original: z.string().optional().describe("原文文件相对 vault 根目录的路径"),
  triage: CaptureTriage.optional().describe("缺省表示未分拣，仍在 Inbox"),
  triaged: Timestamp.optional(),
  /** 第几次处理（重试、重新抽取各算一次），从 1 开始。 */
  attempt: z.number().int().positive(),
  /** 处理这一次的 Job（重的抽取交给执行器时才有）。 */
  job: idOf("job").optional(),
  error: CaptureError.optional(),
  revision: Revision,
  created: Timestamp,
  updated: Timestamp,
});

/**
 * 新建的结果。`duplicate`：
 * - `none`：新的捕获；
 * - `existing`：规范化后的网址已有，返回原来的捕获，不重复解析；
 * - `discarded`：以前丢弃过，返回原来的捕获（仍是丢弃状态），由人决定是否从回收站恢复。
 */
export const CaptureCreateResult = z.strictObject({
  capture: Capture,
  duplicate: z.enum(["none", "existing", "discarded"]),
});

export const CaptureListArgs = z.strictObject({
  untriaged: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(50),
});
export const CaptureList = z.strictObject({ captures: z.array(Capture), total: z.number().int().nonnegative() });

/**
 * 对一条捕获的操作，带版本：
 * - `triage`：设置阅读状态或丢弃（实体、原文、AI 笔记一起进回收站，ADR 0038）；
 * - `retry`：只用于 `failed`；可附上手动粘贴的正文；
 * - `reextract`：只用于 `ready`；整体替换原文，旧版本留在 git 历史；
 * - `summarize`：`card` 补做或重做卡片，`deep` 用全文生成深读总结；都更新同一份 AI 笔记。
 */
export const CaptureCommand = z.strictObject({
  request_id: RequestId,
  expected_revision: Revision,
  action: z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal("triage"), triage: CaptureTriage }),
    z.strictObject({ op: z.literal("retry"), content: CaptureContent.optional() }),
    z.strictObject({ op: z.literal("reextract") }),
    z.strictObject({ op: z.literal("summarize"), depth: z.enum(["card", "deep"]) }),
  ]),
});

/**
 * 原文文件的 frontmatter（`files/originals/<标题> <实体 ID>.md`）。只由 Lumio 写。
 * `extractor` 形如 `readability@1`、`arxiv-html@1`、`youtube-subtitles@1`、`marker@1`、`whisper@1`、`pasted@1`。
 * `sha256` 是正文（frontmatter 之后的部分）的摘要。
 */
export const OriginalFrontmatter = z.strictObject({
  of: Id.refine(id => /^(pap|src)_/.test(id), "Originals belong to a paper or source"),
  url: HttpUrl.optional(),
  captured: Timestamp,
  extractor: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}@[0-9]+$/, "extractor must look like name@version"),
  lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).optional(),
  sha256: Sha256,
  /** 论文 PDF 存为 Hub 托管文件时的文件 ID（ADR 0057 第 1 节）。 */
  pdf: idOf("art").optional(),
});

/**
 * 摘要与向量的用途绑定（ADR 0057 第 4 节，扩展 ADR 0041）。没有工具、沙箱和工作区，与 Assistant / Job 的绑定分开。
 * Hub 校验：`knowledge.summary` 的 Profile 引擎为 `lumio`；`knowledge.embedding` 的 Profile 引擎为 `embedding`。
 */
export const KnowledgeAIPurpose = z.enum(["knowledge.summary", "knowledge.embedding"]);
export const KnowledgeAIBinding = z.strictObject({ purpose: KnowledgeAIPurpose, profile: idOf("aip"), revision: Revision });
export const KnowledgeAIBindingUpdate = z.strictObject({
  request_id: RequestId,
  purpose: KnowledgeAIPurpose,
  /** null 表示解除绑定：资料照常入库，不再生成卡片或向量。 */
  profile: idOf("aip").nullable(),
  expected_revision: Revision.optional(),
});

export type CaptureChannel = z.infer<typeof CaptureChannel>;
export type CaptureKind = z.infer<typeof CaptureKind>;
export type CaptureState = z.infer<typeof CaptureState>;
export type CaptureCardState = z.infer<typeof CaptureCardState>;
export type CaptureTriage = z.infer<typeof CaptureTriage>;
export type CaptureError = z.infer<typeof CaptureError>;
export type CaptureContent = z.infer<typeof CaptureContent>;
export type CaptureCreate = z.infer<typeof CaptureCreate>;
export type Capture = z.infer<typeof Capture>;
export type CaptureCreateResult = z.infer<typeof CaptureCreateResult>;
export type CaptureListArgs = z.infer<typeof CaptureListArgs>;
export type CaptureList = z.infer<typeof CaptureList>;
export type CaptureCommand = z.infer<typeof CaptureCommand>;
export type OriginalFrontmatter = z.infer<typeof OriginalFrontmatter>;
export type KnowledgeAIPurpose = z.infer<typeof KnowledgeAIPurpose>;
export type KnowledgeAIBinding = z.infer<typeof KnowledgeAIBinding>;
export type KnowledgeAIBindingUpdate = z.infer<typeof KnowledgeAIBindingUpdate>;

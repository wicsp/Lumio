import { z } from "zod";
import { ApiError } from "./api.ts";
import { idOf, Revision, RequestId, Timestamp } from "./common.ts";

/**
 * 语音输入（ADR 0055，S1-2）。
 *
 * 浏览器经 WebSocket `/v2/speech/transcribe` 把 PCM16 发给 Hub，Hub 转给语音服务。
 * JSON 文本帧是控制消息（本文件），二进制帧是音频。Hub 不保存音频与中间结果。
 */

/** 语音协议版本；与 Job 协议、原生会话协议独立。 */
export const SPEECH_PROTOCOL = 1;

/** 协议上限（ADR 0055 第 2 节）。Hub 与浏览器都按这些常量执行。 */
export const SPEECH_LIMITS = {
  /** 采样率（Hz）；单声道、16 位小端 PCM。 */
  sample_rate: 16000,
  /** 一句最长秒数；到达时 Hub 定稿并结束。 */
  max_utterance_seconds: 120,
  /** 单个二进制帧的最大字节数；必须是偶数字节（整数个 PCM16 样本）。 */
  max_frame_bytes: 8192,
  /** 每个身份同时进行的语音会话上限。 */
  max_sessions_per_actor: 2,
  /** 握手后必须在这个时间内收到有效的 start（毫秒）。 */
  start_timeout_ms: 5000,
  /** 连续这么久没有音频即结束（毫秒）。 */
  idle_timeout_ms: 10000,
  /** 定稿文本的最大字符数。 */
  max_text_chars: 20000,
} as const;

/** 音频格式；首版只有一种。以后协商 Opus 时在这里新增取值。 */
export const SpeechAudioFormat = z.enum(["pcm16le-16k-mono"]);

// ---- 浏览器 → Hub ----

/**
 * 第一条消息：认证并开始一句。浏览器的 WebSocket 不能设置 Authorization 头，令牌放在这里；
 * Hub 在收到有效 start 之前不接受音频帧（ADR 0055 第 2 节）。只有 human 身份可用（第 4 节）。
 */
export const SpeechStart = z.strictObject({
  type: z.literal("start"),
  protocol: z.literal(SPEECH_PROTOCOL),
  token: z.string().min(16).max(4096),
  request_id: RequestId,
  format: SpeechAudioFormat,
  /** 省略时使用该身份的 `speech.asr` 用途绑定。 */
  profile: idOf("aip").optional(),
  /** 是否使用该身份维护的热词表；默认使用。 */
  vocabulary: z.boolean().default(true),
});

/** 松手：音频已发完，请求定稿。 */
export const SpeechEnd = z.strictObject({ type: z.literal("end") });
/** 放弃这一句：Hub 关闭到服务商的连接，不返回 final。 */
export const SpeechCancel = z.strictObject({ type: z.literal("cancel") });

export const SpeechClientMessage = z.discriminatedUnion("type", [SpeechStart, SpeechEnd, SpeechCancel]);

// ---- Hub → 浏览器 ----

/** 服务商已就绪，可以开始发音频。 */
export const SpeechReady = z.strictObject({
  type: z.literal("ready"),
  protocol: z.literal(SPEECH_PROTOCOL),
  profile: idOf("aip"),
  /** 实际使用的模型，供界面显示"音频发送给哪个服务"。 */
  model: z.string().min(1).max(200),
  /** 本句是否带了热词表（词表为空或同步失败时为 false）。 */
  vocabulary: z.boolean(),
});

/** 当前整句的临时文本；序号递增，后一条覆盖前一条，不累加。 */
export const SpeechPartial = z.strictObject({
  type: z.literal("partial"),
  seq: z.number().int().nonnegative(),
  text: z.string().max(SPEECH_LIMITS.max_text_chars),
});

/** 定稿文本。之后 Hub 关闭连接。 */
export const SpeechFinal = z.strictObject({
  type: z.literal("final"),
  text: z.string().max(SPEECH_LIMITS.max_text_chars),
  /** 收到的音频时长（毫秒）。 */
  duration_ms: z.number().int().nonnegative(),
  /** 因为到达 max_utterance_seconds 或空闲超时而由 Hub 主动定稿。 */
  truncated: z.boolean(),
});

/** 出错；之后 Hub 关闭连接。浏览器保留已收到的临时文本，不自动重试。 */
export const SpeechError = z.strictObject({ type: z.literal("error"), ...ApiError.shape });

export const SpeechServerMessage = z.discriminatedUnion("type", [SpeechReady, SpeechPartial, SpeechFinal, SpeechError]);

// ---- 热词表 ----

/** 一个热词：人维护的词条（项目名、执行器名、术语、citekey 等）。 */
export const SpeechTerm = z.string().trim().min(1).max(40).refine(value => !/[\r\n\t]/.test(value), "热词不能含换行或制表符");

/** 热词表与服务商同步的状态。Fun-ASR 需要先在服务商建词表，请求只带词表 ID（ADR 0055 第 3 节修订）。 */
export const SpeechVocabularySync = z.strictObject({
  connection: idOf("aic"),
  state: z.enum(["pending", "synced", "error"]),
  /** 已同步到服务商的词表 revision。 */
  revision: Revision.optional(),
  updated: Timestamp,
  error: z.string().max(200).optional(),
});

/**
 * 一个身份的热词表。只来自人显式维护的词条，以及可选的非私密项目名；
 * 不得从知识正文或私密实体取词，因为热词会发给第三方并保存在服务商（ADR 0055 第 3 节）。
 */
export const SpeechVocabulary = z.strictObject({
  owner: idOf("act"),
  terms: z.array(SpeechTerm).max(200),
  /** 是否自动并入未删除、非私密的项目名称。 */
  include_project_names: z.boolean(),
  revision: Revision,
  updated: Timestamp,
  sync: z.array(SpeechVocabularySync),
});

export const SpeechVocabularyUpdate = z.strictObject({
  request_id: RequestId,
  expected_revision: Revision,
  terms: z.array(SpeechTerm).max(200).refine(terms => new Set(terms.map(term => term.toLowerCase())).size === terms.length, "热词不能重复"),
  include_project_names: z.boolean(),
});

// ---- 用途绑定 ----

/**
 * 语音用途绑定（ADR 0055 第 3 节，扩展 ADR 0041 的"用途绑定"）。
 * 与 Assistant / Job 的 AIUsageBinding 分开：语音没有工具、沙箱和工作区。
 * Hub 校验 Profile 的引擎为 speech、所属 Connection 是语音服务。
 */
export const SpeechBinding = z.strictObject({
  purpose: z.enum(["speech.asr", "speech.tts"]),
  profile: idOf("aip"),
  revision: Revision,
});

export const SpeechBindingUpdate = z.strictObject({
  request_id: RequestId,
  purpose: z.enum(["speech.asr", "speech.tts"]),
  /** null 表示解除绑定（该用途不再可用，界面隐藏麦克风入口）。 */
  profile: idOf("aip").nullable(),
  expected_revision: Revision.optional(),
});

export type SpeechStart = z.infer<typeof SpeechStart>;
export type SpeechClientMessage = z.infer<typeof SpeechClientMessage>;
export type SpeechServerMessage = z.infer<typeof SpeechServerMessage>;
export type SpeechVocabulary = z.infer<typeof SpeechVocabulary>;
export type SpeechVocabularyUpdate = z.infer<typeof SpeechVocabularyUpdate>;
export type SpeechVocabularySync = z.infer<typeof SpeechVocabularySync>;
export type SpeechBinding = z.infer<typeof SpeechBinding>;
export type SpeechBindingUpdate = z.infer<typeof SpeechBindingUpdate>;

import { z } from "zod";
import { RequestId, RuntimeName, Timestamp } from "./common.ts";

/**
 * Runtime 跟随 Hub 版本自动更新（ADR 0063，U1-1）。
 *
 * - Hub 只在同步回复里下发期望版本号（RuntimeUpdateDirective），不下发地址，也不决定信任；
 *   Runtime 自己收敛，并在心跳里报告进度（RuntimeUpdateReport）。
 * - 更新产物用 ReleaseManifest 描述，由正式发布密钥或本机已信任的构建密钥签名（签名是清单字节之外的 manifest.sig）。
 * - 更新不是 Task 或 Job，Job 协议仍为 2；新增字段都是可选的，只发给声明了 self_update 的 Runtime。
 */

/** Lumio 程序版本，不带前缀 v，例如 0.4.0、0.4.0-dev.local.1a2b3c4。 */
export const LumioVersion = z.string().regex(/^\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?$/, "版本必须是 x.y.z，可带后缀，不带前缀 v").max(64);

/** 发布与更新支持的平台（与 release.yml 一致）。 */
export const RUNTIME_PLATFORMS = ["darwin-arm64", "linux-x64", "linux-arm64"] as const;
export const RuntimePlatform = z.enum(RUNTIME_PLATFORMS);

/**
 * Runtime 的安装方式（ADR 0063 第 2 节），由 Runtime 自己判断：
 * hub-shared：与本机 Hub 共用 ~/.local/bin/lumio，不替换程序，只在空闲时重启；
 * managed：install.sh / upgrade 管理且本机没有 Hub，可以下载、验签、替换；
 * external：Nix、brew、容器、源码运行或 LUMIO_RUNTIME_AUTO_UPDATE=off，只报告落后。
 */
export const RUNTIME_INSTALLS = ["hub-shared", "managed", "external"] as const;
export const RuntimeInstall = z.enum(RUNTIME_INSTALLS);

/** 每台 Runtime 的更新策略：follow 跟随 Hub 的版本（默认）；manual 只显示落后，不下发期望版本。 */
export const RuntimeUpdatePolicy = z.enum(["follow", "manual"]);

/**
 * Runtime 报告的更新状态（ADR 0063 第 5 节）。
 * current：已是期望版本或没有期望版本；downloading：下载与验签中；staged：已暂存并通过预检；
 * waiting_idle：等自然空闲（至多 30 分钟）；draining：排空中，不再接新工作；restarting：即将退出重启或等待新进程确认；
 * failed：这一版本失败，不再自动重试；blocked：无法自更新（外部安装或开发构建未被信任），继续运行当前版本。
 */
export const RUNTIME_UPDATE_STATES = ["current", "downloading", "staged", "waiting_idle", "draining", "restarting", "failed", "blocked"] as const;
export const RuntimeUpdateState = z.enum(RUNTIME_UPDATE_STATES);

/** 失败或受阻的原因代码；面向人的文字由各 app 按代码翻译。 */
export const RUNTIME_UPDATE_REASONS = [
  "external_install",
  "untrusted_build",
  "artifact_unavailable",
  "download_failed",
  "signature_invalid",
  "digest_mismatch",
  "platform_missing",
  "version_mismatch",
  "preflight_failed",
  "replace_failed",
  "confirm_failed",
] as const;
export const RuntimeUpdateReason = z.enum(RUNTIME_UPDATE_REASONS);

/** 心跳中的更新状态（RuntimeHeartbeat.update）。 */
export const RuntimeUpdateReport = z.strictObject({
  state: RuntimeUpdateState,
  target: LumioVersion.optional().describe("正在收敛的目标版本；current 时缺失"),
  since: Timestamp.describe("进入当前状态的时间"),
  reason: RuntimeUpdateReason.optional().describe("failed、blocked 时必有"),
  detail: z.string().max(500).optional().describe("给排查用的技术细节（如预检退出码），不含密钥与路径之外的私有内容；不翻译"),
  previous: LumioVersion.optional().describe("回退后报告 failed 时，回退到的版本"),
}).superRefine((report, ctx) => {
  if (report.state === "current" ? report.target !== undefined : report.target === undefined) {
    ctx.addIssue({ code: "custom", path: ["target"], message: "只有 current 不带 target，其他状态必须带 target" });
  }
  if ((report.state === "failed" || report.state === "blocked") !== (report.reason !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "failed 与 blocked 必须带 reason，其他状态不带" });
  }
});

/**
 * 同步回复中的期望版本（RuntimeSync.update），只发给声明了 self_update 的 Runtime。
 * 人的动作以请求 ID 表达：Runtime 对同一个 ID 只执行一次（记住最近处理过的 ID）。
 */
export const RuntimeUpdateDirective = z.strictObject({
  version: LumioVersion.describe("期望版本；与 Runtime 当前版本相同时不做任何事"),
  hold: z.boolean().describe("人选择了暂缓这个版本：可以继续下载和预检，但不排空、不切换；期望版本变化时由 Hub 清除"),
  restart_now: RequestId.optional().describe("人要求立即切换（会中断进行中的工作，中断的轮次为 unknown）"),
  retry: RequestId.optional().describe("人要求重试这个已失败的版本"),
});

/** 发布清单中的一个平台压缩包。 */
export const ReleaseArtifact = z.strictObject({
  platform: RuntimePlatform,
  file: z.string().regex(/^lumio-(darwin-arm64|linux-x64|linux-arm64)\.tar\.gz$/),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).refine((artifact) => artifact.file === `lumio-${artifact.platform}.tar.gz`, { path: ["file"], message: "文件名必须是 lumio-<platform>.tar.gz" });

/**
 * 发布清单 manifest.json（ADR 0063 第 3 节）。签名为同目录 manifest.sig：对清单原始字节的 Ed25519 签名（base64）。
 * release：CI 用正式发布密钥签名；dev：deploy-local 用部署者的构建密钥签名，远端默认不信任。
 */
export const ReleaseManifest = z.strictObject({
  format: z.literal(1),
  version: LumioVersion,
  channel: z.enum(["release", "dev"]),
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  created: Timestamp,
  artifacts: z.array(ReleaseArtifact).min(1),
}).superRefine((manifest, ctx) => {
  const seen = new Set<string>();
  manifest.artifacts.forEach((artifact, index) => {
    if (seen.has(artifact.platform)) ctx.addIssue({ code: "custom", path: ["artifacts", index, "platform"], message: "同一平台只能出现一次" });
    seen.add(artifact.platform);
  });
  if ((manifest.channel === "dev") !== /-dev\./.test(manifest.version)) {
    ctx.addIssue({ code: "custom", path: ["channel"], message: "dev 渠道的版本必须带 -dev. 后缀，release 渠道的版本不能带" });
  }
});

/** RuntimeInfo.update：Hub 眼中这台 Runtime 的更新情况。 */
export const RuntimeUpdateView = z.strictObject({
  policy: RuntimeUpdatePolicy,
  desired: LumioVersion.optional().describe("Hub 当前下发的期望版本；manual 或不支持自更新时缺失"),
  hold: z.boolean().describe("人是否暂缓了当前期望版本"),
  report: RuntimeUpdateReport.optional().describe("最近一次心跳报告的状态；旧 Runtime 没有"),
});

const RuntimeVersionArgs = { runtime: RuntimeName, version: LumioVersion.describe("人看到的目标版本；与 Hub 当前期望版本不一致时 CONFLICT") };

/** 人对 Runtime 更新的操作（只授予 human，记审计）。 */
export const ExecutionRuntimeUpdateCommand = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("execution.runtime.update.policy"), args: z.strictObject({ runtime: RuntimeName, policy: RuntimeUpdatePolicy }) }),
  z.strictObject({ op: z.literal("execution.runtime.update.hold"), args: z.strictObject({ ...RuntimeVersionArgs, hold: z.boolean() }) }),
  z.strictObject({ op: z.literal("execution.runtime.update.restart_now"), args: z.strictObject(RuntimeVersionArgs) }),
  z.strictObject({ op: z.literal("execution.runtime.update.retry"), args: z.strictObject(RuntimeVersionArgs) }),
]);

export const ExecutionRuntimeUpdateCommandRequest = z.strictObject({
  request_id: RequestId,
  operation: ExecutionRuntimeUpdateCommand,
});

export type LumioVersion = z.infer<typeof LumioVersion>;
export type RuntimePlatform = z.infer<typeof RuntimePlatform>;
export type RuntimeInstall = z.infer<typeof RuntimeInstall>;
export type RuntimeUpdatePolicy = z.infer<typeof RuntimeUpdatePolicy>;
export type RuntimeUpdateState = z.infer<typeof RuntimeUpdateState>;
export type RuntimeUpdateReason = z.infer<typeof RuntimeUpdateReason>;
export type RuntimeUpdateReport = z.infer<typeof RuntimeUpdateReport>;
export type RuntimeUpdateDirective = z.infer<typeof RuntimeUpdateDirective>;
export type ReleaseArtifact = z.infer<typeof ReleaseArtifact>;
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;
export type RuntimeUpdateView = z.infer<typeof RuntimeUpdateView>;
export type ExecutionRuntimeUpdateCommand = z.infer<typeof ExecutionRuntimeUpdateCommand>;
export type ExecutionRuntimeUpdateCommandRequest = z.infer<typeof ExecutionRuntimeUpdateCommandRequest>;

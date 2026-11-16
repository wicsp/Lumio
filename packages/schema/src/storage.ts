import { z } from "zod";
import { Id, SafeRelativePath, Sha256, Timestamp, idOf } from "./common.ts";
import { ResourceRef } from "./work.ts";

/**
 * 存储格式契约（ADR 0025 第 3、5、6、8 节，R0-1）：JSONL 运行日志、托管文件、备份清单。
 * 这些是文件格式而不是业务对象，各自独立的 schema_version 从 1 开始。
 */

/**
 * 自有 JSONL 日志的一行（ADR 0025 第 6 节）。每个日志流单写入者；sequence 在同一个 run 内从 1 开始连续递增，
 * 读取方据此区分缺行与重复。原始 agent 输出另存，不伪装成这个格式。
 */
export const RunLogEvent = z.strictObject({
  schema_version: z.literal(1),
  id: idOf("evt"),
  run: Id.describe("所属运行，如 job_… 或 turn_…"),
  sequence: z.number().int().positive().describe("运行内顺序，从 1 开始连续递增"),
  time: Timestamp,
  type: z.string().min(1).describe("事件类型，如 output、tool、status"),
  payload: z.record(z.string(), z.unknown()).describe("按 type 校验的负载"),
});

/** Hub 的跨模块协调数据。 */
export const HubRef = z.strictObject({ module: z.literal("hub"), id: z.union([idOf("cap"), idOf("gln")]) });
export const ArtifactOwner = z.union([ResourceRef, HubRef]);

/**
 * 托管文件（ADR 0025 第 5 节）：先写 staged，校验 sha256/size 后才改为 ready；
 * 数据库只把 ready 当作可用产物，staged 可重试登记或清理。
 */
export const StoredArtifact = z.strictObject({
  id: idOf("art"),
  owner: ArtifactOwner.describe("文件属于哪个对象"),
  key: SafeRelativePath.describe("相对 Hub 托管文件目录的路径"),
  sha256: Sha256,
  size: z.number().int().nonnegative(),
  media_type: z.string().min(1).describe("MIME 类型，如 text/plain"),
  status: z.enum(["staged", "ready"]),
  private: z.boolean().describe("来源私密；按私密规则处理"),
  created: Timestamp,
});

const FileDigest = z.strictObject({ path: SafeRelativePath, sha256: Sha256, size: z.number().int().nonnegative() });

/** 业务备份的校验清单：数据库一致性快照与它引用的托管文件；路径相对备份目录。 */
export const BackupManifest = z.strictObject({
  schema_version: z.literal(1),
  created: Timestamp,
  database: FileDigest,
  files: z.array(FileDigest),
});

export type RunLogEvent = z.infer<typeof RunLogEvent>;
export type StoredArtifact = z.infer<typeof StoredArtifact>;
export type BackupManifest = z.infer<typeof BackupManifest>;
export type HubRef = z.infer<typeof HubRef>;
export type ArtifactOwner = z.infer<typeof ArtifactOwner>;

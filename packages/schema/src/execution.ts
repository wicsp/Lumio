import { z } from "zod";
import { AgentTarget, RequestId, Revision, RuntimeName, Timestamp, idOf } from "./common.ts";
import { CRON_PATTERN } from "./entities.ts";
import { JobStatus } from "./job.ts";

/**
 * Execution 模块契约 v2（ADR 0025 第 1、3 节，R0-1）。
 *
 * Routine 归 Execution：计划与执行模板，数据库为权威来源，没有 path。
 * Hub ↔ Runtime 的 Job 协议（job.ts，protocol_version=2）不变；RoutineSpec 仍由 Hub 从这里组装。
 */

const Cron = z.string().regex(CRON_PATTERN, "schedule 必须是 5 段 cron 表达式，例如 0 9 * * 1");
export const RoutineStatus = z.enum(["active", "paused"]);
export const RoutineContext = z.enum(["none", "previous"]);

const RunConfigShape = {
  workdir: z.string().min(1).optional().describe("执行器上的工作目录（缺省 ~）"),
  model: z.string().min(1).optional(),
  gpus: z.array(z.number().int().nonnegative()).optional(),
  timeout_minutes: z.number().int().positive().optional(),
};

/** 例行任务（v2）。 */
export const ExecutionRoutine = z.strictObject({
  schema_version: z.literal(2),
  id: idOf("rtn"),
  title: z.string().min(1),
  description: z.string().describe("每次执行时交给 agent 的说明"),
  revision: Revision,
  status: RoutineStatus,
  schedule: Cron,
  timezone: z.string().min(1).describe("IANA 时区；创建时缺省由应用填 Hub 所在机器的时区，存储后总是有值"),
  assignee: AgentTarget,
  context: RoutineContext.describe("previous：带上上一次结果的摘要"),
  created: Timestamp,
  updated: Timestamp,
  ...RunConfigShape,
});

/** v2 的 `routine list` 一项：与 v1 RoutineInfo 同义，但 routine 是完整对象而不是 NoteRef。 */
export const ExecutionRoutineInfo = z.strictObject({
  routine: ExecutionRoutine,
  runtime: RuntimeName.optional().describe("计划交给了哪个执行器；没有生效时缺失"),
  next: Timestamp.optional().describe("下一次计划触发时间"),
  last: z.strictObject({ job: idOf("job"), status: JobStatus, fired_at: Timestamp }).optional(),
  problem: z.string().optional().describe("计划没有生效的原因"),
});

export const ExecutionRoutinePatch = z
  .strictObject({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: RoutineStatus.optional(),
    schedule: Cron.optional(),
    timezone: z.string().min(1).optional(),
    assignee: AgentTarget.optional(),
    context: RoutineContext.optional(),
    workdir: RunConfigShape.workdir.unwrap().nullable().optional().describe("null：清空"),
    model: RunConfigShape.model.unwrap().nullable().optional(),
    gpus: RunConfigShape.gpus.unwrap().nullable().optional(),
    timeout_minutes: RunConfigShape.timeout_minutes.unwrap().nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "patch 不能为空");

export const ExecutionRoutineCreate = z.strictObject({
  op: z.literal("execution.routine.create"),
  args: z.strictObject({
    title: z.string().min(1),
    description: z.string().optional().describe("缺省为空字符串"),
    status: RoutineStatus.optional().describe("缺省 active"),
    schedule: Cron,
    timezone: z.string().min(1).optional().describe("缺省由应用填 Hub 所在机器的时区"),
    assignee: AgentTarget,
    context: RoutineContext.optional().describe("缺省 none"),
    ...RunConfigShape,
  }),
});

export const ExecutionRoutineUpdate = z.strictObject({
  op: z.literal("execution.routine.update"),
  args: z.strictObject({ routine: idOf("rtn"), expected_revision: Revision, patch: ExecutionRoutinePatch }),
});

export const ExecutionRoutineCommand = z.discriminatedUnion("op", [ExecutionRoutineCreate, ExecutionRoutineUpdate]);

export const ExecutionRoutineCommandRequest = z.strictObject({
  request_id: RequestId,
  operation: ExecutionRoutineCommand,
});

export type RoutineStatus = z.infer<typeof RoutineStatus>;
export type RoutineContext = z.infer<typeof RoutineContext>;
export type ExecutionRoutine = z.infer<typeof ExecutionRoutine>;
export type ExecutionRoutineInfo = z.infer<typeof ExecutionRoutineInfo>;
export type ExecutionRoutinePatch = z.infer<typeof ExecutionRoutinePatch>;
export type ExecutionRoutineCommand = z.infer<typeof ExecutionRoutineCommand>;
export type ExecutionRoutineCommandRequest = z.infer<typeof ExecutionRoutineCommandRequest>;

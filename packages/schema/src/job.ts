import { z } from "zod";
import { AGENTS, AgentTarget, Timestamp, RuntimeName, idOf } from "./common.ts";
import { NoteRef } from "./query.ts";
import { JobAccess } from "./access.ts";
import { PlanHook, StagePermissions } from "./plan.ts";
import { LumioVersion, RuntimeInstall, RuntimePlatform, RuntimeUpdateDirective, RuntimeUpdateReport, RuntimeUpdateView } from "./runtime-update.ts";

/**
 * Hub ↔ 执行器（Runtime）的协议（ADR 0005、ADR 0019）。
 *
 * - 一个 Job 就是"一轮"：为某个任务（或例行任务的某一次）执行一次，**不自动重试**；想重试由人派出新的一轮。
 * - Job 一旦被执行器确认收到，就归它负责；Hub 只接受被指派的执行器、带着正确 lease 的回报。
 * - 由执行器主动连接 Hub（轮询），Hub 不主动连接执行器。
 * - 协议是严格对象：未知字段拒绝。
 */
export const JOB_PROTOCOL_VERSION = 2;

export { RuntimeName } from "./common.ts";

/**
 * agent 的隔离级别，由适配器如实声明（ADR 0019 第 7 节）。
 * os：agent 自带的系统级沙箱已启用（如 Codex 的 workspace-write）；none：没有沙箱，能以执行器账号做任何事。
 */
export const SandboxLevel = z.enum(["os", "none"]);

/** 会话标识：由 Hub 生成（如 pi 的 --session-id），或由 agent 返回（如 Codex）。 */
export const SessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

/** 交给某个 agent，用非交互模式执行一次。 */
export const AgentRun = z.strictObject({
  kind: z.literal("agent"),
  engine: z.enum(AGENTS),
  model: z.string().min(1).optional(),
  prompt: z.string().min(1).describe("Hub 组装好的完整输入：任务内容、你新写的部分、固定说明"),
  session: z
    .strictObject({ id: SessionId, resume: z.boolean().describe("true：接着这个会话继续；false：用这个 ID 新建") })
    .optional(),
  permissions: StagePermissions.optional().describe("这一轮的权限（ADR 0049 第 3 节）；缺失按缺省（write、不写 Git、无密钥）。只发给登记了 stage_permissions 的执行器"),
  hooks: z.strictObject({ before: PlanHook.optional(), after: PlanHook.optional() }).optional()
    .describe("这一轮前后的钩子（ADR 0049 第 4 节）。只发给登记了 hooks 的执行器"),
});

/** 执行一条登记过的程序（P2-2 用它测试可靠性；不经过 shell）。 */
export const CommandRun = z.strictObject({
  kind: z.literal("command"),
  argv: z.array(z.string().min(1)).min(1).describe("argv[0] 必须是执行器配置中登记过的程序"),
});

export const JobRun = z.discriminatedUnion("kind", [AgentRun, CommandRun]);

/** 这一轮来自哪里。命令行直接提交的 command 任务可以没有来源。 */
export const JobSource = z.strictObject({
  task: idOf("task").optional(),
  routine: idOf("rtn").optional(),
  round: z.number().int().positive().describe("第几轮；例行任务每次触发都是第 1 轮"),
  previous: idOf("job").optional().describe("上一轮"),
  fired_at: Timestamp.optional().describe("例行任务这一次的计划触发时间"),
}).refine((s) => !(s.task && s.routine), "task 与 routine 只能有一个");

/** Hub 发给执行器的一轮工作。 */
export const JobSpec = z.strictObject({
  protocol_version: z.literal(JOB_PROTOCOL_VERSION),
  id: idOf("job"),
  source: JobSource.optional(),
  runtime: idOf("act").describe("被指派的执行器身份"),
  lease: z.string().min(16).describe("Hub 指派时生成的凭据；回报必须带上，过期或不匹配的回报被拒绝"),
  run: JobRun,
  workdir: z.string().min(1),
  gpus: z.array(z.number().int().nonnegative()).optional(),
  timeout_seconds: z.number().int().positive(),
  created: Timestamp,
});

export const JOB_STATUSES = ["queued", "assigned", "running", "done", "waiting_for_human", "failed", "unknown", "cancelled"] as const;
export const JobStatus = z.enum(JOB_STATUSES);
/** 一轮的最终结果。unknown：执行器中途重启，无法确认做到了哪一步，交给人（ADR 0005）。 */
export const FinalJobStatus = z.enum(["done", "waiting_for_human", "failed", "unknown", "cancelled"]);

export const GitState = z.strictObject({
  branch: z.string().optional(),
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  dirty: z.boolean().describe("是否有未提交的改动"),
});

/** 执行器交回的结果。同一个结果交回多次，Hub 只记一次。 */
export const JobResult = z.strictObject({
  job: idOf("job"),
  lease: z.string().min(16),
  status: FinalJobStatus,
  started: Timestamp.optional(),
  finished: Timestamp,
  exit_code: z.number().int().optional(),
  signal: z.string().optional(),
  engine: z
    .strictObject({ name: z.enum(AGENTS), version: z.string().min(1), sandbox: SandboxLevel })
    .optional()
    .describe("实际使用的 agent、版本与隔离级别"),
  report: z.string().optional().describe("agent 最后的汇报原文"),
  question: z.string().optional().describe("status 为 waiting_for_human 时，agent 提的问题"),
  privileged_unavailable: z.strictObject({ program: z.string().min(1).max(512) }).optional()
    .describe("这一轮里 agent 请求过高权限命令，但执行器没有配置高权限助手；只记第一次请求的程序（不含参数），用于提示人去安装"),
  permission: StagePermissions.optional()
    .describe("status 为 waiting_for_human 时，agent 申请的权限（汇报里的 <lumio-permission>，ADR 0049 第 3 节）；理由在 report 中"),
  session_id: SessionId.optional().describe("下一轮接着这个会话继续"),
  git: z.strictObject({ before: GitState.optional(), after: GitState.optional() }).optional(),
  log: z.string().optional().describe("完整日志在执行器上的路径"),
  error: z.string().optional().describe("给人看的失败原因；不含密钥"),
});

/** Hub 里一轮 Job 的完整记录（`lumio job show --json`）。 */
export const Job = z.strictObject({
  spec: JobSpec,
  status: JobStatus,
  assigned: Timestamp.optional().describe("执行器确认收到的时间"),
  last_seen: Timestamp.optional().describe("执行器最近一次报告这一轮仍在运行的时间"),
  result: JobResult.optional(),
});

// ───────────────────────── 执行器登记与同步 ─────────────────────────

/**
 * 执行器可选能力（ADR 0049）：按阶段权限启动 agent、运行钩子、提取权限申请；
 * privileged_helper：已配置高权限助手（ADR 0020），人可在设置里看到哪台执行器还没装。
 * self_update：能按 Hub 的期望版本自更新（ADR 0063）；声明它时必须同时登记 version、platform、install。
 */
export const RUNTIME_FEATURES = ["stage_permissions", "hooks", "permission_request", "privileged_helper", "self_update"] as const;

/**
 * 执行器启动时登记自己的能力。
 * 新执行器遇到旧 Hub（例如 Hub 回退了版本）时，登记可能因未知字段被拒绝（400）；
 * 这时执行器去掉 version、platform、install 与 Hub 不认识的 features 再登记一次（ADR 0063 第 6 节）。
 */
export const RuntimeRegistration = z.strictObject({
  protocol_version: z.literal(JOB_PROTOCOL_VERSION),
  name: RuntimeName,
  engines: z.array(z.strictObject({ name: z.enum(AGENTS), version: z.string().min(1), sandbox: SandboxLevel })),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,63}$/)).describe('人配置的标签，如 "gpu:4"'),
  max_concurrent: z.number().int().positive(),
  features: z.array(z.enum(RUNTIME_FEATURES)).optional()
    .describe("执行器支持的可选能力；Hub 只把对应字段发给声明了它的执行器（ADR 0049）。缺失表示都不支持"),
  version: LumioVersion.optional().describe("执行器程序版本（ADR 0063）；旧执行器没有"),
  platform: RuntimePlatform.optional().describe("执行器所在平台，决定下载哪个压缩包"),
  install: RuntimeInstall.optional().describe("安装方式，由执行器自己判断（ADR 0063 第 2 节）"),
}).refine((registration) => !registration.features?.includes("self_update")
  || (registration.version !== undefined && registration.platform !== undefined && registration.install !== undefined),
{ path: ["features"], message: "声明 self_update 时必须登记 version、platform 与 install" });

/** `lumio runtime list` / `GET /v1/runtimes` 的一项：Hub 记录的执行器。 */
export const RuntimeInfo = z.strictObject({
  actor: idOf("act"),
  registration: RuntimeRegistration,
  last_seen: Timestamp,
  online: z.boolean().describe("最近 3 分钟内轮询过 Hub；否则显示为失联"),
  update: RuntimeUpdateView.optional().describe("版本与自动更新情况（ADR 0063）；旧 Hub 没有"),
});

/**
 * 可委派的目标（ADR 0033）：某个执行器上登记的一个引擎。`execution.target.list` 返回它；
 * 委派的 `to` 与交接计划 agent 步骤的 `agent` 必须是其中之一（不带 @ 的写法指 Hub 所在机器的执行器）。
 */
export const ExecutionTarget = z.strictObject({
  target: AgentTarget.describe("委派时使用的写法，如 codex@macsp"),
  runtime: RuntimeName.describe("执行器名"),
  engine: z.enum(AGENTS),
  version: z.string().min(1),
  online: z.boolean().describe("离线的目标仍可委派，这一轮会在它上线后开始"),
});
export const ExecutionTargetListArgs = z.strictObject({ online: z.boolean().optional().describe("true：只列在线的目标") });

/** 例行任务交给执行器的计划（ADR 0019 第 6 节）。Hub 离线时执行器照此自行触发。 */
export const RoutineSpec = z.strictObject({
  routine: idOf("rtn"),
  revision: z.string().min(1).describe("例行任务笔记的版本；变了就替换"),
  schedule: z.string().min(1),
  timezone: z.string().min(1),
  lease: z.string().min(16).describe("这份计划的凭据；由它触发的每一轮回报都带上它"),
  template: z.strictObject({
    run: AgentRun,
    workdir: z.string().min(1),
    gpus: z.array(z.number().int().nonnegative()).optional(),
    timeout_seconds: z.number().int().positive(),
  }),
});

/** `lumio routine list` / `GET /v1/routines` 的一项：Hub 眼中的例行任务（P2-5）。 */
export const RoutineInfo = z.strictObject({
  routine: NoteRef,
  schedule: z.string(),
  timezone: z.string(),
  status: z.enum(["active", "paused"]),
  runtime: RuntimeName.optional().describe("计划交给了哪个执行器；没有生效时缺失"),
  next: Timestamp.optional().describe("下一次计划触发时间（暂停或计划没有生效时缺失）"),
  last: z.strictObject({ job: idOf("job"), fired_at: Timestamp, status: JobStatus }).optional().describe("最近一次"),
  problem: z.string().optional().describe("计划没有生效的原因，如缺少 workdir、没有可用的执行器"),
});

/** 执行器每次轮询时报告的状态（同时也是心跳）。 */
export const RuntimeHeartbeat = z.strictObject({
  running: z.array(idOf("job")),
  queued: z.array(idOf("job")),
  outbox: z.number().int().nonnegative().describe("还没交回的结果数"),
  update: RuntimeUpdateReport.optional().describe("自更新进度（ADR 0063）；只在 Hub 的同步回复带过 update 之后报告"),
});

/** Hub 对轮询的回复：新指派的活、要取消的活、当前全部例行任务计划。 */
export const RuntimeSync = z.strictObject({
  jobs: z.array(JobSpec),
  cancel: z.array(idOf("job")),
  routines: z.array(RoutineSpec),
  access: z.array(JobAccess).optional().describe(
    "本次新指派的各轮的访问凭据（ADR 0029 第 5 节）。只在执行器的同步请求带有 X-Lumio-Features: job-access 头时出现，"
    + "这样旧执行器不会遇到它不认识的字段。执行器把它与 Job 一起存进本地私有队列，只交给该轮的 agent 进程",
  ),
  update: RuntimeUpdateDirective.optional().describe(
    "期望版本（ADR 0063）。只发给登记了 self_update 的执行器；策略为 manual 时缺失。"
    + "执行器收到过它，才在之后的心跳里带 update，避免旧 Hub 遇到不认识的字段",
  ),
});

/** 执行器确认已把这些 Job 写进本地队列（先写本地，再确认）。 */
export const RuntimeAck = z.strictObject({ accepted: z.array(idOf("job")) });

export type JobSpec = z.infer<typeof JobSpec>;
export type JobRun = z.infer<typeof JobRun>;
export type AgentRun = z.infer<typeof AgentRun>;
export type CommandRun = z.infer<typeof CommandRun>;
export type GitState = z.infer<typeof GitState>;
export type JobStatus = z.infer<typeof JobStatus>;
export type JobResult = z.infer<typeof JobResult>;
export type Job = z.infer<typeof Job>;
export type RuntimeRegistration = z.infer<typeof RuntimeRegistration>;
export type RuntimeInfo = z.infer<typeof RuntimeInfo>;
export type ExecutionTarget = z.infer<typeof ExecutionTarget>;
export type ExecutionTargetListArgs = z.infer<typeof ExecutionTargetListArgs>;
export type RoutineSpec = z.infer<typeof RoutineSpec>;
export type RoutineInfo = z.infer<typeof RoutineInfo>;
export type RuntimeHeartbeat = z.infer<typeof RuntimeHeartbeat>;
export type RuntimeSync = z.infer<typeof RuntimeSync>;
export type RuntimeAck = z.infer<typeof RuntimeAck>;

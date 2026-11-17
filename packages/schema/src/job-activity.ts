import { z } from "zod";
import { AGENTS, idOf, RequestId, Timestamp } from "./common.ts";
import { JobStatus, SessionId, SandboxLevel } from "./job.ts";

export const JOB_ACTIVITY_FEATURE = "job-activity";
export const JOB_ACTIVITY_MAX_BODY = 256 * 1024;
export const JOB_ACTIVITY_BATCH = 64;
const jobId = idOf("job");
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z.string().min(1).max(240);
const token = z.string().min(1).max(128);
const phase = z.enum(["preparing", "before_hook", "engine", "after_hook", "finishing"]);
const tool = z.strictObject({
  id: token, kind: z.enum(["command", "files", "tool", "search"]), label, files: z.array(label).max(20).optional(),
});
const isOutcome = z.enum(["completed", "failed", "declined", "unknown"]);
const requestClosed = z.enum(["answered", "approved", "denied", "expired", "cancelled", "unknown"]);
const event = { at: Timestamp };
export const JobActivityEvent = z.discriminatedUnion("type", [
  z.strictObject({ ...event, type: z.literal("phase"), phase }),
  z.strictObject({ ...event, type: z.literal("tool_started"), tool }),
  z.strictObject({ ...event, type: z.literal("tool_finished"), tool, outcome: isOutcome }),
  z.strictObject({ ...event, type: z.literal("engine"), activity: z.enum(["started", "responded", "plan_updated", "retrying"]) }),
  z.strictObject({ ...event, type: z.literal("error"), category: z.enum(["engine", "hook", "output", "control"]) }),
  z.strictObject({ ...event, type: z.literal("omitted") }),
  z.strictObject({ ...event, type: z.literal("request_opened"), prompt_id: token }),
  z.strictObject({ ...event, type: z.literal("request_closed"), prompt_id: token, outcome: requestClosed }),
]);
export const JobActivityRecord = z.strictObject({ sequence: seq.positive(), event: JobActivityEvent });
export const JobActivityPage = z.strictObject({
  first_available: seq.positive().nullable(), next_after: seq, has_more: z.boolean(), gap: z.boolean(), events: z.array(JobActivityRecord).max(200),
});
export const JobActivityQuery = z.strictObject({ after: seq.default(0), limit: z.number().int().min(1).max(200).default(100) });

export const JobControlTarget = z.strictObject({ instance: token, session: SessionId, turn: token });
const prompt = { id: token, target: JobControlTarget, expires: Timestamp };
export const JobHumanRequest = z.discriminatedUnion("kind", [
  z.strictObject({ ...prompt, kind: z.literal("approval"), tool: label, preview: z.string().min(1).max(8192),
    reason: z.string().max(1024).optional(), can_approve: z.boolean(), sandbox: SandboxLevel }),
  z.strictObject({ ...prompt, kind: z.literal("question"), questions: z.array(z.strictObject({
    id: token, text: z.string().min(1).max(2000), options: z.array(z.string().min(1).max(480)).max(8), multiple: z.boolean(),
  })).min(1).max(4) }),
]);
const action = { request_id: RequestId, target: JobControlTarget };
export const JobAction = z.discriminatedUnion("action", [
  z.strictObject({ ...action, action: z.literal("approve"), prompt_id: token }),
  z.strictObject({ ...action, action: z.literal("deny"), prompt_id: token }),
  z.strictObject({ ...action, action: z.literal("answer"), prompt_id: token,
    answers: z.array(z.strictObject({ question: token, values: z.array(z.string().min(1).max(2000)).min(1).max(8) })).min(1).max(4) }),
  z.strictObject({ ...action, action: z.literal("steer"), text: z.string().min(1).max(4000) }),
]);
export const JobActionReceipt = z.strictObject({
  request_id: RequestId, state: z.enum(["queued", "delivered", "applied", "rejected", "expired", "unknown"]), at: Timestamp,
});
export const JobEngineActivityCapability = z.strictObject({
  engine: z.enum(AGENTS), version: token, progress: z.boolean(), sandbox: SandboxLevel,
  approvals: z.boolean(), questions: z.boolean(), steer: z.boolean(),
});
export const JobLiveView = z.strictObject({
  job: jobId, status: JobStatus, created: Timestamp, assigned: Timestamp.nullable(), started: Timestamp.nullable(),
  last_heartbeat: Timestamp.nullable(), last_activity: Timestamp.nullable(), connected: z.boolean().nullable(),
  capability: JobEngineActivityCapability.nullable(), phase: phase.nullable(), sequence: seq,
  first_available: seq.positive().nullable(), stop_requested: z.boolean(),
  active_tools: z.array(tool).max(32), recent: z.array(JobActivityRecord).max(8),
  target: JobControlTarget.nullable(), pending: JobHumanRequest.nullable(), receipts: z.array(JobActionReceipt).max(12),
});
const jobSync = z.strictObject({
  type: z.literal("job"), job: jobId, lease: z.string().min(16).max(256), events: z.array(JobActivityRecord).max(JOB_ACTIVITY_BATCH),
  receipts: z.array(JobActionReceipt).max(JOB_ACTIVITY_BATCH), target: JobControlTarget.nullable().optional(),
  pending: JobHumanRequest.nullable().optional(),
});
export const JobActivitySync = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("register"), platform: token, engines: z.array(JobEngineActivityCapability).max(8) }),
  jobSync,
]);
export const JobActivityAck = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("registered") }),
  z.strictObject({ type: z.literal("job"), acknowledged: seq, conflict: z.boolean(), cancel: z.boolean(),
    actions: z.array(JobAction).max(8), receipts: z.array(JobActionReceipt).max(JOB_ACTIVITY_BATCH) }),
]);
export const JobAttention = z.array(z.strictObject({ job: jobId, task: idOf("task").nullable(), kind: z.enum(["approval", "question"]), expires: Timestamp })).max(100);

export const JobActivityCapabilities = z.array(z.strictObject({
  runtime: idOf("act"), name: z.string(), online: z.boolean(), engines: z.array(JobEngineActivityCapability).max(8),
}));
export type JobActivityEvent = z.infer<typeof JobActivityEvent>;
export type JobActivityRecord = z.infer<typeof JobActivityRecord>;
export type JobEngineActivityCapability = z.infer<typeof JobEngineActivityCapability>;
export type JobLiveView = z.infer<typeof JobLiveView>;
export type JobControlTarget = z.infer<typeof JobControlTarget>;
export type JobHumanRequest = z.infer<typeof JobHumanRequest>;
export type JobAction = z.infer<typeof JobAction>;
export type JobActionReceipt = z.infer<typeof JobActionReceipt>;
export type JobActivitySync = z.infer<typeof JobActivitySync>;
export type JobAttention = z.infer<typeof JobAttention>;

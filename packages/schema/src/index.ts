/**
 * @lumio/schema —— Lumio 的契约，唯一事实来源（ADR 0003）。
 *
 * 修改这里的任何导出都是契约变更：先写 ADR，人类批准后再改。
 * 其他语言使用 `bun run schema:export` 生成的 JSON Schema，不得手写对应类型。
 */
export * from "./common.ts";
export * from "./entities.ts";
export * from "./job.ts";
export * from "./query.ts";
export * from "./actor.ts";
export * from "./operation.ts";
export * from "./proposal.ts";
export * from "./api.ts";
export * from "./secrets.ts";
export * from "./privileged.ts";
export * from "./setup.ts";

import { Actor } from "./actor.ts";
import { ApiError, OperationRequest, OperationResult } from "./api.ts";
import { Asset, Experiment, Idea, Paper, Post, Project, Routine, Source, Task } from "./entities.ts";
import { Job, JobResult, JobSpec, RoutineInfo, RuntimeAck, RuntimeHeartbeat, RuntimeInfo, RuntimeRegistration, RuntimeSync } from "./job.ts";
import { Operation } from "./operation.ts";
import { PrivilegedApproval, PrivilegedReport, PrivilegedStatus } from "./privileged.ts";
import { CliConfig, ClientInvite, ClientInviteRequest, ClientJoin, ClientJoinRequest, HubSigningKey, RuntimeInvite, RuntimeInviteRequest, RuntimeJoin, RuntimeJoinRequest } from "./setup.ts";
import { Proposal } from "./proposal.ts";
import { CheckResult, LinksResult, NoteDetail, SearchResult } from "./query.ts";

/** 需要导出为 JSON Schema 的全部契约，键名即输出文件名。 */
export const CONTRACTS = {
  paper: Paper,
  idea: Idea,
  project: Project,
  task: Task,
  routine: Routine,
  experiment: Experiment,
  source: Source,
  post: Post,
  asset: Asset,
  job: Job,
  "job-spec": JobSpec,
  "job-result": JobResult,
  "runtime-registration": RuntimeRegistration,
  "runtime-info": RuntimeInfo,
  "runtime-heartbeat": RuntimeHeartbeat,
  "runtime-sync": RuntimeSync,
  "runtime-ack": RuntimeAck,
  "routine-info": RoutineInfo,
  "privileged-approval": PrivilegedApproval,
  "privileged-status": PrivilegedStatus,
  "privileged-report": PrivilegedReport,
  "cli-config": CliConfig,
  "runtime-invite-request": RuntimeInviteRequest,
  "runtime-invite": RuntimeInvite,
  "runtime-join-request": RuntimeJoinRequest,
  "runtime-join": RuntimeJoin,
  "hub-signing-key": HubSigningKey,
  "client-invite-request": ClientInviteRequest,
  "client-invite": ClientInvite,
  "client-join-request": ClientJoinRequest,
  "client-join": ClientJoin,
  "search-result": SearchResult,
  "links-result": LinksResult,
  "note-detail": NoteDetail,
  "check-result": CheckResult,
  actor: Actor,
  operation: Operation,
  "operation-request": OperationRequest,
  "operation-result": OperationResult,
  proposal: Proposal,
  "api-error": ApiError,
} as const;

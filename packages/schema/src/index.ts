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
export * from "./work.ts";
export * from "./execution.ts";
export * from "./assistant.ts";
export * from "./storage.ts";
export * from "./capabilities.ts";
export * from "./access.ts";
export * from "./plan.ts";
export * from "./notifications.ts";

import { Actor } from "./actor.ts";
import {
  AssistantChatRequest, AssistantChatResult, AssistantConversation, AssistantConversationDetail, AssistantEvent,
  AssistantMemoryCommandRequest, AssistantMemoryCommandResult,
  AssistantMemory, AssistantMessage, AssistantModelRequest, AssistantModelResponse, AssistantToolCall, AssistantTurn,
  AssistantConfigUpdate, AssistantConfigView,
} from "./assistant.ts";
import { AgentInfo, AgentRevokeRequest, AgentTokenIssued, AgentTokenRequest, JobAccess } from "./access.ts";
import { CapabilityChange } from "./capabilities.ts";
import { HandoffPlan, PlanRun, PlanTemplate } from "./plan.ts";
import { NotificationEvent, PushDevice, PushDeviceUpdate, PushPublicKey, PushSubscriptionInput, PushTestResult } from "./notifications.ts";
import { ExecutionRoutine, ExecutionRoutineCommandRequest, ExecutionRoutineInfo } from "./execution.ts";
import { BackupManifest, MigrationPlan, RunLogEvent, StoredArtifact } from "./storage.ts";
import {
  ResourceRef, TaskTurnChange, Turn, WorkAttention, WorkComment, WorkCommandRequest, WorkCommandResult, WorkExecution, WorkProject, WorkTask, WorkTaskDetail,
} from "./work.ts";
import { ApiError, OperationRequest, OperationResult } from "./api.ts";
import { Asset, Experiment, Idea, Paper, Post, Project, Routine, Source, Task } from "./entities.ts";
import { ExecutionTarget, Job, JobResult, JobSpec, RoutineInfo, RuntimeAck, RuntimeHeartbeat, RuntimeInfo, RuntimeRegistration, RuntimeSync } from "./job.ts";
import { Operation } from "./operation.ts";
import { PrivilegedApproval, PrivilegedReport, PrivilegedStatus } from "./privileged.ts";
import { CliConfig, ClientInvite, ClientInviteRequest, ClientJoin, ClientJoinRequest, HubSigningKey, RuntimeInvite, RuntimeInviteRequest, RuntimeJoin, RuntimeJoinRequest } from "./setup.ts";
import { Proposal } from "./proposal.ts";
import { CheckResult, LinksResult, NoteDetail, SearchResult } from "./query.ts";

/** 需要导出为 JSON Schema 的全部契约，键名即输出文件名。 */
import { KnowledgeTemplateRequest, KnowledgeTemplateResult, PaperResolveRequest, PaperResolveResult, KnowledgeCreateRequest, KnowledgeCreateResult } from "./knowledge-authoring.ts";

export const CONTRACTS = {
  "knowledge-template-request": KnowledgeTemplateRequest,
  "knowledge-template-result": KnowledgeTemplateResult,
  "paper-resolve-request": PaperResolveRequest,
  "paper-resolve-result": PaperResolveResult,
  "knowledge-create-request": KnowledgeCreateRequest,
  "knowledge-create-result": KnowledgeCreateResult,
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
  "execution-target": ExecutionTarget,
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
  // v2 业务对象（ADR 0025，R0-1）
  "resource-ref": ResourceRef,
  "work-project": WorkProject,
  "work-task": WorkTask,
  "work-comment": WorkComment,
  "work-execution": WorkExecution,
  "work-task-detail": WorkTaskDetail,
  "work-command-request": WorkCommandRequest,
  "work-command-result": WorkCommandResult,
  "execution-routine": ExecutionRoutine,
  "execution-routine-info": ExecutionRoutineInfo,
  "execution-routine-command-request": ExecutionRoutineCommandRequest,
  "assistant-conversation": AssistantConversation,
  "assistant-message": AssistantMessage,
  "assistant-turn": AssistantTurn,
  "assistant-tool-call": AssistantToolCall,
  "assistant-memory": AssistantMemory,
  "assistant-chat-request": AssistantChatRequest,
  "assistant-conversation-detail": AssistantConversationDetail,
  "assistant-chat-result": AssistantChatResult,
  "assistant-model-request": AssistantModelRequest,
  "assistant-model-response": AssistantModelResponse,
  "assistant-event": AssistantEvent,
  "assistant-memory-command-request": AssistantMemoryCommandRequest,
  "assistant-memory-command-result": AssistantMemoryCommandResult,
  "run-log-event": RunLogEvent,
  "stored-artifact": StoredArtifact,
  "backup-manifest": BackupManifest,
  "migration-plan": MigrationPlan,
  // 能力目录与 agent 访问（ADR 0029，R3-1）；各能力的参数与结果 schema 由 CAPABILITIES 导出
  "capability-change": CapabilityChange,
  "work-attention": WorkAttention,
  "assistant-config-view": AssistantConfigView,
  "assistant-config-update": AssistantConfigUpdate,
  "job-access": JobAccess,
  "agent-token-request": AgentTokenRequest,
  "agent-token-issued": AgentTokenIssued,
  "agent-info": AgentInfo,
  "agent-revoke-request": AgentRevokeRequest,
  // 任务模型 v3、交接计划与通知（ADR 0031、0032，R4-1、R4-1b）
  turn: Turn,
  "task-turn-change": TaskTurnChange,
  "handoff-plan": HandoffPlan,
  "plan-run": PlanRun,
  "plan-template": PlanTemplate,
  "notification-event": NotificationEvent,
  "push-subscription-input": PushSubscriptionInput,
  "push-device": PushDevice,
  "push-device-update": PushDeviceUpdate,
  "push-public-key": PushPublicKey,
  "push-test-result": PushTestResult,
} as const;

export * from "./knowledge-authoring.ts";

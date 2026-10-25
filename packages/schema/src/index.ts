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

import { Actor } from "./actor.ts";
import { ApiError, OperationRequest, OperationResult } from "./api.ts";
import { Asset, Experiment, Idea, Paper, Post, Project, Source, Task } from "./entities.ts";
import { Job } from "./job.ts";
import { Operation } from "./operation.ts";
import { Proposal } from "./proposal.ts";
import { CheckResult, LinksResult, NoteDetail, SearchResult } from "./query.ts";

/** 需要导出为 JSON Schema 的全部契约，键名即输出文件名。 */
export const CONTRACTS = {
  paper: Paper,
  idea: Idea,
  project: Project,
  task: Task,
  experiment: Experiment,
  source: Source,
  post: Post,
  asset: Asset,
  job: Job,
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

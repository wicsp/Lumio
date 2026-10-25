import { readFile } from "node:fs/promises";
import {
  appendRelatedId, CoreError, openVaultGit, parseFrontmatter, showNote, vaultFileAt, writeFileAtomic,
  type WriteOptions,
} from "@lumio/core";
import { Actor, OperationRequest, OperationResult, Proposal, ProposalStatus, textContainsCardNumber, type Operation } from "@lumio/schema";
import { authorize } from "./authorize.ts";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";

export interface OperationOptions { beforeCommit?: WriteOptions["beforeCommit"] }

// Both direct operations and accepted proposals use the same checked writer.
async function prepare(config: HubConfig, operation: Operation, identity: Identity) {
  const query = { stateDir: config.stateDir, includePrivate: identity.actor.role === "human" };
  try {
    const from = await showNote(config.vault, operation.args.from, query);
    const to = await showNote(config.vault, operation.args.to, query);
    if (!from.note.id || !to.note.id || from.note.id === to.note.id) throw new HubError("INVALID", "链接需要两篇不同且有 ID 的笔记");
    const file = await vaultFileAt(config.vault, from.note.path);
    if (!file || (file.private && identity.actor.role === "agent")) throw new HubError("INVALID", "找不到笔记");
    const source = await readFile(file.path);
    const data = parseFrontmatter(source).data;
    if (data.id !== operation.args.from) throw new CoreError("FILE_CHANGED", "文件在处理中被修改，请重新运行");
    const content = appendRelatedId(source, operation.args.to);
    if (textContainsCardNumber(source.toString("utf8")) || textContainsCardNumber(content.toString("utf8"))) {
      throw new HubError("INVALID", "文件疑似含卡号，无法执行操作");
    }
    return { from, to, file, source, content };
  } catch (cause) {
    if (cause instanceof CoreError && ["NOTE_NOT_FOUND", "AMBIGUOUS_REFERENCE", "INVALID_FRONTMATTER", "UNSAFE_FRONTMATTER_EDIT"].includes(cause.code)) {
      throw new HubError("INVALID", "链接引用不存在、不唯一，或 related 不是有效列表", { operation });
    }
    throw cause;
  }
}

async function execute(config: HubConfig, operation: Operation, identity: Identity, prepared: Awaited<ReturnType<typeof prepare>>, options: OperationOptions, proposal?: Proposal) {
  const { from, to, file, source, content } = prepared;
  const git = await openVaultGit(config.vault);
  if (git && (await git.changedFiles()).includes(file.relativePath)) {
    await git.add(file.relativePath, source);
    await git.commit([file.relativePath], "lumio: auto-save 1 files");
  }
  await writeFileAtomic(file.path, content, { expectedContent: source, beforeCommit: options.beforeCommit });
  if (git && !source.equals(content)) {
    try {
      await git.add(file.relativePath, content);
      await git.commit([file.relativePath], `lumio: link.add ${from.note.title.replace(/[\r\n]/g, " ")} → ${to.note.title.replace(/[\r\n]/g, " ")}`, {
        "Lumio-Actor": proposal?.author ?? identity.actor.id,
        ...(proposal ? { "Lumio-Proposal": proposal.id, "Lumio-Approved-By": identity.actor.id } : {}),
      });
    } catch (cause) {
      // A failed git commit must not leave an uncredited operation for autosave.
      // Roll back only our own bytes; a concurrent human edit always wins.
      try {
        await writeFileAtomic(file.path, source, { expectedContent: content });
        await git.add(file.relativePath, source);
      } catch { /* Preserve the current file if someone edited it meanwhile. */ }
      throw cause;
    }
  }
}

export async function handleOperation(request: Request, kind: "operations" | "actors" | "proposals" | "proposal.accept" | "proposal.reject", proposalId: string | undefined,
  identity: Identity, store: HubStore, config: HubConfig, decide: typeof authorize, options: OperationOptions = {}): Promise<Response> {
  let operation: Operation | undefined;
  let proposal: Proposal | undefined;
  let authorization = "deny";
  let audited = false;
  const audit = (execution: string) => {
    store.audit(identity, operation ? JSON.stringify(operation) : kind, authorization, proposal?.id, execution);
    audited = true;
  };
  const check = (name: Parameters<typeof authorize>[1]["operation"]) => {
    const decision = decide(identity.actor, { operation: name });
    authorization = decision.result;
    if (decision.result === "deny") throw new HubError("FORBIDDEN", "请求未获授权", { operation, reason: decision.reason, proposal: proposal?.id });
    return decision;
  };
  try {
    if (kind === "actors") {
      if (check("actors").result !== "allow") throw new HubError("FORBIDDEN", "请求需要批准");
      return Response.json(Actor.array().parse(store.actors()));
    }
    if (kind === "proposals") {
      if (check("proposals").result !== "allow") throw new HubError("FORBIDDEN", "请求需要批准");
      const status = ProposalStatus.safeParse(new URL(request.url).searchParams.get("status") ?? "pending");
      if (!status.success) throw new HubError("INVALID", "提议状态不合法");
      return Response.json(Proposal.array().parse(store.proposals(status.data, identity.actor.role === "agent" ? identity.actor.id : undefined)));
    }
    if (kind === "operations") {
      let body: unknown;
      try { body = await request.json(); } catch { throw new HubError("INVALID", "请求体必须是 JSON"); }
      const parsed = OperationRequest.safeParse(body);
      if (!parsed.success) throw new HubError("INVALID", "操作请求不合法");
      operation = parsed.data.operation;
      const prepared = await prepare(config, operation, identity);
      if (prepared.source.equals(prepared.content)) throw new HubError("INVALID", "链接已存在", { operation });
      const decision = check(operation.op);
      if (decision.result === "needs_approval") {
        if (!parsed.data.reason) throw new HubError("INVALID", "提议必须填写理由", { operation });
        proposal = store.createProposal(operation, parsed.data.reason, identity.actor.id);
        audit("pending_approval");
        return Response.json(OperationResult.parse({ status: "pending_approval", proposal }), { status: 202 });
      }
      await execute(config, operation, identity, prepared, options);
      audit("applied");
      return Response.json(OperationResult.parse({ status: "applied", operation }));
    }
    proposal = store.proposal(proposalId!);
    operation = proposal?.operation;
    // Authorize before exposing existence or status to an agent.
    if (check(kind).result !== "allow") throw new HubError("FORBIDDEN", "请求需要批准", { operation });
    if (!proposal) throw new HubError("NOT_FOUND", "提议不存在");
    if (proposal.status !== "pending") throw new HubError("CONFLICT", "只有待批准的提议可以决定", { operation, proposal: proposal.id });
    if (kind === "proposal.accept") {
      const prepared = await prepare(config, operation!, identity);
      await execute(config, operation!, identity, prepared, options, proposal);
    }
    proposal = store.decideProposal(proposal.id, kind === "proposal.accept" ? "accepted" : "rejected", identity.actor.id);
    audit(proposal.status);
    return Response.json(Proposal.parse(proposal));
  } catch (cause) {
    if ((kind === "actors" || kind === "proposals") && authorization === "deny") store.audit(identity, kind, "deny");
    if (kind !== "actors" && kind !== "proposals" && !audited) audit(cause instanceof CoreError || cause instanceof HubError ? cause.code : "INTERNAL");
    if (cause instanceof CoreError && ["FILE_CHANGED", "WRITE_FAILED", "GIT_FAILED"].includes(cause.code)) {
      throw new HubError("CONFLICT", `文件已变化或无法安全写入、提交，请重试${proposal ? "；提议保持待批准" : ""}`, { operation, proposal: proposal?.id });
    }
    if (cause instanceof HubError) throw new HubError(cause.code, cause.message, { operation, proposal: proposal?.id, ...cause.details });
    throw cause;
  }
}

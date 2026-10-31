import type { Actor } from "@lumio/schema";

export const PAIRING_OPERATIONS = ["runtime.invite", "runtime.join", "client.invite", "client.join", "runtime.remove", "runtime.signing-key"] as const;
export type PairingOperation = typeof PAIRING_OPERATIONS[number];

export const QUERY_OPERATIONS = ["search", "show", "links", "check", "status"] as const;
export type QueryOperation = (typeof QUERY_OPERATIONS)[number];
export const EXISTING_OPERATIONS = [...QUERY_OPERATIONS, "health", "operations", "actors", "proposals", "proposal.accept", "proposal.reject", "task.dispatch", "routine.followup", "routines", "exec.privileged"] as const;
export const RUNTIME_OPERATIONS = ["runtime.register", "runtime.sync", "runtime.ack", "runtime.results", "runtimes", "runtime.privileged.status", "runtime.privileged.report"] as const;
export const JOB_OPERATIONS = ["job.submit", "jobs", "job.show", "job.cancel"] as const;
export const V2_OPERATIONS = ["work.read", "work.command", "execution.read", "execution.command", "execution.archive", "assistant.read", "assistant.chat"] as const;
export interface AuthorizationRequest { operation: (typeof EXISTING_OPERATIONS)[number] | (typeof RUNTIME_OPERATIONS)[number] | (typeof JOB_OPERATIONS)[number] | (typeof V2_OPERATIONS)[number] | PairingOperation; includePrivate?: boolean }
export type Decision = { result: "allow" } | { result: "deny"; reason: string } | { result: "needs_approval" };

// One rule table is the only place that decides access. Public health is explicit.
export const AUTHORIZATION_RULES = [
  ...(["human", "agent", "runtime"] as const).flatMap((role) => V2_OPERATIONS.flatMap((operation) => (operation === "execution.read" ? [false, true] : [false]).map((includePrivate) => ({
    role, operation, includePrivate,
    decision: (operation === "execution.archive" ? role === "runtime" : role === "human") ? { result: "allow" as const } : { result: "deny" as const, reason: "请求未获授权" },
  })))),
  ...PAIRING_OPERATIONS.flatMap((operation) => ([null, "human", "agent", "runtime"] as const).map((role) => ({
    role, operation, includePrivate: false,
    decision: (operation.endsWith(".join") ? role === null : operation === "runtime.signing-key" ? role === "runtime" : role === "human")
      ? { result: "allow" as const } : { result: "deny" as const, reason: "请求未获授权" },
  }))),
  { role: null, operation: "health", includePrivate: false, decision: { result: "allow" } },
  ...(["human", "agent"] as const).map((role) => ({ role, operation: "health", includePrivate: false, decision: { result: "allow" } } as const)),
  ...EXISTING_OPERATIONS.flatMap((operation) => [false, true].map((includePrivate) => ({
    role: "runtime", operation, includePrivate, decision: operation === "exec.privileged" && !includePrivate ? { result: "needs_approval" as const } : { result: "deny" as const, reason: "请求未获授权" },
  } as const))),
  ...(["human", "agent", "runtime"] as const).flatMap((role) => RUNTIME_OPERATIONS.map((operation) => ({
    role, operation, includePrivate: false,
    decision: (operation === "runtimes" ? role === "human" : role === "runtime")
      ? { result: "allow" as const } : { result: "deny" as const, reason: "请求未获授权" },
  }))),
  ...(["human", "agent", "runtime"] as const).flatMap((role) => JOB_OPERATIONS.map((operation) => ({
    role, operation, includePrivate: false, decision: role === "human" ? { result: "allow" as const } : { result: "deny" as const, reason: "请求未获授权" },
  }))),
  ...(["human", "agent"] as const).flatMap((role) => [
    { role, operation: "actors", includePrivate: false, decision: { result: "allow" } },
    { role, operation: "proposals", includePrivate: false, decision: { result: "allow" } },
    { role, operation: "routines", includePrivate: false, decision: { result: "allow" } },
    // 派出任务只能由人发起（ADR 0019）：AI 的汇报不能派新活。
    { role, operation: "task.dispatch", includePrivate: false,
      decision: role === "human" ? { result: "allow" as const } : { result: "deny" as const, reason: "agent-cannot-dispatch-tasks" } },
    // 从例行任务开出追问任务：新建笔记，同样只能由人发起。
    { role, operation: "routine.followup", includePrivate: false,
      decision: role === "human" ? { result: "allow" as const } : { result: "deny" as const, reason: "agent-cannot-create-tasks" } },
    // 高权限命令只能由执行器发起，人和 agent 只能查看或解释。
    { role, operation: "exec.privileged", includePrivate: false, decision: { result: "deny" as const, reason: "only-runtimes-request-privileged" } },
    ...(["proposal.accept", "proposal.reject"] as const).map((operation) => ({ role, operation, includePrivate: false,
      decision: role === "human" ? { result: "allow" as const } : { result: "deny" as const, reason: "agent-cannot-decide-proposals" } })),
  ] as const),
  ...QUERY_OPERATIONS.flatMap((operation) => [
    { role: "human", operation, includePrivate: false, decision: { result: "allow" } },
    { role: "human", operation, includePrivate: true, decision: { result: "allow" } },
    { role: "agent", operation, includePrivate: false, decision: { result: "allow" } },
    { role: "agent", operation, includePrivate: true, decision: { result: "deny", reason: "agent-cannot-read-private" } },
  ] as const),
] as const;

export function authorize(actor: Actor | null, request: AuthorizationRequest): Decision {
  const rule = AUTHORIZATION_RULES.find((rule) => rule.role === (actor?.role ?? null)
    && rule.operation === request.operation && rule.includePrivate === (request.includePrivate ?? false));
  return rule?.decision ?? { result: "deny", reason: "No matching authorization rule" };
}

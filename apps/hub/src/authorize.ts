import type { Actor } from "@lumio/schema";

export const QUERY_OPERATIONS = ["search", "show", "links", "check", "status"] as const;
export type QueryOperation = (typeof QUERY_OPERATIONS)[number];
export const EXISTING_OPERATIONS = [...QUERY_OPERATIONS, "health", "operations", "actors", "proposals", "proposal.accept", "proposal.reject", "link.add"] as const;
export const RUNTIME_OPERATIONS = ["runtime.register", "runtime.sync", "runtime.ack", "runtime.results", "runtimes"] as const;
export const JOB_OPERATIONS = ["job.submit", "jobs", "job.show", "job.cancel"] as const;
export interface AuthorizationRequest { operation: (typeof EXISTING_OPERATIONS)[number] | (typeof RUNTIME_OPERATIONS)[number] | (typeof JOB_OPERATIONS)[number]; includePrivate?: boolean }
export type Decision = { result: "allow" } | { result: "deny"; reason: string } | { result: "needs_approval" };

// One rule table is the only place that decides access. Public health is explicit.
export const AUTHORIZATION_RULES = [
  { role: null, operation: "health", includePrivate: false, decision: { result: "allow" } },
  ...(["human", "agent"] as const).map((role) => ({ role, operation: "health", includePrivate: false, decision: { result: "allow" } } as const)),
  ...EXISTING_OPERATIONS.flatMap((operation) => [false, true].map((includePrivate) => ({
    role: "runtime", operation, includePrivate, decision: { result: "deny", reason: "请求未获授权" },
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
    // 链接由人写在正文里，AI 只推荐、不写链接（ADR 0018）。link.add 仅作为审批流程的样例保留到 P2。
    { role, operation: "link.add", includePrivate: false,
      decision: role === "human" ? { result: "allow" as const } : { result: "deny" as const, reason: "agent-cannot-write-links" } },
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

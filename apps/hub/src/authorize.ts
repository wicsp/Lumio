import type { Actor } from "@lumio/schema";

export const QUERY_OPERATIONS = ["search", "show", "links", "status"] as const;
export type QueryOperation = (typeof QUERY_OPERATIONS)[number];
export interface AuthorizationRequest { operation: QueryOperation | "health" | "actors" | "proposals" | "proposal.accept" | "proposal.reject" | "link.add"; includePrivate?: boolean }
export type Decision = { result: "allow" } | { result: "deny"; reason: string } | { result: "needs_approval" };

// One rule table is the only place that decides access. Public health is explicit.
export const AUTHORIZATION_RULES = [
  { role: null, operation: "health", includePrivate: false, decision: { result: "allow" } },
  ...(["human", "agent"] as const).flatMap((role) => [
    { role, operation: "actors", includePrivate: false, decision: { result: "allow" } },
    { role, operation: "proposals", includePrivate: false, decision: { result: "allow" } },
    { role, operation: "link.add", includePrivate: false, decision: { result: role === "human" ? "allow" : "needs_approval" } },
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

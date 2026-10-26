import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  Actor,
  CheckResult,
  ApiError,
  CONTRACTS,
  Id,
  LinksResult,
  OPERATION_NAMES,
  Operation,
  OperationRequest,
  OperationResult,
  Proposal,
  SearchResult,
} from "../src/index.ts";

const U = "01J9Z3K8M2N4P6Q8R0S2T4V6W8";
const now = "2026-10-23T16:30:00+08:00";
const ref = { id: `pap_${U}`, type: "paper", title: "LightGCN", path: "papers/He_2020_LightGCN.md", citekey: "He_2020_LightGCN" };

describe("query contracts", () => {
  test("search result", () => {
    expect(SearchResult.parse({ query: "来源", hits: [{ note: ref, snippet: "…来源边界…" }], total: 1 }).total).toBe(1);
  });

  test("dangling links have no note; incoming links must resolve", () => {
    const parsed = LinksResult.parse({
      note: ref,
      outgoing: [{ source: "wikilink", target: "Missing_2020_X", dangling: true }],
      incoming: [{ source: "wikilink", target: `pap_${U}`, dangling: false, note: { ...ref, citekey: undefined, type: "idea", id: `idea_${U}` } }],
    });
    expect(parsed.outgoing[0]?.note).toBeUndefined();
    expect(LinksResult.safeParse({ note: ref, outgoing: [], incoming: [{ source: "wikilink", target: "x", dangling: true }] }).success).toBe(false);
  });

  test("check result lists dangling links with their source note", () => {
    const parsed = CheckResult.parse({ dangling: [{ from: ref, source: "wikilink", target: "Old_2020_Name" }], total: 1 });
    expect(parsed.dangling[0]?.target).toBe("Old_2020_Name");
    expect(CheckResult.safeParse({ dangling: [{ from: ref, source: "wikilink", target: "x", note: ref }], total: 1 }).success).toBe(false);
  });

  test("query contracts are strict", () => {
    expect(SearchResult.safeParse({ query: "x", hits: [], total: 0, extra: 1 }).success).toBe(false);
  });
});

describe("actor, operation and proposal contracts (ADR 0016)", () => {
  const op = { op: "task.dispatch", args: { task: `task_${U}`, trigger: "cli" } };
  const p = { id: `prop_${U}`, operation: op, reason: "两者都讨论来源标记", author: `act_${U}`, status: "pending", created: now };

  test("actor ids use the act prefix and names are restricted", () => {
    const a = { id: `act_${U}`, name: "claude-code@mac", role: "agent", created: now };
    expect(Actor.parse(a).role).toBe("agent");
    expect(Actor.safeParse({ ...a, id: `prop_${U}` }).success).toBe(false);
    expect(Actor.safeParse({ ...a, name: "Claude Code" }).success).toBe(false);
    expect(Actor.safeParse({ ...a, role: "admin" }).success).toBe(false);
  });

  test("operations are a closed, strict union", () => {
    expect(Operation.parse(op).op).toBe("task.dispatch");
    expect(OPERATION_NAMES).toEqual(["task.dispatch", "routine.followup", "exec.privileged"]);
    expect(Operation.safeParse({ op: "link.add", args: { from: `idea_${U}`, to: `pap_${U}` } }).success).toBe(false);
    expect(Operation.safeParse({ op: "note.delete", args: {} }).success).toBe(false);
    expect(Operation.safeParse({ ...op, args: { ...op.args, extra: 1 } }).success).toBe(false);
  });

  test("valid proposal stores the whole operation", () => {
    const parsed = Proposal.parse(p);
    expect(parsed.status).toBe("pending");
    expect(parsed.operation.op === "task.dispatch" && parsed.operation.args.task).toBe(`task_${U}`);
  });
  test("proposal ids use the prop prefix; author is an actor id, not a token name", () => {
    expect(Proposal.safeParse({ ...p, id: `idea_${U}` }).success).toBe(false);
    expect(Proposal.safeParse({ ...p, author: "claude-code@mac" }).success).toBe(false);
    expect(Proposal.safeParse({ ...p, decided_by: "wenbin" }).success).toBe(false);
    expect(Id.safeParse(`prop_${U}`).success).toBe(true);
  });
  test("empty reason rejected", () => expect(Proposal.safeParse({ ...p, reason: "" }).success).toBe(false));

  test("operation request: reason optional, unknown fields rejected", () => {
    expect(OperationRequest.parse({ operation: op }).reason).toBeUndefined();
    expect(OperationRequest.safeParse({ operation: op, reason: "x", author: `act_${U}` }).success).toBe(false);
  });

  test("operation result is either applied or pending_approval", () => {
    expect(OperationResult.parse({ status: "applied", operation: op }).status).toBe("applied");
    expect(OperationResult.parse({ status: "pending_approval", proposal: p }).status).toBe("pending_approval");
    expect(OperationResult.safeParse({ status: "pending_approval", operation: op }).success).toBe(false);
  });

  test("api error carries decision-support info", () => {
    const e = { error: { code: "FORBIDDEN", message: "agent 令牌不能决定提议", operation: op, reason: "agent-cannot-decide-proposals", proposal: `prop_${U}` } };
    expect(ApiError.parse(e).error.code).toBe("FORBIDDEN");
    expect(ApiError.safeParse({ error: { code: "TEAPOT", message: "x" } }).success).toBe(false);
  });
});

test("all P1 contracts export to JSON Schema", () => {
  for (const s of Object.values(CONTRACTS)) expect(() => z.toJSONSchema(s, { io: "input" })).not.toThrow();
});

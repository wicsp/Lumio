import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
   AgentInfo, AgentTokenRequest, AssistantConfigUpdate, AssistantConfigView, AssistantToolCall,
  CAPABILITIES, CAPABILITY_NAMES, CONTRACTS, CapabilityName, JobAccess, JobSpec, RuntimeSync, WorkAttention, WorkCommand, WorkCommandRequest, WorkExecution, WorkTask,
  assistantConfigReason, capability, capabilityFromTool, toolName,
} from "../src/index.ts";

const ACT = "act_01JABCDEFGHJKMNPQRSTVWXYZ0", JOB = "job_01JABCDEFGHJKMNPQRSTVWXYZ0", TASK = "task_01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = "2026-11-04T16:00:00+08:00";

describe("capability catalog (ADR 0029 §2)", () => {
  test("names are unique, well-formed, and map to valid, reversible tool names", () => {
    expect(new Set(CAPABILITY_NAMES).size).toBe(CAPABILITY_NAMES.length);
    for (const name of CAPABILITY_NAMES) {
      expect(CapabilityName.safeParse(name).success).toBe(true);
      expect(toolName(name)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(capabilityFromTool(toolName(name))?.name).toBe(name);
    }
    expect(capability("work.task.dispatch")).toBeUndefined();
  });

  test("every capability has English and Chinese summaries and exportable JSON Schemas", () => {
    for (const item of CAPABILITIES) {
      expect(item.summary.en.length).toBeGreaterThan(0);
      expect(item.summary.zh.length).toBeGreaterThan(0);
      const args = z.toJSONSchema(item.args, { io: "input" }) as { type?: string };
      expect(args.type).toBe("object");
      expect(() => z.toJSONSchema(item.result, { io: "output" })).not.toThrow();
    }
  });

  test("writes are low-risk Work commands and own-proposal withdrawal; dispatch and approval decisions are absent", () => {
    const writes = CAPABILITIES.filter((item) => item.kind === "write").map((item) => item.name).sort();
    expect(writes).toEqual(["approval.proposal.withdraw", "work.project.create", "work.project.update", "work.task.comment", "work.task.create", "work.task.hand", "work.task.update"]);
    for (const name of writes.filter(name => name.startsWith("work."))) expect(WorkCommand.options.some((option) => option.shape.op.value === name)).toBe(true);
    expect(CAPABILITY_NAMES.some((name) => /dispatch|accept|reject|routine\.(create|update)|privileged/.test(name))).toBe(false);
  });

  test("write arguments are the Work command arguments", () => {
    const create = capability("work.task.create")!;
    expect(create.args.safeParse({ title: "Renew domain", due: NOW }).success).toBe(true);
    expect(create.args.safeParse({ title: "x", unknown: 1 }).success).toBe(false);
    const update = capability("work.task.update")!;
    expect(update.args.safeParse({ task: TASK, expected_revision: 3, patch: { title: "Updated" } }).success).toBe(true);
    expect(update.args.safeParse({ task: TASK, expected_revision: 3, patch: {} }).success).toBe(false);
  });

  test("task updates cannot bypass outcome and turn commands", () => {
    for (const key of ["status", "assignee", "outcome", "turn"]) expect(capability("work.task.update")!.args.safeParse({ task: TASK, expected_revision: 3, patch: { [key]: "done" } }).success).toBe(false);
  });

  test("read arguments are strict", () => {
    expect(capability("work.task.list")!.args.safeParse({ status: "todo" }).success).toBe(true);
    expect(capability("work.task.list")!.args.safeParse({ status: "todo", include_private: true }).success).toBe(false);
    expect(capability("knowledge.note.search")!.args.safeParse({ query: "wrapper", limit: 500 }).success).toBe(false);
  });
});

describe("assistant config (ADR 0029 §7)", () => {
  test("view never carries the key", () => {
    expect(AssistantConfigView.safeParse({ base_url: "https://api.example.com/v1", model: "m", api_key_set: true, managed: true }).success).toBe(true);
    expect(AssistantConfigView.safeParse({ api_key_set: false, managed: true, api_key: "sk-x" }).success).toBe(false);
  });
  test("update follows the adapter's address rules", () => {
    const ok = { base_url: "http://127.0.0.1:8080/v1", model: "m" };
    expect(AssistantConfigUpdate.safeParse(ok).success).toBe(true);
    for (const base_url of ["https://u:p@api.example.com/v1", "https://api.example.com/v1?key=1", "https://api.example.com/v1#x", "ftp://api.example.com/v1"]) {
      expect(AssistantConfigUpdate.safeParse({ ...ok, base_url }).success).toBe(false);
    }
    expect(AssistantConfigUpdate.safeParse({ ...ok, api_key: "k", clear_api_key: true }).success).toBe(false);
    expect(assistantConfigReason("auth")).toBe("assistant-config-auth");
  });
});

describe("agent access (ADR 0029 §5–6)", () => {
  const access = { job: JOB, actor: ACT, token: "t".repeat(40), expires: NOW };
  test("per-round access travels only in RuntimeSync, not in the job spec", () => {
    expect(RuntimeSync.safeParse({ jobs: [], cancel: [], routines: [] }).success).toBe(true);
    expect(RuntimeSync.safeParse({ jobs: [], cancel: [], routines: [], access: [access] }).success).toBe(true);
    expect(JobAccess.safeParse({ ...access, token: "short" }).success).toBe(false);
    expect(Object.keys(JobSpec.shape)).not.toContain("access");
  });
  test("agent management never lists token values", () => {
    expect(AgentTokenRequest.safeParse({ name: "codex@mac" }).success).toBe(true);
    const actor = { id: ACT, name: "codex@mac", role: "agent", created: NOW };
    const info = { actor, tokens: [{ label: "laptop", created: NOW, kind: "manual" }] };
    expect(AgentInfo.safeParse(info).success).toBe(true);
    expect(AgentInfo.safeParse({ ...info, tokens: [{ ...info.tokens[0], token: "x".repeat(40) }] }).success).toBe(false);
  });
});

describe("compatibility", () => {
  test("tasks and tool calls stored before R3 still parse; new fields are accepted", () => {
    const task = { schema_version: 3, type: "task", id: TASK, title: "T", description: "", revision: 1, outcome: "open", turn: { holder: "human", reason: "todo", since: NOW },
      created: NOW, updated: NOW, tags: [], dependencies: [], references: [] };
    expect(WorkTask.safeParse(task).success).toBe(true);
    expect(WorkTask.safeParse({ ...task, created_by: ACT, updated_by: ACT }).success).toBe(true);
    const call = { id: "tool_01JABCDEFGHJKMNPQRSTVWXYZ0", turn: "turn_01JABCDEFGHJKMNPQRSTVWXYZ0", name: "work__task__update", args: {}, status: "succeeded", result: {}, created: NOW };
    expect(AssistantToolCall.safeParse(call).success).toBe(true);
    expect(AssistantToolCall.safeParse({ ...call, capability: "work.task.update", private_read: false,
      change: { capability: "work.task.update", target: TASK, before: { status: "todo" }, after_revision: 2 } }).success).toBe(true);
  });
  test("every exported contract converts to JSON Schema", () => {
    for (const schema of Object.values(CONTRACTS)) expect(() => z.toJSONSchema(schema, { io: "input" })).not.toThrow();
  });
});

describe("rounds that need the user (ADR 0030)", () => {
  test("attention items describe the latest round of a task", () => {
    const item = { task: TASK, title: "Interaction test", kind: "question", job: JOB, round: 1, agent: "pi@server", since: NOW, question: "Chinese or English?" };
    expect(WorkAttention.safeParse(item).success).toBe(true);
    expect(WorkAttention.safeParse({ ...item, kind: "waiting" }).success).toBe(false);
    expect(capability("work.attention.list")?.kind).toBe("read");
  });
  test("answer-and-continue is a dispatch with a comment; acknowledge names a round; neither is an agent capability", () => {
    const dispatch = { request_id: "req_answer_continue_01", operation: { op: "work.task.dispatch", args: { task: TASK, to: "pi@server", expected_revision: 3, comment: "中文，确认继续" } } };
    expect(WorkCommandRequest.safeParse(dispatch).success).toBe(true);
    expect(WorkCommandRequest.safeParse({ ...dispatch, operation: { ...dispatch.operation, args: { task: TASK, comment: "" } } }).success).toBe(false);
    const acknowledge = { request_id: "req_acknowledge_0001", operation: { op: "work.task.acknowledge", args: { task: TASK, round: 2 } } };
    expect(WorkCommandRequest.safeParse(acknowledge).success).toBe(false);
    expect(capability("work.task.acknowledge")).toBeUndefined();
    expect(capability("work.task.dispatch")).toBeUndefined();
  });
  test("executions stored before ADR 0030 still parse", () => {
    const execution = { task: TASK, job: JOB, round: 1, input_revision: 1, input_snapshot: "", created: NOW, applied: true };
    expect(WorkExecution.safeParse(execution).success).toBe(true);
    expect(WorkExecution.safeParse({ ...execution, acknowledged: { at: NOW, by: ACT } }).success).toBe(false);
  });
});

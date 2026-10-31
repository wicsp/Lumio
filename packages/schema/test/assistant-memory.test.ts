import { describe, expect, test } from "bun:test";
import { AssistantMemoryCommandRequest, AssistantMemoryCommandResult } from "../src/index.ts";
const U = "01J9Z3K8M2N4P6Q8R0S2T4V6W8";
const now = "2026-10-31T16:30:00+08:00";
describe("Assistant memory commands", () => {
  test("assistant.memory.remember requires non-blank content", () => {
    const req = AssistantMemoryCommandRequest.parse({
      request_id: "synthetic_memory_remember_001",
      operation: {
        op: "assistant.memory.remember",
        args: { content: "Important fact from user." },
      },
    });
    expect(req.operation.op).toBe("assistant.memory.remember");
    if (req.operation.op === "assistant.memory.remember") {
      expect(req.operation.args.content).toBe("Important fact from user.");
      expect(req.operation.args.sources).toBeUndefined();
    }
  });

  test("assistant.memory.remember rejects empty and whitespace-only content", () => {
    // 空字符串拒绝
    expect(
      AssistantMemoryCommandRequest.safeParse({
        request_id: "synthetic_memory_blank",
        operation: { op: "assistant.memory.remember", args: { content: "" } },
      }).success,
    ).toBe(false);
    // 纯空格拒绝
    expect(
      AssistantMemoryCommandRequest.safeParse({
        request_id: "synthetic_memory_spaces",
        operation: { op: "assistant.memory.remember", args: { content: "   " } },
      }).success,
    ).toBe(false);
    // 纯换行符拒绝
    expect(
      AssistantMemoryCommandRequest.safeParse({
        request_id: "synthetic_memory_newlines",
        operation: { op: "assistant.memory.remember", args: { content: "\n\n\t  \n" } },
      }).success,
    ).toBe(false);
    // 有效内容（含空白但非纯空白）允许
    const valid = AssistantMemoryCommandRequest.parse({
      request_id: "synthetic_memory_valid_whitespace",
      operation: {
        op: "assistant.memory.remember",
        args: { content: "  Valid content with spaces  \n" },
      },
    });
    if (valid.operation.op === "assistant.memory.remember") {
      expect(valid.operation.args.content).toBe("  Valid content with spaces  \n");
    }
  });

  test("assistant.memory.remember accepts valid ResourceRef sources", () => {
    const req = AssistantMemoryCommandRequest.parse({
      request_id: "synthetic_memory_with_sources",
      operation: {
        op: "assistant.memory.remember",
        args: {
          content: "Derived from user conversation.",
          sources: [
            { module: "assistant", id: `conv_${U}`, revision: "3" },
            { module: "knowledge", id: `pap_${U}`, label: "Paper title" },
          ],
        },
      },
    });
    if (req.operation.op === "assistant.memory.remember") {
      expect(req.operation.args.sources).toHaveLength(2);
    }
  });

  test("assistant.memory.remember rejects unknown fields in args", () => {
    // owner 不能作为输入
    expect(
      AssistantMemoryCommandRequest.safeParse({
        request_id: "synthetic_memory_owner_field",
        operation: {
          op: "assistant.memory.remember",
          args: { content: "Valid", owner: `act_${U}` },
        },
      }).success,
    ).toBe(false);
    // private 不能作为输入
    expect(
      AssistantMemoryCommandRequest.safeParse({
        request_id: "synthetic_memory_private_field",
        operation: {
          op: "assistant.memory.remember",
          args: { content: "Valid", private: false },
        },
      }).success,
    ).toBe(false);
  });

  test("assistant.memory.forget requires mem_ ID and is idempotent", () => {
    const req = AssistantMemoryCommandRequest.parse({
      request_id: "synthetic_memory_forget_001",
      operation: { op: "assistant.memory.forget", args: { memory: `mem_${U}` } },
    });
    expect(req.operation.op).toBe("assistant.memory.forget");
    if (req.operation.op === "assistant.memory.forget") {
      expect(req.operation.args.memory).toBe(`mem_${U}`);
    }
    // 非 mem_ 前缀拒绝
    expect(
      AssistantMemoryCommandRequest.safeParse({
        request_id: "synthetic_memory_wrong_prefix",
        operation: { op: "assistant.memory.forget", args: { memory: `task_${U}` } },
      }).success,
    ).toBe(false);
  });

  test("AssistantMemoryCommandResult discriminates memory vs forgotten", () => {
    const memoryResult = AssistantMemoryCommandResult.parse({
      kind: "memory",
      memory: {
        id: `mem_${U}`,
        owner: `act_${U}`,
        content: "New memory from user.",
        sources: [],
        private: false,
        revision: 1,
        created: now,
        updated: now,
      },
    });
    expect(memoryResult.kind).toBe("memory");
    if (memoryResult.kind === "memory") {
      expect(memoryResult.memory.revision).toBe(1);
    }

    const forgottenResult = AssistantMemoryCommandResult.parse({
      kind: "forgotten",
      memory: `mem_${U}`,
    });
    expect(forgottenResult.kind).toBe("forgotten");
    if (forgottenResult.kind === "forgotten") {
      expect(forgottenResult.memory).toBe(`mem_${U}`);
    }
  });

  test("AssistantMemoryCommandResult rejects unknown fields", () => {
    expect(
      AssistantMemoryCommandResult.safeParse({
        kind: "memory",
        memory: {
          id: `mem_${U}`,
          owner: `act_${U}`,
          content: "Test",
          sources: [],
          private: false,
          revision: 1,
          created: now,
          updated: now,
        },
        extra: "field",
      }).success,
    ).toBe(false);
  });
});

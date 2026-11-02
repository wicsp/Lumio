import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AgentTarget,
  AssistantChatRequest,
  AssistantConversation,
  AssistantMessage,
  AssistantModelRequest,
  AssistantModelResponse,
  AssistantToolCall,
  AssistantTurn,
  BackupManifest,
  ExecutionRoutine,
  ExecutionRoutineInfo,
  ID_PREFIXES,
  Job,
  MigrationEntry,
  MigrationPlan,
  RequestId,
  ResourceRef,
  RunLogEvent,
  RuntimeName,
  StoredArtifact,
  TaskAssignee,
  Timestamp,
  WorkComment,
  WorkCommandRequest,
  WorkCommandResult,
  WorkExecution,
  WorkProject,
  WorkProjectPatch,
  WorkTask,
  WorkTaskDetail,
  WorkTaskPatch,
} from "../src/index.ts";

const U = "01J9Z3K8M2N4P6Q8R0S2T4V6W8";
const now = "2026-10-31T16:30:00+08:00";

describe("v2 common types", () => {
  test("AgentTarget accepts string agent or agent@runtime", () => {
    expect(AgentTarget.parse("pi")).toBe("pi");
    expect(AgentTarget.parse("codex@server")).toBe("codex@server");
    expect(AgentTarget.safeParse("unknown").success).toBe(false);
    expect(AgentTarget.safeParse("pi@").success).toBe(false);
  });

  test("TaskAssignee adds human literal", () => {
    expect(TaskAssignee.parse("human")).toBe("human");
    expect(TaskAssignee.parse("claude-code@mac")).toBe("claude-code@mac");
    // 不接受旧的对象写法
    expect(TaskAssignee.safeParse({ agent: "pi", device: "server" }).success).toBe(false);
  });

  test("RequestId validates 16-128 chars", () => {
    expect(RequestId.parse("req-1234567890ab")).toBe("req-1234567890ab");
    expect(RequestId.safeParse("short").success).toBe(false);
    expect(RequestId.safeParse("a".repeat(129)).success).toBe(false);
  });

  test("RuntimeName still works", () => {
    expect(RuntimeName.parse("server")).toBe("server");
    expect(RuntimeName.parse("my.device-01")).toBe("my.device-01");
    expect(RuntimeName.safeParse("Invalid").success).toBe(false);
  });

  test("Timestamp still ISO+timezone", () => {
    expect(Timestamp.parse(now)).toBe(now);
    expect(Timestamp.safeParse("2026-10-31").success).toBe(false);
  });
});

describe("Work contracts", () => {
  test("ResourceRef enforces module+id prefix match", () => {
    const valid = ResourceRef.parse({
      module: "work",
      id: `${ID_PREFIXES.task}_${U}`,
      revision: "42",
      label: "Fix bug",
    });
    expect(valid.module).toBe("work");
    // id 前缀不属于 module 时拒绝
    expect(ResourceRef.safeParse({ module: "work", id: `${ID_PREFIXES.paper}_${U}` }).success).toBe(false);
  });

  test("WorkProject is strict v2 object", () => {
    const prj = WorkProject.parse({
      schema_version: 2,
      type: "project",
      id: `${ID_PREFIXES.project}_${U}`,
      title: "Refactor",
      description: "Four-module architecture.",
      revision: 1,
      status: "active",
      created: now,
      updated: now,
      tags: ["backend"],
      goal: "Clean boundaries",
    });
    expect(prj.schema_version).toBe(2);
    expect(prj.status).toBe("active");
    // 未知字段拒绝
    expect(WorkProject.safeParse({ ...prj, unknown_field: "x" }).success).toBe(false);
  });

  test("WorkTask requires task_… id and validates self-references", () => {
    const task = WorkTask.parse({
      schema_version: 2,
      type: "task",
      id: `task_${U}`,
      title: "Write schemas",
      description: "Contracts for v2.",
      revision: 2,
      status: "active",
      assignee: "human",
      created: now,
      updated: now,
      tags: [],
      dependencies: [],
      references: [],
    });
    expect(task.assignee).toBe("human");
    // 自己依赖自己拒绝
    expect(WorkTask.safeParse({ ...task, dependencies: [`task_${U}`] }).success).toBe(false);
    expect(WorkTask.safeParse({ ...task, parent: `task_${U}` }).success).toBe(false);
    // 重复依赖拒绝
    const other = `task_01J0A0A0A0A0A0A0A0A0A0A0A0`;
    expect(WorkTask.safeParse({ ...task, dependencies: [other, other] }).success).toBe(false);
  });

  test("WorkTaskPatch validates non-empty and description alone", () => {
    expect(WorkTaskPatch.parse({ title: "New title" }).title).toBe("New title");
    expect(WorkTaskPatch.parse({ status: "done" }).status).toBe("done");
    // null 清空
    expect(WorkTaskPatch.parse({ due: null }).due).toBeNull();
    // 空 patch 拒绝
    expect(WorkTaskPatch.safeParse({}).success).toBe(false);
    // description 单独修改
    expect(WorkTaskPatch.parse({ description: "Updated" }).description).toBe("Updated");
    // 与其他字段同时修改拒绝
    expect(WorkTaskPatch.safeParse({ description: "x", status: "done" }).success).toBe(false);
  });

  test("WorkProjectPatch same rules", () => {
    expect(WorkProjectPatch.parse({ status: "paused" }).status).toBe("paused");
    expect(WorkProjectPatch.safeParse({}).success).toBe(false);
    expect(WorkProjectPatch.safeParse({ description: "x", tags: [] }).success).toBe(false);
  });

  test("WorkComment wmsg_ prefix", () => {
    const comment = WorkComment.parse({
      id: `wmsg_${U}`,
      task: `task_${U}`,
      author: `act_${U}`,
      body: "Done!",
      created: now,
    });
    expect(comment.id.startsWith("wmsg_")).toBe(true);
    expect(WorkComment.safeParse({ ...comment, id: `task_${U}` }).success).toBe(false);
  });

  test("WorkExecution links task and job", () => {
    const exec = WorkExecution.parse({
      task: `task_${U}`,
      job: `job_${U}`,
      round: 3,
      input_revision: 5,
      input_snapshot: "Task description at dispatch time.",
      created: now,
      applied: false,
    });
    expect(exec.round).toBe(3);
  });

  test("WorkTaskDetail aggregates", () => {
    const detail = WorkTaskDetail.parse({
      task: {
        schema_version: 2,
        type: "task",
        id: `task_${U}`,
        title: "Test",
        description: "",
        revision: 1,
        status: "todo",
        assignee: "human",
        created: now,
        updated: now,
        tags: [],
        dependencies: [],
        references: [],
      },
      comments: [],
      executions: [],
    });
    expect(detail.comments).toHaveLength(0);
  });

  test("WorkCommand discriminates by op", () => {
    const create = WorkCommandRequest.parse({
      request_id: "req.create.task.001",
      operation: { op: "work.task.create", args: { title: "New task" } },
    });
    expect(create.operation.op).toBe("work.task.create");

    const update = WorkCommandRequest.parse({
      request_id: "req_update_001_xyz",
      operation: {
        op: "work.task.update",
        args: { task: `task_${U}`, expected_revision: 2, patch: { status: "done" } },
      },
    });
    if (update.operation.op === "work.task.update") {
      expect(update.operation.args.expected_revision).toBe(2);
    }
  });

  test("WorkCommandResult discriminates by kind", () => {
    const projectResult = WorkCommandResult.parse({
      kind: "project",
      project: {
        schema_version: 2,
        type: "project",
        id: `prj_${U}`,
        title: "Test",
        description: "",
        revision: 1,
        status: "planning",
        created: now,
        updated: now,
        tags: [],
      },
    });
    expect(projectResult.kind).toBe("project");

    const spec = {
      protocol_version: 2,
      id: `job_${U}`,
      runtime: `act_${U}`,
      lease: "lease-123456789012",
      run: { kind: "agent" as const, engine: "pi" as const, prompt: "test" },
      workdir: "/tmp",
      timeout_seconds: 3600,
      created: now,
    };
    const jobResult = WorkCommandResult.parse({
      kind: "job",
      job: { spec, status: "queued" as const },
    });
    expect(jobResult.kind).toBe("job");
  });
});

describe("Execution contracts", () => {
  test("ExecutionRoutine is strict v2 object", () => {
    const routine = ExecutionRoutine.parse({
      schema_version: 2,
      id: `rtn_${U}`,
      title: "Daily check",
      description: "Check system status.",
      revision: 1,
      status: "active",
      schedule: "0 9 * * 1",
      timezone: "Asia/Singapore",
      assignee: "pi@server",
      context: "none",
      created: now,
      updated: now,
    });
    expect(routine.assignee).toBe("pi@server");
    expect(routine.context).toBe("none");
  });

  test("ExecutionRoutineInfo adds runtime/next/last/problem", () => {
    const info = ExecutionRoutineInfo.parse({
      routine: {
        schema_version: 2,
        id: `rtn_${U}`,
        title: "Test",
        description: "",
        revision: 1,
        status: "active",
        schedule: "0 0 * * *",
        timezone: "UTC",
        assignee: "codex",
        context: "previous",
        created: now,
        updated: now,
      },
      runtime: "server",
      next: now,
      last: { job: `job_${U}`, status: "done", fired_at: now },
    });
    expect(info.runtime).toBe("server");
    expect(info.last?.status).toBe("done");
  });
});

describe("Assistant contracts", () => {
  test("MessageRole excludes system from stored messages", () => {
    const msg = AssistantMessage.parse({
      id: `amsg_${U}`,
      conversation: `conv_${U}`,
      role: "user",
      content: "Hello",
      created: now,
    });
    expect(msg.role).toBe("user");
    // system 不是存储的消息角色
    expect(AssistantMessage.safeParse({ ...msg, role: "system" }).success).toBe(false);
  });

  test("AssistantMessage tool role requires tool_call", () => {
    const valid = AssistantMessage.parse({
      id: `amsg_${U}`,
      conversation: `conv_${U}`,
      role: "tool",
      content: '{"status":"ok"}',
      created: now,
      tool_call: `tool_${U}`,
    });
    expect(valid.tool_call).toBe(`tool_${U}`);
    // tool 角色缺 tool_call 拒绝
    expect(
      AssistantMessage.safeParse({
        id: `amsg_${U}`,
        conversation: `conv_${U}`,
        role: "tool",
        content: "",
        created: now,
      }).success,
    ).toBe(false);
    // 非 tool 角色带 tool_call 拒绝
    expect(
      AssistantMessage.safeParse({
        id: `amsg_${U}`,
        conversation: `conv_${U}`,
        role: "user",
        content: "x",
        created: now,
        tool_call: `tool_${U}`,
      }).success,
    ).toBe(false);
  });

  test("AssistantTurn tracks request and status", () => {
    const turn = AssistantTurn.parse({
      id: `turn_${U}`,
      conversation: `conv_${U}`,
      request_id: "req_chat_001_unique",
      status: "done",
      created: now,
      finished: now,
    });
    expect(turn.status).toBe("done");
  });

  test("AssistantToolCall records tool invocation", () => {
    const tc = AssistantToolCall.parse({
      id: `tool_${U}`,
      turn: `turn_${U}`,
      name: "search",
      args: { query: "test" },
      status: "succeeded",
      result: { hits: [] },
      created: now,
      finished: now,
    });
    expect(tc.name).toBe("search");
  });

  test("AssistantModelRequest uses ModelMessageRole", () => {
    const req = AssistantModelRequest.parse({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      tools: [],
    });
    expect(req.messages[0]?.role).toBe("system");
  });

  test("AssistantModelResponse includes tool_calls", () => {
    const resp = AssistantModelResponse.parse({
      content: "Let me check that.",
      tool_calls: [{ id: "call_1", name: "search", args: { query: "x" } }],
    });
    expect(resp.tool_calls).toHaveLength(1);
  });

  test("AssistantChatRequest validates", () => {
    const req = AssistantChatRequest.parse({
      request_id: "req_chat_unique_id",
      message: "Tell me about lumio.",
    });
    expect(req.message).toBe("Tell me about lumio.");
  });
});

describe("Storage contracts", () => {
  test("RunLogEvent has schema_version=1 and sequence", () => {
    const event = RunLogEvent.parse({
      schema_version: 1,
      id: `evt_${U}`,
      run: `job_${U}`,
      sequence: 5,
      time: now,
      type: "output",
      payload: { line: "Processing..." },
    });
    expect(event.sequence).toBe(5);
    expect(event.payload.line).toBe("Processing...");
  });

  test("StoredArtifact validates safe path", () => {
    const art = StoredArtifact.parse({
      id: `art_${U}`,
      owner: { module: "execution", id: `job_${U}` },
      key: "artifacts/2026/10/result.json",
      sha256: "a".repeat(64),
      size: 1024,
      media_type: "application/json",
      status: "ready",
      private: false,
      created: now,
    });
    expect(art.status).toBe("ready");
    // 含 .. 的 key 拒绝
    expect(StoredArtifact.safeParse({ ...art, key: "../etc/passwd" }).success).toBe(false);
    expect(StoredArtifact.safeParse({ ...art, key: "a/../b" }).success).toBe(false);
  });

  test("BackupManifest lists database and files", () => {
    const manifest = BackupManifest.parse({
      schema_version: 1,
      created: now,
      database: { path: "hub.db", sha256: "a".repeat(64), size: 1024000 },
      files: [{ path: "artifacts/x.log", sha256: "b".repeat(64), size: 512 }],
    });
    expect(manifest.files).toHaveLength(1);
  });

  test("MigrationEntry validates id prefix matches type", () => {
    const entry = MigrationEntry.parse({
      id: `task_${U}`,
      type: "task",
      path: "plan/tasks/old-task.md",
      sha256: "c".repeat(64),
      title: "Old task",
    });
    expect(entry.type).toBe("task");
    // id 前缀不匹配 type 拒绝
    expect(MigrationEntry.safeParse({ ...entry, type: "project" }).success).toBe(false);
  });

  test("MigrationPlan has entries and problems", () => {
    const plan = MigrationPlan.parse({
      schema_version: 1,
      id: `mig_${U}`,
      created: now,
      source_hash: "d".repeat(64),
      entries: [
        {
          id: `task_01J0A0A0A0A0A0A0A0A0A0A0A0`,
          type: "task",
          path: "plan/tasks/t1.md",
          sha256: "e".repeat(64),
          title: "T1",
        },
      ],
      problems: ["Task task_abc123... has running Job, cannot migrate until completed."],
    });
    expect(plan.problems).toHaveLength(1);
  });
});

describe("JSON Schema export", () => {
  test("v2 contracts can export to JSON Schema", () => {
    const schemas = [
      WorkProject,
      WorkTask,
      WorkComment,
      ExecutionRoutine,
      AssistantConversation,
      AssistantMessage,
      RunLogEvent,
      StoredArtifact,
      MigrationPlan,
    ];
    for (const schema of schemas) {
      expect(() => z.toJSONSchema(schema, { io: "input" })).not.toThrow();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AssistantEvent,
  AssistantMemory,
  CONTRACTS,
  ExecutionRoutine,
  ExecutionRoutineCommandRequest,
  Id,
  ID_PREFIXES,
  JOB_PROTOCOL_VERSION,
  JobSpec,
  OPERATION_NAMES,
  OperationResult,
  RoutineInfo,
  RunLogEvent,
  StoredArtifact,
  Task,
  WORK_COMMAND_NAMES,
  WorkCommandRequest,
  WorkProject,
  WorkTask,
  WorkTaskPatch,
  idOf,
} from "../src/index.ts";

/** R0-1：v1 兼容、服务器字段、负责人、路径与版本的补充测试。数据全部为合成样例。 */
const U = "01J9Z3K8M2N4P6Q8R0S2T4V6W8";
const V = "01J9Z3K8M2N4P6Q8R0S2T4V6W9";
const now = "2026-10-31T16:30:00+08:00";

const task = {
  schema_version: 2, type: "task", id: `task_${U}`, title: "合成任务", description: "", revision: 1,
  status: "todo", assignee: "human", created: now, updated: now, tags: [], dependencies: [], references: [],
} as const;
const project = {
  schema_version: 2, type: "project", id: `prj_${U}`, title: "合成项目", description: "", revision: 1,
  status: "planning", created: now, updated: now, tags: [],
} as const;
const routine = {
  schema_version: 2, id: `rtn_${U}`, title: "合成例行", description: "", revision: 1, status: "active",
  schedule: "0 9 * * 1", timezone: "Asia/Singapore", assignee: "pi", context: "none", created: now, updated: now,
} as const;

describe("ID 前缀", () => {
  test("新增前缀唯一，Id 与 idOf 接受它们", () => {
    const values = Object.values(ID_PREFIXES);
    expect(new Set(values).size).toBe(values.length);
    for (const p of ["wmsg", "conv", "amsg", "turn", "tool", "mem", "evt", "art", "mig"] as const) {
      expect(Id.parse(`${p}_${U}`)).toBe(`${p}_${U}`);
      expect(idOf(p).safeParse(`${p}_${U}`).success).toBe(true);
    }
  });
});

describe("v2 对象", () => {
  test("revision 必须是正整数，时间必须带时区", () => {
    for (const revision of [0, -1, 1.5, "1"]) expect(WorkTask.safeParse({ ...task, revision }).success).toBe(false);
    expect(WorkTask.safeParse({ ...task, created: "2026-10-31T16:30:00" }).success).toBe(false);
    expect(WorkProject.safeParse({ ...project, deadline: "2026-11-01" }).success).toBe(false);
  });

  test("错误前缀与错误 schema_version 拒绝", () => {
    expect(WorkTask.safeParse({ ...task, id: `prj_${U}` }).success).toBe(false);
    expect(WorkTask.safeParse({ ...task, project: `task_${V}` }).success).toBe(false);
    expect(WorkTask.safeParse({ ...task, schema_version: 1 }).success).toBe(false);
    expect(ExecutionRoutine.safeParse({ ...routine, id: `task_${U}` }).success).toBe(false);
  });

  test("Work 对象没有 path，也不接受 null 当作未填", () => {
    expect(WorkTask.safeParse({ ...task, path: "plan/tasks/x.md" }).success).toBe(false);
    expect(WorkProject.safeParse({ ...project, path: "plan/projects/x.md" }).success).toBe(false);
    expect(WorkTask.safeParse({ ...task, due: null }).success).toBe(false);
  });

  test("负责人不接受旧对象写法", () => {
    expect(WorkTask.safeParse({ ...task, assignee: { agent: "pi", device: "server" } }).success).toBe(false);
    expect(WorkTask.parse({ ...task, assignee: "pi@server" }).assignee).toBe("pi@server");
    expect(ExecutionRoutine.safeParse({ ...routine, assignee: "human" }).success).toBe(false);
    expect(ExecutionRoutine.safeParse({ ...routine, assignee: { agent: "pi" } }).success).toBe(false);
    const dispatch = (to: unknown) =>
      WorkCommandRequest.safeParse({ request_id: "r".repeat(16), operation: { op: "work.task.dispatch", args: { task: `task_${U}`, to } } });
    expect(dispatch("codex@mac").success).toBe(true);
    expect(dispatch("human").success).toBe(false);
    expect(dispatch({ agent: "codex" }).success).toBe(false);
  });

  test("cron 沿用 5 段约束", () => {
    expect(ExecutionRoutine.safeParse({ ...routine, schedule: "0 9 * *" }).success).toBe(false);
  });
});

describe("patch", () => {
  test("拒绝服务器字段", () => {
    for (const key of ["id", "revision", "created", "updated", "schema_version", "type"]) {
      expect(WorkTaskPatch.safeParse({ [key]: 1, title: "x" }).success).toBe(false);
    }
  });

  test("null 清空可选关联、期限与执行配置；必填字段不接受 null", () => {
    const parsed = WorkTaskPatch.parse({ project: null, parent: null, due: null, workdir: null, gpus: null });
    expect(parsed).toEqual({ project: null, parent: null, due: null, workdir: null, gpus: null });
    expect(WorkTaskPatch.safeParse({ title: null }).success).toBe(false);
    expect(WorkTaskPatch.safeParse({ status: null }).success).toBe(false);
  });

  test("update 必须带 expected_revision", () => {
    const update = (args: object) =>
      WorkCommandRequest.safeParse({ request_id: "r".repeat(16), operation: { op: "work.task.update", args } });
    expect(update({ task: `task_${U}`, patch: { title: "x" } }).success).toBe(false);
    expect(update({ task: `task_${U}`, expected_revision: 0, patch: { title: "x" } }).success).toBe(false);
    expect(update({ task: `task_${U}`, expected_revision: 1, patch: {} }).success).toBe(false);
  });

  test("routine create 可以不填 timezone；update 拒绝空 patch", () => {
    const req = (operation: object) => ExecutionRoutineCommandRequest.safeParse({ request_id: "r".repeat(16), operation });
    expect(req({ op: "execution.routine.create", args: { title: "x", schedule: "0 9 * * *", assignee: "pi" } }).success).toBe(true);
    expect(req({ op: "execution.routine.update", args: { routine: `rtn_${U}`, expected_revision: 1, patch: {} } }).success).toBe(false);
    expect(req({ op: "execution.routine.update", args: { routine: `rtn_${U}`, expected_revision: 1, patch: { revision: 2 } } }).success).toBe(false);
  });

  test("request_id 长度 16–128", () => {
    const req = (request_id: string) =>
      WorkCommandRequest.safeParse({ request_id, operation: { op: "work.task.comment", args: { task: `task_${U}`, body: "hi" } } });
    expect(req("a".repeat(15)).success).toBe(false);
    expect(req("a".repeat(16)).success).toBe(true);
    expect(req("a".repeat(128)).success).toBe(true);
    expect(req("a".repeat(129)).success).toBe(false);
    expect(req("a b".padEnd(20, "c")).success).toBe(false);
  });
});

describe("存储格式", () => {
  const artifact = {
    id: `art_${U}`, owner: { module: "execution", id: `job_${U}` }, key: "jobs/out.txt", sha256: "0".repeat(64),
    size: 0, media_type: "text/plain", status: "staged", private: false, created: now,
  };

  test("key 拒绝绝对路径、.. 段、反斜杠、URL、空段", () => {
    for (const key of ["/etc/passwd", "../x", "a/../b", "a\\b", "https://x/y", "file:a", "a//b", "./a", "a/"]) {
      expect(StoredArtifact.safeParse({ ...artifact, key }).success).toBe(false);
    }
    expect(StoredArtifact.safeParse({ ...artifact, sha256: "A".repeat(64) }).success).toBe(false);
    expect(StoredArtifact.safeParse({ ...artifact, size: -1 }).success).toBe(false);
  });

  test("日志 sequence 是正整数", () => {
    const event = { schema_version: 1, id: `evt_${U}`, run: `job_${U}`, sequence: 1, time: now, type: "output", payload: {} };
    expect(RunLogEvent.safeParse(event).success).toBe(true);
    for (const sequence of [0, -1, 1.5]) expect(RunLogEvent.safeParse({ ...event, sequence }).success).toBe(false);
    expect(RunLogEvent.safeParse({ ...event, type: "" }).success).toBe(false);
    expect(RunLogEvent.safeParse({ ...event, schema_version: 2 }).success).toBe(false);
  });
});

describe("Assistant 补充", () => {
  test("记忆与事件", () => {
    expect(AssistantMemory.parse({
      id: `mem_${U}`, owner: `act_${U}`, content: "偏好中文", sources: [{ module: "assistant", id: `conv_${U}` }],
      private: false, revision: 1, created: now, updated: now,
    }).private).toBe(false);
    expect(AssistantEvent.parse({ type: "token", turn: `turn_${U}`, delta: "你" }).type).toBe("token");
    expect(AssistantEvent.safeParse({ type: "token", delta: "x" }).success).toBe(false);
    expect(AssistantEvent.safeParse({ type: "error", turn: `turn_${U}`, error: "" }).success).toBe(true);
  });
});

describe("v1 不变", () => {
  test("Job 协议版本仍为 2", () => {
    expect(JOB_PROTOCOL_VERSION).toBe(2);
    const spec = {
      protocol_version: 2, id: `job_${U}`, runtime: `act_${U}`, lease: "l".repeat(16),
      run: { kind: "command", argv: ["echo"] }, workdir: "~", timeout_seconds: 60, created: now,
    };
    expect(JobSpec.safeParse(spec).success).toBe(true);
    expect(JobSpec.safeParse({ ...spec, protocol_version: 3 }).success).toBe(false);
    expect(JobSpec.safeParse({ ...spec, input_revision: 1 }).success).toBe(false);
  });

  test("v1 任务笔记仍可解码旧对象负责人与 null 字段", () => {
    const note = Task.parse({ id: `task_${U}`, type: "task", title: "旧笔记", created: now, updated: now, assignee: { agent: "pi", device: "server" }, due: null, extra: 1 });
    expect(note.assignee).toEqual({ agent: "pi", device: "server" });
    expect((note as Record<string, unknown>).extra).toBe(1);
  });

  test("v1 strict 响应不接受新字段，操作列表不变", () => {
    expect(OPERATION_NAMES).toEqual(["task.dispatch", "routine.followup", "exec.privileged"]);
    expect(WORK_COMMAND_NAMES.some((n) => (OPERATION_NAMES as string[]).includes(n))).toBe(false);
    expect(OperationResult.safeParse({ status: "applied", operation: { op: "routine.followup", args: { routine: `rtn_${U}`, job: `job_${U}` } }, task: task }).success).toBe(false);
    expect(RoutineInfo.safeParse({ routine: routine, schedule: "0 9 * * 1", timezone: "UTC", status: "active" }).success).toBe(false);
  });
});

describe("导出", () => {
  test("全部 CONTRACTS 可生成 JSON Schema", () => {
    for (const s of Object.values(CONTRACTS)) {
      expect(() => z.toJSONSchema(s, { target: "draft-2020-12", io: "input" })).not.toThrow();
    }
    expect(CONTRACTS["work-task"]).toBe(WorkTask);
  });
});

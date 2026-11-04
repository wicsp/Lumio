import { describe, expect, test } from "bun:test";
import { AssistantConfigUpdate, WorkCommandRequest } from "@lumio/schema";
import { acknowledgeCommand, answerCommand, undoCommand } from "../src/client/commands.ts";
import { PROVIDER_PRESETS } from "../src/client/providers.ts";

const TASK = "task_01JABCDEFGHJKMNPQRSTVWXYZ0", PRJ = "prj_01JABCDEFGHJKMNPQRSTVWXYZ0";

describe("ADR 0030 commands", () => {
  test("answer and continue is one dispatch carrying the trimmed answer", () => {
    const request = answerCommand({ id: TASK, revision: 4 }, "pi@server", "  中文，确认继续 ");
    expect(WorkCommandRequest.parse(request)).toEqual(request);
    expect(request.operation).toEqual({ op: "work.task.dispatch", args: { task: TASK, to: "pi@server", expected_revision: 4, comment: "中文，确认继续" } });
  });
  test("acknowledge names the round", () => {
    const request = acknowledgeCommand(TASK, 2);
    expect(WorkCommandRequest.parse(request).operation).toEqual({ op: "work.task.acknowledge", args: { task: TASK, round: 2 } });
  });
});

describe("undo (ADR 0029)", () => {
  test("restores the recorded fields at the revision the assistant wrote", () => {
    const request = undoCommand({ capability: "work.task.update", target: TASK, before: { status: "todo", due: null }, after_revision: 5 })!;
    expect(WorkCommandRequest.parse(request).operation).toEqual({ op: "work.task.update", args: { task: TASK, expected_revision: 5, patch: { status: "todo", due: null } } });
    const project = undoCommand({ capability: "work.project.update", target: PRJ, before: { title: "Old" }, after_revision: 2 })!;
    expect(WorkCommandRequest.parse(project).operation.op).toBe("work.project.update");
  });
  test("creations and comments have nothing to restore", () => {
    expect(undoCommand({ capability: "work.task.create", target: TASK, after_revision: 1 })).toBeUndefined();
    expect(undoCommand({ capability: "work.task.comment", target: TASK })).toBeUndefined();
    expect(undoCommand({ capability: "work.task.update", target: TASK, before: {}, after_revision: 3 })).toBeUndefined();
  });
});

describe("assistant model presets", () => {
  test("every preset address is accepted by the config contract", () => {
    for (const [, base_url] of PROVIDER_PRESETS) expect(AssistantConfigUpdate.safeParse({ base_url, model: "m" }).success).toBe(true);
  });
});

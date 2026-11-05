import { describe, expect, test } from "bun:test";
import { AssistantConfigUpdate, WorkCommandRequest } from "@lumio/schema";
import { answerCommand } from "../src/client/commands.ts";
import { PROVIDER_PRESETS } from "../src/client/providers.ts";

const TASK = "task_01JABCDEFGHJKMNPQRSTVWXYZ0", PRJ = "prj_01JABCDEFGHJKMNPQRSTVWXYZ0";

describe("ADR 0030 commands", () => {
  test("answer and continue is one dispatch carrying the trimmed answer", () => {
    const request = answerCommand({ id: TASK, revision: 4 }, "pi@server", "  中文，确认继续 ");
    expect(WorkCommandRequest.parse(request)).toEqual(request);
    expect(request.operation).toEqual({ op: "work.task.dispatch", args: { task: TASK, to: "pi@server", expected_revision: 4, comment: "中文，确认继续" } });
  });
});

describe("assistant model presets", () => {
  test("every preset address is accepted by the config contract", () => {
    for (const [, base_url] of PROVIDER_PRESETS) expect(AssistantConfigUpdate.safeParse({ base_url, model: "m" }).success).toBe(true);
  });
});

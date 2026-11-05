import { describe, expect, test } from "bun:test";
import { WorkCommandRequest, type WorkTask } from "@lumio/schema";
import { workPatchCommand } from "../src/client/commands.ts";
import { dueLabel, ago, isoFromDateInput, dateInputValue } from "../src/client/format.ts";
import { setLang } from "../src/client/i18n.ts";

const task: WorkTask = { schema_version: 3, type: "task", id: "task_01JABCDEFGHJKMNPQRSTVWXYZ0", title: "T", description: "", revision: 4, outcome: "open", turn: { holder: "human", reason: "todo", since: "2026-11-01T00:00:00Z" }, created: "2026-11-01T00:00:00+08:00", updated: "2026-11-01T00:00:00+08:00", tags: [], dependencies: [], references: [] };

describe("workPatchCommand", () => {
  test("sends only the changed field with the seen revision", () => {
    const cmd = workPatchCommand(task, { title: "T2", due: null }, "web-0123456789abcdef")!;
    expect(WorkCommandRequest.parse(cmd)).toEqual(cmd);
    expect(cmd.operation).toEqual({ op: "work.task.update", args: { task: task.id, expected_revision: 4, patch: { title: "T2" } } });
  });
  test("unchanged values and null-vs-missing produce no request", () => {
    expect(workPatchCommand(task, { title: "T" })).toBeUndefined();
    expect(workPatchCommand(task, { due: null, workdir: null })).toBeUndefined();
  });
  test("clearing an optional field sends null", () => {
    const cmd = workPatchCommand({ ...task, due: "2026-11-05T18:00:00+08:00" }, { due: null }, "web-0123456789abcdef")!;
    expect(WorkCommandRequest.parse(cmd).operation).toMatchObject({ args: { patch: { due: null } } });
  });
});

describe("format", () => {
  const now = new Date(2026, 10, 2, 12, 0, 0);
  test("due labels", () => {
    setLang("en", false);
    expect(dueLabel(new Date(2026, 10, 2, 18).toISOString(), now)).toMatchObject({ text: "today", overdue: false, soon: true });
    expect(dueLabel(new Date(2026, 10, 3, 9).toISOString(), now)?.text).toBe("tomorrow");
    expect(dueLabel(new Date(2026, 10, 1, 9).toISOString(), now)).toMatchObject({ text: "yesterday", overdue: true });
    expect(dueLabel(undefined, now)).toBeUndefined();
    setLang("zh", false);
    expect(dueLabel(new Date(2026, 10, 2, 18).toISOString(), now)?.text).toBe("今天");
    expect(dueLabel(new Date(2026, 10, 3, 9).toISOString(), now)?.text).toBe("明天");
    setLang("en", false);
  });
  test("relative time", () => {
    setLang("en", false);
    expect(ago(new Date(now.getTime() - 30_000).toISOString(), now)).toBe("just now");
    expect(ago(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe("5 min ago");
    setLang("zh", false);
    expect(ago(new Date(now.getTime() - 30_000).toISOString(), now)).toBe("刚刚");
    expect(ago(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe("5 分钟前");
    setLang("en", false);
  });
  test("date input round trip keeps the local day and an offset", () => {
    const iso = isoFromDateInput("2026-11-09")!;
    expect(iso).toMatch(/^2026-11-09T18:00:00[+-]\d{2}:\d{2}$/);
    expect(dateInputValue(iso)).toBe("2026-11-09");
    expect(isoFromDateInput("")).toBeNull();
  });
});

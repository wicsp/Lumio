import { describe, expect, test } from "bun:test";
import { WorkCommandRequest, WorkAttention, type WorkTask } from "@lumio/schema";
import { artifactPresentation } from "../../src/client/artifact-row.ts";
import { matchesDecision } from "../../src/client/attention-card.ts";
import { taskCreateCommand } from "../../src/client/commands.ts";
import { SECTIONS } from "../../src/client/navigation.ts";
import { sourceTaskIntent, taskSources } from "../../src/client/source-task.ts";
import { observation } from "../../src/client/usage-observations.ts";

const suffix = "01JABCDEFGHJKMNPQRSTVWXYZ0";
describe("workbench journeys", () => {
  test("four primary sections retain shortcuts and secondary routes", () => {
    expect(SECTIONS.filter(s => s.short).map(s => s.key)).toEqual(["overview", "work", "knowledge", "personal"]);
    expect(new Set(SECTIONS.map(s => s.key2)).size).toBe(8);
  });
  test("source-based creation round trips structured knowledge and execution references", () => {
    for (const refs of [[{ module: "knowledge" as const, id: "src_" + suffix, label: "Fixture" }],
      [{ module: "execution" as const, id: "rtn_" + suffix }, { module: "execution" as const, id: "job_" + suffix }]]) {
      const references = taskSources(sourceTaskIntent(refs));
      const request = WorkCommandRequest.parse(taskCreateCommand({ title: "Fixture", references }));
      expect(request.operation.args).toMatchObject({ references: refs });
    }
    expect(taskSources("new-from:invalid")).toEqual([]);
  });
  test("a decision on an older handoff never becomes a command on the new round", () => {
    const item = WorkAttention.parse({ task: "task_"+suffix, job: "job_"+suffix, round: 1, title: "Fixture", kind: "review", since: "2026-11-27T08:00:00Z" });
    const task = { outcome: "open", turn: { holder: "human", reason: "review", job: item.job, round: 1, since: item.since } } as WorkTask;
    expect(matchesDecision(item, task)).toBe(true);
    expect(matchesDecision({ ...item, round: 2 }, task)).toBe(false);
    expect(matchesDecision({ ...item, stage: "another" }, task)).toBe(false);
    expect(matchesDecision({ ...item, kind: "failed" }, task)).toBe(false);
  });
  test("verified downloads name known file formats and keep unknown extensions inert", () => {
    const key = "art_" + suffix + ".bin";
    const csv = artifactPresentation({ key, media_type: "text/csv; charset=utf-8" });
    expect(csv.filename).toBe("art_" + suffix + ".csv");
    expect(csv.label).toContain("CSV");
    expect(csv.label).toContain(suffix.slice(-6));
    expect(artifactPresentation({ key, media_type: "text/html" }).filename).toBe(key);
  });
  test("only known observation fields leave a work page", () => {
    expect(observation("personal", "page", "opened", 0)).toBeUndefined();
    expect(observation("settings", "page", "opened", 0)).toBeUndefined();
    expect(observation("work", "private title" as never, "opened", 0)).toBeUndefined();
    expect(observation("work", "evidence-list", "failed", NaN)).toBeUndefined();
    expect(Object.keys(observation("knowledge", "insert-reference", "succeeded", 23.1)!)).toEqual(["page", "action", "outcome", "elapsed_ms", "at"]);
  });
});

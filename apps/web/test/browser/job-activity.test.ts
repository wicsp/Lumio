import { expect, test } from "bun:test";
import { JobLiveView, PlanStage, WorkCommandRequest } from "@lumio/schema";
import { jobActivitySummary } from "../../src/client/job-activity.ts";
import { dispatchCommand } from "../../src/client/commands.ts";
import { draftPlan, toDraft } from "../../src/client/plan.ts";
import { setLang } from "../../src/client/i18n.ts";

const at = "2026-11-17T00:00:00Z", job = "job_00000000000000000000000001";
test("Job summaries distinguish observable work, a queued round and a disconnected executor", () => {
  setLang("en", false);
  const view = JobLiveView.parse({
    job, status: "running", created: at, assigned: at, started: at, last_heartbeat: at, last_activity: at,
    connected: true, capability: null, phase: "engine", sequence: 2, first_available: 1,
    stop_requested: false, active_tools: [{ id: "tool", kind: "command", label: "bun test" }],
    recent: [], target: null, pending: null, receipts: [],
  });
  expect(jobActivitySummary(view)).toContain("Running bun test");
  expect(jobActivitySummary(view)).toContain("Last heartbeat");
  expect(jobActivitySummary({ ...view, connected: false })).toContain("Runtime disconnected");
  expect(jobActivitySummary({ ...view, stop_requested: true })).toContain("confirm it stopped");
  expect(jobActivitySummary({ ...view, assigned: null, started: null, last_activity: null, last_heartbeat: null,
    active_tools: [], phase: null, connected: null, status: "queued" })).toBe("Waiting for the Runtime");
});
test("the delegation and plan editors preserve explicitly requested interaction", () => {
  const task = { id: "task_00000000000000000000000001", revision: 1 };
  const command = dispatchCommand(task, "codex@mac", "web-fixture-delegation", true);
  expect(WorkCommandRequest.parse(command).operation.args).toMatchObject({ interaction: "interactive" });
  const stage = PlanStage.parse({ kind: "agent", id: "build", agent: "codex@mac", instruction: "Build", interaction: "interactive" });
  const result = draftPlan([[toDraft(stage)]]);
  expect("plan" in result && result.plan.stages[0]).toMatchObject({ interaction: "interactive" });
});

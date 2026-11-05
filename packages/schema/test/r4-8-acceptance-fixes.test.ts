import { describe, expect, test } from "bun:test";
import { ExecutionTarget, ExecutionTargetListArgs, Proposal, WorkCommand, WorkProject } from "../src/index.ts";

const at = "2026-11-05T00:00:00Z";
const ACT = "act_01JABCDEFGHJKMNPQRSTVWXYZ0", PRJ = "prj_01JABCDEFGHJKMNPQRSTVWXYZ0";
const PROP = "prop_01JABCDEFGHJKMNPQRSTVWXYZ0", NEWER = "prop_01JABCDEFGHJKMNPQRSTVWXYZ1";

describe("ADR 0033", () => {
  test("projects carry an optional workdir that create and update can set or clear", () => {
    const project = { schema_version: 2, type: "project", id: PRJ, title: "P", description: "", revision: 1, status: "active", created: at, updated: at, tags: [] };
    expect(WorkProject.parse({ ...project, workdir: "~/code/lumio" }).workdir).toBe("~/code/lumio");
    expect(WorkProject.parse(project).workdir).toBeUndefined();
    expect(WorkCommand.safeParse({ op: "work.project.create", args: { title: "P", workdir: "~/code" } }).success).toBe(true);
    expect(WorkCommand.safeParse({ op: "work.project.update", args: { project: PRJ, expected_revision: 1, patch: { workdir: null } } }).success).toBe(true);
    expect(WorkCommand.safeParse({ op: "work.project.update", args: { project: PRJ, expected_revision: 1, patch: { workdir: "" } } }).success).toBe(false);
  });
  test("withdrawn proposals may point at the proposal that superseded them", () => {
    const base = { id: PROP, reason: "r", author: ACT, created: at,
      operation: { op: "task.dispatch", args: { task: "task_01JABCDEFGHJKMNPQRSTVWXYZ0", trigger: "cli", to: "codex@macsp" } } };
    const withdrawn = Proposal.safeParse({ ...base, status: "withdrawn", decided: at, decided_by: ACT, superseded_by: NEWER });
    expect(withdrawn.success).toBe(true);
    expect(Proposal.safeParse({ ...base, status: "withdrawn", decided: at, decided_by: ACT }).success).toBe(true);
    expect(Proposal.safeParse({ ...base, status: "pending", superseded_by: NEWER }).success).toBe(false);
  });
  test("execution targets name a registered engine on a runtime", () => {
    expect(ExecutionTarget.parse({ target: "codex@macsp", runtime: "macsp", engine: "codex", version: "0.50.0", online: true }).target).toBe("codex@macsp");
    expect(ExecutionTarget.safeParse({ target: "codex@macsp", runtime: "macsp", engine: "gpt", version: "1", online: true }).success).toBe(false);
    expect(ExecutionTargetListArgs.parse({})).toEqual({});
  });
});

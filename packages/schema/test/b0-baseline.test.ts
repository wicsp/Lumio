import { expect, test } from "bun:test";
import {
  ArtifactOwner, CaptureKind, Entity, GLANCE_LIMITS, HubRef, KnowledgeGraphArgs, Operation, OriginalFrontmatter, PlanRun,
  ProposalOperation, ResourceRef, RuntimeInfo, RuntimeRegistration, SearchHit, Source, SOURCE_KINDS, TaskAssignee, WorkProject, WorkTask,
} from "../src/index.ts";

const ulid = "01J9Z3K8M2N4P6Q8R0S2T4V6W8";
const at = "2026-11-16T00:00:00Z";
const actor = `act_${ulid}`;
const metadata = { title: "Synthetic document", created: at, updated: at };
const glance = { id: `gln_${ulid}`, app: { name: "Synthetic Reader" }, window: "Sample", screenshot: `art_${ulid}`, pointing: "selection" } as const;

test("capture kinds include the canonical source kinds and text works without a URL", () => {
  expect(CaptureKind.options).toEqual(["paper", ...SOURCE_KINDS]);
  for (const kind of SOURCE_KINDS) expect(Source.parse({ ...metadata, type: "source", id: `src_${ulid}`, kind }).kind).toBe(kind);
  expect(Source.parse({ ...metadata, type: "source", id: `src_${ulid}`, kind: "text" }).url).toBeUndefined();
});

test("original glance provenance is nested, strict and can omit an expired screenshot", () => {
  const original = { of: `src_${ulid}`, captured: at, extractor: "glance-ocr@1", sha256: "0".repeat(64) };
  expect(OriginalFrontmatter.parse({ ...original, glance }).glance).toEqual(glance);
  expect(OriginalFrontmatter.parse({ ...original, glance: { ...glance, screenshot: undefined } }).url).toBeUndefined();
  for (const patch of [
    { id: undefined }, { app: undefined }, { pointing: undefined }, { extra: "x" },
    { id: `cap_${ulid}` }, { screenshot: `gln_${ulid}` }, { pointing: "unknown" },
    { window: "x".repeat(GLANCE_LIMITS.max_window_title_chars + 1) },
  ]) expect(OriginalFrontmatter.safeParse({ ...original, glance: { ...glance, ...patch } }).success).toBe(false);
});

test("artifact ownership accepts Hub coordination IDs without widening ResourceRef", () => {
  for (const prefix of ["cap", "gln"]) {
    const ref = { module: "hub" as const, id: `${prefix}_${ulid}` };
    expect(HubRef.parse(ref)).toEqual(ref);
    expect(ArtifactOwner.parse(ref)).toEqual(ref);
    expect(ResourceRef.safeParse(ref).success).toBe(false);
  }
  expect(ArtifactOwner.safeParse({ module: "hub", id: `src_${ulid}` }).success).toBe(false);
  expect(ResourceRef.safeParse({ module: "knowledge", id: glance.id }).success).toBe(false);
  expect(ArtifactOwner.safeParse({ module: "knowledge", id: `src_${ulid}` }).success).toBe(true);
});

test("only knowledge entities and the current work/approval contracts are accepted", () => {
  for (const [type, prefix] of [["task", "task"], ["project", "prj"], ["routine", "rtn"]]) {
    expect(Entity.safeParse({ ...metadata, type, id: `${prefix}_${ulid}` }).success).toBe(false);
  }
  for (const operation of [
    { op: "task.dispatch", args: { task: `task_${ulid}`, trigger: "cli" } },
    { op: "routine.followup", args: { routine: `rtn_${ulid}`, job: `job_${ulid}` } },
  ]) {
    expect(Operation.safeParse(operation).success).toBe(false);
    expect(ProposalOperation.safeParse(operation).success).toBe(false);
  }
  expect(TaskAssignee.safeParse({ agent: "codex", device: "synthetic" }).success).toBe(false);
  expect(KnowledgeGraphArgs.safeParse({ include_legacy: true }).success).toBe(false);
});

test("work identities, plan progress and query fields are required", () => {
  const base = { ...metadata, description: "", revision: 1, tags: [], created_by: actor, updated_by: actor };
  const task = WorkTask.parse({ ...base, schema_version: 3, type: "task", id: `task_${ulid}`, outcome: "open",
    turn: { holder: "human", reason: "todo", since: at }, dependencies: [], references: [] });
  const project = WorkProject.parse({ ...base, schema_version: 2, type: "project", id: `prj_${ulid}`, status: "active" });
  for (const field of ["created_by", "updated_by"]) {
    expect(WorkTask.safeParse({ ...task, [field]: undefined }).success).toBe(false);
    expect(WorkProject.safeParse({ ...project, [field]: undefined }).success).toBe(false);
  }
  const plan = PlanRun.parse({ plan: { stages: [{ kind: "agent", id: "build", agent: "codex", instruction: "Build" }] },
    approved: { at, by: actor }, stage: "build", rounds: 0, done: [] });
  expect(PlanRun.safeParse({ ...plan, done: undefined }).success).toBe(false);
  const hit = SearchHit.parse({ note: { type: "idea", title: "Synthetic", path: "research/ideas/Synthetic.md" },
    snippet: "", matched_in: null, status: null, created: null });
  for (const field of ["matched_in", "status", "created"]) expect(SearchHit.safeParse({ ...hit, [field]: undefined }).success).toBe(false);
});

test("older Runtime registration stays valid and client Runtime info declares missing facts explicitly", () => {
  const registration = RuntimeRegistration.parse({ protocol_version: 2, name: "synthetic", engines: [], tags: [], max_concurrent: 1 });
  const info = { actor, last_seen: at, online: true, registration: { ...registration, version: null, platform: null, install: null }, update: null };
  expect(RuntimeInfo.parse(info)).toEqual(info);
  expect(RuntimeInfo.safeParse({ ...info, registration }).success).toBe(false);
  expect(RuntimeInfo.safeParse({ ...info, update: undefined }).success).toBe(false);
});

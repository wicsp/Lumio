import { expect, test } from "bun:test";
import { CONTRACTS, ID_PREFIXES, Idea, Paper } from "@lumio/schema";
import { fillMetadata, type FillInput, type EntityType } from "../src/index.ts";

const ulid = "01J9Z3K8M2N4P6Q8R0S2T4V6W8";
const ctx = {
  now: new Date("2026-10-22T21:00:00+08:00"), tz: "Asia/Singapore",
  newId: (prefix: string) => `${prefix}_${ulid}`,
};
const base: FillInput = {
  type: "idea", frontmatter: {}, fileName: "新的想法",
  birthtime: new Date("2026-10-21T12:34:56.789Z"), mtime: new Date("2026-10-22T13:20:00.999Z"),
};

test("fills metadata, takes title from filename, formats seconds with local offset; defaults stay in memory", () => {
  const { patch, issues } = fillMetadata(base, ctx);
  expect(patch).toEqual({
    id: `idea_${ulid}`, type: "idea", title: "新的想法",
    created: "2026-10-21T20:34:56+08:00", updated: "2026-10-22T21:20:00+08:00",
  });
  expect(issues).toEqual([]);
  expect(Idea.parse(patch)).toMatchObject({ status: "seed", tags: [], schema_version: 1 });
  expect(base.frontmatter).toEqual({});
});

test.each([new Date(NaN), new Date(0)])("invalid or zero birthtime falls back to mtime: %s", (birthtime) => {
  const { patch } = fillMetadata({ ...base, birthtime }, ctx);
  expect(patch.created).toBe(patch.updated);
});

test.each([
  ["UTC", "2026-10-22T13:20:00+00:00"],
  ["America/New_York", "2026-10-22T09:20:00-04:00"],
  ["Asia/Kathmandu", "2026-10-22T19:05:00+05:45"],
])("uses %s offset at the file timestamp", (tz, expected) => {
  expect(fillMetadata(base, { ...ctx, tz }).patch.updated).toBe(expected);
});

test("does not replace any existing values, unknown fields, or links, including invalid values", () => {
  const fm = {
    id: "bad-id", type: "idea", title: "", created: "invalid", updated: "invalid",
    related: [`pap_${ulid}`], aliases: ["my alias"], status: "wrong", tags: null,
  };
  const snapshot = structuredClone(fm);
  const { patch, issues } = fillMetadata({ ...base, frontmatter: fm }, ctx);
  expect(patch).toEqual({});
  expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(["id", "title", "created", "updated", "status"]));
  expect(fm).toEqual(snapshot);
});

test("only reports type-directory mismatch; validates against directory entity schema", () => {
  const { patch, issues } = fillMetadata({ ...base, frontmatter: { type: "paper" } }, ctx);
  expect(patch).not.toHaveProperty("type");
  expect(issues.map((issue) => issue.path)).toContain("type");
  expect(patch.id).toBe(`idea_${ulid}`);
});

test("null ID is filled, optional/default null fields are preserved and accepted", () => {
  const fm = { id: null, status: null, tags: null, related: null, project: null };
  const { patch, issues } = fillMetadata({ ...base, frontmatter: fm }, ctx);
  expect(patch.id).toBe(`idea_${ulid}`);
  expect(issues).toEqual([]);
  expect(patch).not.toHaveProperty("status");
  expect(Idea.parse({ ...fm, ...patch })).toMatchObject({ status: "seed", tags: [] });
});

test.each(["paper", "idea", "project", "task", "experiment"] as EntityType[])("fills %s with matching ID and schema defaults", (type) => {
  const frontmatter = type === "paper" ? { authors: ["Synthetic Author"], year: 2020 }
    : type === "experiment" ? { project: `prj_${ulid}` } : {};
  const { patch, issues } = fillMetadata({ ...base, type, fileName: "He_2020_LightGCN", frontmatter }, ctx);
  expect(patch.id).toBe(`${ID_PREFIXES[type]}_${ulid}`);
  expect(issues).toEqual([]);
  expect(CONTRACTS[type].safeParse({ ...frontmatter, ...patch }).success).toBe(true);
  // 任务的 status 是开关，要写出来（ADR 0023）；其他类型的默认值不写进文件。
  if (type === "task") expect(patch.status).toBe("todo"); else expect(patch).not.toHaveProperty("status");
  expect(patch).not.toHaveProperty("assignee");
  expect(patch).not.toHaveProperty("turn");
});

test("switch fields are written for tasks and routines (ADR 0023)", () => {
  const routine = fillMetadata({ ...base, type: "routine", frontmatter: { schedule: "0 9 * * *", assignee: { agent: "pi" } } }, ctx).patch;
  expect(routine.status).toBe("active");
  const agentTask = fillMetadata({ ...base, type: "task", frontmatter: { assignee: { agent: "codex", device: "server" }, status: null } }, ctx).patch;
  expect(agentTask).toMatchObject({ status: "todo", turn: "human" });
  const human = fillMetadata({ ...base, type: "task", frontmatter: { assignee: "human" } }, ctx).patch;
  expect(human.status).toBe("todo"); expect(human).not.toHaveProperty("turn");
  const kept = fillMetadata({ ...base, type: "task", frontmatter: { assignee: { agent: "pi" }, status: "active", turn: "agent" } }, ctx).patch;
  expect(kept).not.toHaveProperty("status"); expect(kept).not.toHaveProperty("turn");
  expect(fillMetadata({ ...base, type: "routine", frontmatter: { schedule: "0 9 * * *", assignee: { agent: "pi" }, status: "paused" } }, ctx).patch).not.toHaveProperty("status");
});

test("paper filename may supply citekey, but no authors/year are guessed", () => {
  const { patch, issues } = fillMetadata({ ...base, type: "paper", fileName: "He_2020_LightGCN" }, ctx);
  expect(patch.citekey).toBe("He_2020_LightGCN");
  expect(issues.map((issue) => issue.path)).toEqual(["authors", "year"]);
  expect(patch).not.toHaveProperty("authors");
  expect(patch).not.toHaveProperty("year");
});

test("invalid filename reports missing citekey, non-null existing citekey remains unchanged", () => {
  const input = { ...base, type: "paper" as const };
  expect(fillMetadata(input, ctx).issues).toContainEqual({ path: "citekey", message: "缺失，且文件名不是合法 citekey" });
  for (const citekey of ["Vaswani_2017_Transformer", ""]) {
    const result = fillMetadata({ ...input, fileName: "He_2020_LightGCN", frontmatter: { citekey } }, ctx);
    expect(result.patch).not.toHaveProperty("citekey");
  }
});

test.each(["id", "type", "title", "created", "updated"])("null %s is filled just like an absent field", (key) => {
  const expected = fillMetadata(base, ctx);
  const fm = { ...expected.patch, [key]: null };
  const result = fillMetadata({ ...base, frontmatter: fm }, ctx);
  expect(result).toEqual({ patch: { [key]: expected.patch[key] }, issues: [] });
  expect(fm[key]).toBeNull();
  expect(Idea.safeParse({ ...fm, ...result.patch }).success).toBe(true);
});

test("null paper citekey comes from a valid filename; null authors/year are still reported", () => {
  const result = fillMetadata({ ...base, type: "paper", fileName: "He_2020_LightGCN", frontmatter: { citekey: null, authors: null, year: null } }, ctx);
  expect(result.patch.citekey).toBe("He_2020_LightGCN");
  expect(result.issues.map((issue) => issue.path)).toEqual(["authors", "year"]);
  expect(result.patch).not.toHaveProperty("authors");
  expect(result.patch).not.toHaveProperty("year");
});

test("a null paper citekey with an invalid filename is reported instead of guessed", () => {
  const result = fillMetadata({ ...base, type: "paper", frontmatter: { citekey: null } }, ctx);
  expect(result.patch).not.toHaveProperty("citekey");
  expect(result.issues).toContainEqual({ path: "citekey", message: "缺失，且文件名不是合法 citekey" });
});

test.each(["id", "type", "title", "created", "updated"])("empty string %s is preserved and reported", (key) => {
  const fm = { ...fillMetadata(base, ctx).patch, [key]: "" };
  const result = fillMetadata({ ...base, frontmatter: fm }, ctx);
  expect(result.patch).toEqual({});
  expect(result.issues.map((issue) => issue.path)).toContain(key);
});

test("complete paper requires no patch and passes the contract", () => {
  const frontmatter = {
    ...fillMetadata({ ...base, type: "paper", fileName: "He_2020_LightGCN" }, ctx).patch,
    authors: ["Synthetic Author"], year: 2020,
  };
  expect(Paper.safeParse(frontmatter).success).toBe(true);
  expect(fillMetadata({ ...base, type: "paper", frontmatter }, ctx)).toEqual({ patch: {}, issues: [] });
});

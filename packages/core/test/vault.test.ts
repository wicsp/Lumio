import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { entityDirectory, entityTypeOfPath, isPrivateType, scanVault, VAULT_LAYOUT } from "../src/index.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/layout-vault", import.meta.url));

test("the layout map covers every entity type exactly once (ADR 0012)", () => {
  const types = VAULT_LAYOUT.map((e) => e.type);
  expect(new Set(types).size).toBe(types.length);
  expect([...types].sort()).toEqual(["asset", "experiment", "idea", "paper", "post", "project", "routine", "source", "task"]);
  expect(entityDirectory("routine")).toBe("plan/routines"); // ADR 0019
  expect(entityDirectory("paper")).toBe("library/papers");
  expect(entityDirectory("asset")).toBe("life/assets");
  expect(isPrivateType("asset")).toBe(true);
  expect(VAULT_LAYOUT.filter((e) => e.private).map((e) => e.type)).toEqual(["asset"]);
});

test("entityTypeOfPath resolves nested paths and ignores everything else", () => {
  expect(entityTypeOfPath("library/sources/obsidian/x.md")).toBe("source");
  expect(entityTypeOfPath("research/ideas/x.md")).toBe("idea");
  expect(entityTypeOfPath("research/reports/x.md")).toBeUndefined();
  expect(entityTypeOfPath("library/papersX/x.md")).toBeUndefined();
  expect(entityTypeOfPath("papers/x.md")).toBeUndefined();
});

test("scanVault finds all eight types, recurses into subfolders, skips non-entities", async () => {
  const files = await scanVault(fixture);
  expect(files.map((f) => [f.relativePath, f.type, f.private])).toEqual([
    ["library/papers/He_2020_LightGCN.md", "paper", false],
    ["library/sources/obsidian/Excalidraw Essentials.md", "source", false],
    ["research/ideas/想法.md", "idea", false],
    ["research/experiments/实验.md", "experiment", false],
    ["plan/projects/项目.md", "project", false],
    ["plan/tasks/任务.md", "task", false],
    ["create/posts/视频.md", "post", false],
    ["life/assets/subscriptions/Example Cloud.md", "asset", true],
  ]);
});

test("scanVault can filter by type", async () => {
  expect((await scanVault(fixture, ["source", "asset"])).map((f) => f.type)).toEqual(["source", "asset"]);
});

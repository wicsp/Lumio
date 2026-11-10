import { describe, expect, test } from "bun:test";
import { WorkCommandRequest } from "@lumio/schema";
import { grantCommand, itemsPermission, permissionItemLabel, permissionItems } from "../../src/client/commands.ts";
import { setLang } from "../../src/client/i18n.ts";

const task = { id: "task_01JABCDEFGHJKMNPQRSTVWXYZ0", revision: 7 };

describe("permission requests (ADR 0049, H1-9)", () => {
  test("requested permissions become checkable items and back", () => {
    const requested = { access: "full" as const, git: true, secrets: ["github-merge"] };
    const items = permissionItems(requested);
    expect(items).toEqual(["full", "git", "secret:github-merge"]);
    expect(itemsPermission(items)).toEqual(requested);
    expect(itemsPermission(["git"])).toEqual({ git: true });
    expect(permissionItems({ access: "read" })).toEqual([]);
  });
  test("approving a subset produces a valid grant command for either scope", () => {
    for (const scope of ["next_round", "task"] as const) {
      const command = grantCommand(task, itemsPermission(["git"]), scope, "synthetic-grant-000001");
      expect(WorkCommandRequest.parse(command)).toEqual(command);
      expect(command.operation).toMatchObject({ op: "work.task.grant", args: { task: task.id, expected_revision: 7, permissions: { git: true }, scope } });
    }
  });
  test("items are labelled in both languages", () => {
    setLang("zh", false);
    expect(permissionItemLabel("secret:github-merge")).toBe("使用密钥「github-merge」");
    setLang("en", false);
    expect(permissionItemLabel("git")).toBe("Write Git (fetch, commit, push)");
  });
});

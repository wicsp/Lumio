import { expect, test } from "bun:test";
import { StagePermissions } from "@lumio/schema";
import { splitPermissionRequest } from "../src/permission-request.ts";

test("only a valid final marker turns a report into a permission request", () => {
  const reason = "Need to fetch the synthetic upstream.";
  const result = splitPermissionRequest(`${reason}\r\n<lumio-permission>git, write secret:github-merge git</lumio-permission>\r\n`);
  expect(result.report).toBe(reason);
  expect(StagePermissions.parse(result.permission)).toEqual({ git: true, access: "write", secrets: ["github-merge"] });
  for (const report of [
    "inline <lumio-permission>git</lumio-permission>",
    "<lumio-permission>git</lumio-permission>\nAdditional text",
    "<lumio-permission>root</lumio-permission>",
    "<lumio-permission>secret:UPPER</lumio-permission>",
  ]) expect(splitPermissionRequest(report)).toEqual({ report });
});

import { describe, expect, test } from "bun:test";
import { JobResult, RuntimeRegistration } from "@lumio/schema";
import { INSTALL_HELPER_COMMAND, helperState } from "../../src/client/privileged-helper.ts";

describe("administrator helper visibility", () => {
  test("state comes from the runtime's declared features", () => {
    expect(helperState({ features: ["stage_permissions", "privileged_helper"] })).toBe("installed");
    expect(helperState({ features: ["stage_permissions"] })).toBe("missing");
    expect(helperState({})).toBe("unknown");
    expect(INSTALL_HELPER_COMMAND).toBe("sudo lumio-runtime install-sudo-helper");
  });
  test("the contract carries the feature and the refused program", () => {
    expect(RuntimeRegistration.safeParse({ protocol_version: 2, name: "server", engines: [], tags: [], max_concurrent: 1, features: ["privileged_helper"] }).success).toBe(true);
    const result = { job: "job_01JABCDEFGHJKMNPQRSTVWXYZ0", lease: "lease-0123456789abcdef", status: "failed", finished: "2026-11-10T00:00:00Z", privileged_unavailable: { program: "/usr/bin/apt-get" } };
    expect(JobResult.safeParse(result).success).toBe(true);
    expect(JobResult.safeParse({ ...result, privileged_unavailable: { program: "/usr/bin/apt-get", argv: ["x"] } }).success).toBe(false);
  });
});

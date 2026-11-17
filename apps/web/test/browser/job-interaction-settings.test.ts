import { expect, test } from "bun:test";
import { JobEngineActivityCapability } from "@lumio/schema";
import { jobInteractionStatus } from "../../src/client/job-interaction-settings.ts";

const codex = JobEngineActivityCapability.parse({
  engine: "codex", version: "0.166.0", progress: true, sandbox: "os", approvals: true, questions: true, steer: true,
});

test("live progress alone does not enable questions and approvals", () => {
  expect(jobInteractionStatus("codex", true, { ...codex, approvals: false, questions: false, steer: false }))
    .toBe("Live questions and approvals are not enabled on this runtime");
  expect(jobInteractionStatus("codex", true, { ...codex, questions: false }))
    .toBe("Live questions and approvals are not enabled on this runtime");
  expect(jobInteractionStatus("codex", true, { ...codex, sandbox: "none" }))
    .toBe("Live questions and approvals are not enabled on this runtime");
});

test("distinguishes an online interactive engine from an offline or unreported runtime", () => {
  expect(jobInteractionStatus("codex", true, codex)).toBe("Live questions and approvals enabled");
  expect(jobInteractionStatus("codex", false, codex)).toBe("Offline");
  expect(jobInteractionStatus("claude-code", true)).toBe("Runtime has not reported interaction support");
  expect(jobInteractionStatus("pi", true)).toBe("Live questions and approvals unavailable for this engine");
});

test("a Runtime can offer interaction via an existing Codex connection without API key capability", () => {
  const accountOnly = JobEngineActivityCapability.parse({ ...codex, approvals: false, questions: false, steer: false, account_reuse: true });
  expect(jobInteractionStatus("codex", true, accountOnly, 0)).toBe("Sign in to Codex in Connections to enable live interaction");
  expect(jobInteractionStatus("codex", true, accountOnly, 1)).toBe("Live questions and approvals enabled");
});

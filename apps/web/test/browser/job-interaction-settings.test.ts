import { expect, test } from "bun:test";
import { JobEngineActivityCapability } from "@lumio/schema";
import { jobInteractionStatus } from "../../src/client/job-interaction-settings.ts";

const codex = JobEngineActivityCapability.parse({
  engine: "codex", version: "0.166.0", progress: true, sandbox: "os", approvals: true, questions: true, steer: true,
});

test("live progress alone does not enable questions and approvals", () => {
  expect(jobInteractionStatus(true, { ...codex, approvals: false, questions: false, steer: false }))
    .toBe("Live questions and approvals are not enabled on this runtime");
  expect(jobInteractionStatus(true, { ...codex, questions: false }))
    .toBe("Live questions and approvals are not enabled on this runtime");
  expect(jobInteractionStatus(true, { ...codex, sandbox: "none" }))
    .toBe("Live questions and approvals are not enabled on this runtime");
});

test("distinguishes an online interactive engine from an offline or unreported runtime", () => {
  expect(jobInteractionStatus(true, codex)).toBe("Live questions and approvals enabled");
  expect(jobInteractionStatus(false, codex)).toBe("Offline");
  expect(jobInteractionStatus(true)).toBe("Runtime has not reported interaction support");
});

test("a Runtime can offer interaction via an existing Codex connection without API key capability", () => {
  const accountOnly = JobEngineActivityCapability.parse({ ...codex, approvals: false, questions: false, steer: false, account_reuse: true });
  expect(jobInteractionStatus(true, accountOnly, 0)).toBe("Sign in to Codex in Connections to enable live interaction");
  expect(jobInteractionStatus(true, accountOnly, 1)).toBe("Live questions and approvals enabled");
});


test("Pi uses reported runtime capabilities for the existing interaction option", () => {
  const pi = JobEngineActivityCapability.parse({ ...codex, engine: "pi", version: "1.5.0", steer: false });
  expect(jobInteractionStatus(true, pi)).toBe("Live questions and approvals enabled");
  expect(jobInteractionStatus(true, { ...pi, approvals: false, questions: false, sandbox: "none" }))
    .toBe("Live questions and approvals are not enabled on this runtime");
});

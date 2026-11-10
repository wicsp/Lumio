import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeUsage, runClaudeQuotaTerminal } from "../src/native/claude-quota.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/ai-usage/fake-claude-quota.ts", import.meta.url));
const account = "a".repeat(64);

async function terminal(mode: string, known?: string, expected?: string) {
  const cwd = await mkdtemp(join(tmpdir(), "lumio-claude-quota-test-"));
  try {
    return await runClaudeQuotaTerminal([process.execPath, fixture, mode], cwd, { TERM: "xterm-256color" },
      new AbortController().signal, known, expected, 1800);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("verifies the account and reads only the built-in Claude quota screen in a short-lived terminal", async () => {
  const result = await terminal("ready");
  expect(result).toEqual({ status: "ready", account: expect.stringMatching(/^[0-9a-f]{64}$/),
    windows: [{ id: "five_hour", minutes: 300, used_percent: 32 }, { id: "seven_day", minutes: 10080, used_percent: 64 }] });
});

test("stops at trust, mismatched identity, rate limits and unknown command menus", async () => {
  expect(await terminal("trust")).toEqual({ status: "failed", issue: "trust_required" });
  expect(await terminal("ready", undefined, account)).toEqual({ status: "failed", issue: "account_changed" });
  expect(await terminal("limit", account)).toEqual({ status: "failed", issue: "rate_limited" });
  expect(await terminal("unknown", account)).toEqual({ status: "failed", issue: "unknown_layout" });
});

test("does not infer missing quota or ambiguous reset times from model-specific windows", () => {
  const now = new Date("2026-11-10T01:00:00Z");
  expect(parseClaudeUsage("Current session\n3% used\nResets 5:30am (Etc/UTC)\nCurrent week (Sonnet only)\n90% used", now))
    .toEqual([{ id: "five_hour", minutes: 300, used_percent: 3, resets_at: "2026-11-10T05:30:00.000Z" }]);
  expect(parseClaudeUsage("Current week (all models)\n24% used\nResets 3pm (PST)", now))
    .toEqual([{ id: "seven_day", minutes: 10080, used_percent: 24 }]);
});

import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeQuotaSample } from "@lumio/schema";
import fixture from "../../../fixtures/ai-usage/claude-statusline.json";
import { storeClaudeUsage, publishClaudeUsage } from "../src/claude-usage.ts";
import { readConfig } from "../src/config.ts";
import { codexWindows } from "../src/native/quota.ts";

test("Claude status line saves and reports only new normalized quota for a negotiated binding", async () => {
  const state = await mkdtemp(join(tmpdir(), "lumio-claude-quota-"));
  try {
    const binding = { connection: "aic_01ARZ3NDEKTSV4RRFFQ69G5FAV", generation: crypto.randomUUID() };
    const date = new Date("2026-11-10T01:00:00Z");
    expect(await storeClaudeUsage(state, binding, {}, date)).toBe(false);
    expect(await storeClaudeUsage(state, binding, fixture, date)).toBe(true);
    expect(await storeClaudeUsage(state, binding, fixture, new Date("2026-11-10T02:00:00Z"))).toBe(false);
    expect((await stat(join(state, "claude-usage", "samples.sqlite"))).mode & 0o777).toBe(0o600);
    const config = readConfig({ LUMIO_HUB_URL: "http://127.0.0.1:7420", LUMIO_TOKEN: "synthetic", LUMIO_RUNTIME_NAME: "synthetic", LUMIO_RUNTIME_STATE_DIR: state });
    const sent = new Map<string, string>();
    const reports: ClaudeQuotaSample[] = [];
    let supported = false;
    const transport = (async (_url, init) => {
      if (init?.method === "GET") return supported ? Response.json([binding]) : new Response(null, { status: 404 });
      const body = String(init?.body);
      expect(body).not.toContain("synthetic");
      reports.push(ClaudeQuotaSample.parse(JSON.parse(body)));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const signal = new AbortController().signal;
    await publishClaudeUsage(config, transport, signal, sent);
    expect(reports).toEqual([]);
    supported = true;
    await publishClaudeUsage(config, transport, signal, sent);
    await publishClaudeUsage(config, transport, signal, sent);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ...binding, sampled_at: date.toISOString(), windows: [
      { id: "five_hour", minutes: 300, used_percent: 93.5 }, { id: "seven_day", minutes: 10080, used_percent: 29 },
    ] });
    const changed = { rate_limits: { five_hour: { ...fixture.rate_limits.five_hour, used_percentage: 94 } } };
    expect(await storeClaudeUsage(state, binding, changed, new Date("2026-11-10T03:00:00Z"))).toBe(true);
    expect(await storeClaudeUsage(state, binding, fixture, date)).toBe(false);
    await publishClaudeUsage(config, transport, signal, sent);
    expect(reports[1]?.windows[0]?.used_percent).toBe(94);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("Codex quota parser supports the legacy single bucket and preserves unknown fields", () => {
  expect(codexWindows({ rateLimits: { primary: { usedPercent: 0, resetsAt: null }, secondary: { windowDurationMins: 15 } } }))
    .toEqual([
      { id: "codex:primary", used_percent: 0 },
      { id: "codex:secondary", minutes: 15 },
    ]);
  expect(codexWindows({ rateLimits: { primary: { usedPercent: 150, resetsAt: -1 } } })).toEqual([]);
});

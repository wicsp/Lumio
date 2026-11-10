import { describe, expect, test } from "bun:test";
import { AIConnection, AIQuotaView } from "@lumio/schema";
import { usageGlance, usageRing } from "../../src/client/usage-indicator.ts";

const at = "2026-11-10T12:00:00+08:00";
const connection = (kind: "codex-account" | "claude-code-subscription" | "deepseek", name: string, id: string) => AIConnection.parse({
  id, owner: "act_01JABCDEFGHJKMNPQRSTVWXYZ0", name, kind, host: kind === "deepseek" ? "hub" : "macsp",
  ...(kind === "deepseek" ? { base_url: "https://api.deepseek.com" } : {}), api_key_set: kind === "deepseek", revision: 1, created: at, updated: at,
});
const view = (id: string, extra: Partial<AIQuotaView>) => AIQuotaView.parse({
  connection: id, status: "ready", attention: false, settings: { monitor: true, thresholds: {} }, ...extra,
});
const codex = connection("codex-account", "Codex", "aic_01JABCDEFGHJKMNPQRSTVWXY01");
const claude = connection("claude-code-subscription", "Claude", "aic_01JABCDEFGHJKMNPQRSTVWXY02");
const deepseek = connection("deepseek", "DeepSeek", "aic_01JABCDEFGHJKMNPQRSTVWXY03");
const windows = (five: number, week: number) => [
  { id: "seven_day", minutes: 10080, used_percent: week },
  { id: "five_hour", minutes: 300, used_percent: five },
];

describe("sidebar usage indicator", () => {
  test("subscriptions show the smallest remaining share, bars from short to long windows", () => {
    const glance = usageGlance(claude, view(claude.id, { snapshot: { source: "claude-code", sampled_at: at, windows: windows(66.4, 39) } }));
    expect(glance).toMatchObject({ name: "Claude", level: "ok", remaining: 34, bars: [34, 61], value: "34%" });
  });
  test("attention turns a row low and an exhausted window turns it empty", () => {
    const low = usageGlance(codex, view(codex.id, { attention: true, snapshot: { source: "codex", sampled_at: at, windows: windows(88, 42) } }));
    expect(low).toMatchObject({ level: "low", remaining: 12, value: "12%" });
    const empty = usageGlance(codex, view(codex.id, { snapshot: { source: "codex", sampled_at: at, windows: windows(100, 42) } }));
    expect(empty).toMatchObject({ level: "empty", remaining: 0 });
  });
  test("API balances show the CNY total and become empty when calls are blocked", () => {
    const balances = [{ currency: "USD", total: "3.00", topped_up: "3.00", granted: "0" }, { currency: "CNY", total: "48.20", topped_up: "40.00", granted: "8.20" }] as const;
    expect(usageGlance(deepseek, view(deepseek.id, { snapshot: { source: "deepseek", sampled_at: at, available: true, balances: [...balances] } })))
      .toMatchObject({ level: "ok", value: "¥48.20", bars: [] });
    expect(usageGlance(deepseek, view(deepseek.id, { snapshot: { source: "deepseek", sampled_at: at, available: false, balances: [...balances] } }))?.level).toBe("empty");
  });
  test("unmonitored connections are hidden and broken sources show an issue", () => {
    expect(usageGlance(codex, view(codex.id, { settings: { monitor: false, thresholds: {} } }))).toBeUndefined();
    expect(usageGlance(codex, view(codex.id, { status: "waiting" }))).toMatchObject({ level: "issue", value: "—" });
    expect(usageGlance(claude, view(claude.id, { status: "ready", claude_issue: "login_required",
      snapshot: { source: "claude-code", sampled_at: at, windows: windows(10, 10) } }))?.level).toBe("issue");
    // 离线但还有上次读数时照常显示
    expect(usageGlance(codex, view(codex.id, { status: "offline", snapshot: { source: "codex", sampled_at: at, windows: windows(50, 20) } })))
      .toMatchObject({ level: "ok", remaining: 50 });
  });
  test("the collapsed ring takes the worst level and the smallest remaining share", () => {
    const glances = [
      usageGlance(claude, view(claude.id, { snapshot: { source: "claude-code", sampled_at: at, windows: windows(30, 20) } }))!,
      usageGlance(codex, view(codex.id, { attention: true, snapshot: { source: "codex", sampled_at: at, windows: windows(88, 42) } }))!,
      usageGlance(deepseek, view(deepseek.id, { status: "error" }))!,
    ];
    expect(usageRing(glances)).toEqual({ level: "low", remaining: 12 });
    expect(usageRing([glances[2]!])).toEqual({ level: "issue", remaining: 100 });
    expect(usageRing([])).toBeUndefined();
  });
});

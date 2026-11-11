import { describe, expect, test } from "bun:test";
import { FOCUS_LIMITS, FocusSnapshot, type AIConfiguration } from "@lumio/schema";
import {
  IDLE_BEFORE_NAVIGATE_MS, anchorLabels, buildFocus, canNavigateNow, mainProfile, navigateRoute, refOf, truncateGraphemes,
} from "../../src/client/workbench-assist.ts";

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const TASK = `task_${ULID}`, NOTE = `idea_${ULID}`, at = "2026-11-11T20:00:00+08:00";

describe("focus snapshot (ADR 0060 §1)", () => {
  test("route ids become refs; other route parts are ignored", () => {
    expect(refOf(TASK)).toEqual({ module: "work", id: TASK });
    expect(refOf(NOTE, "  An idea ")).toEqual({ module: "knowledge", id: NOTE, label: "An idea" });
    expect(refOf("tasks")).toBeUndefined();
    expect(refOf("library/papers/He_2020_LightGCN.md")).toBeUndefined();
    expect(refOf(`zzz_${ULID}`)).toBeUndefined();
  });

  test("builds a valid snapshot from the page", () => {
    const focus = buildFocus({ section: "work", id: TASK, label: "XX 优化", selection: "  只跑两个模型 " });
    expect(FocusSnapshot.parse(focus)).toEqual({ section: "work", primary: { module: "work", id: TASK, label: "XX 优化" }, selected: [], selection_text: "只跑两个模型" });
    expect(buildFocus({ section: "overview" })).toEqual({ section: "overview", selected: [] });
  });

  test("settings and trash are not sections; nothing to send gives undefined", () => {
    expect(buildFocus({ section: "settings" })).toBeUndefined();
    expect(buildFocus({ section: "trash", selection: "x" })).toEqual({ selected: [], selection_text: "x" });
  });

  test("selection is cut at grapheme boundaries, then to the byte limit", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(truncateGraphemes(family.repeat(3), 2)).toBe(family.repeat(2));
    const long = buildFocus({ section: "knowledge", selection: "字".repeat(FOCUS_LIMITS.max_selection_graphemes + 50) });
    expect([...new Intl.Segmenter().segment(long!.selection_text!)].length).toBe(FOCUS_LIMITS.max_selection_graphemes);
    const heavy = buildFocus({ section: "knowledge", selection: family.repeat(FOCUS_LIMITS.max_selection_graphemes) });
    expect(FocusSnapshot.safeParse(heavy).success).toBe(true);
    expect(heavy!.selection_text!.startsWith(family)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(heavy)).length).toBeLessThanOrEqual(FOCUS_LIMITS.max_bytes);
  });
});

describe("assistant navigation (ADR 0060 §3)", () => {
  const idle = { now: 10_000, lastActivity: 10_000 - IDLE_BEFORE_NAVIGATE_MS, editing: false, attentive: true };
  test("navigates only when the person is idle, not editing and looking", () => {
    expect(canNavigateNow(idle)).toBe(true);
    expect(canNavigateNow({ ...idle, lastActivity: idle.now - 500 })).toBe(false);
    expect(canNavigateNow({ ...idle, editing: true })).toBe(false);
    expect(canNavigateNow({ ...idle, attentive: false })).toBe(false);
  });
  test("navigate targets map to routes", () => {
    expect(navigateRoute({ action: "navigate", section: "work", target: { module: "work", id: TASK } })).toEqual(["work", TASK]);
    expect(navigateRoute({ action: "navigate", section: "inbox" })).toEqual(["inbox", undefined]);
  });
  test("topic labels prefer fetched titles, then ref labels, then ids", () => {
    const anchors = [{ module: "work" as const, id: TASK, label: "Task" }, { module: "knowledge" as const, id: NOTE }];
    expect(anchorLabels(anchors)).toEqual(["Task", NOTE]);
    expect(anchorLabels(anchors, new Map([[NOTE, "Idea"]]))).toEqual(["Task", "Idea"]);
  });
});

describe("main conversation profile (A1-3)", () => {
  const connection = (id: string, base_url?: string) => ({ id, owner: `act_${ULID}`, name: id, kind: "openai-compatible", host: "hub",
    ...(base_url ? { base_url } : {}), api_key_set: true, revision: 1, created: at, updated: at });
  const profile = (id: string, conn: string, engine = "lumio") => ({ id, owner: `act_${ULID}`, name: id, connection: conn, engine, revision: 1, created: at, updated: at });
  const api = `aic_${ULID}`, codex = "aic_01JABCDEFGHJKMNPQRSTVWXYZ1";
  const config = { connections: [connection(api, "https://api.deepseek.com"), connection(codex)],
    profiles: [profile("aip_01JABCDEFGHJKMNPQRSTVWXYZ1", codex, "codex"), profile(`aip_${ULID}`, api)] } as unknown as AIConfiguration;
  const memory = (value?: string) => ({ getItem: () => value ?? null, setItem: () => {} });

  test("uses an API Lumio profile, never a native one", () => {
    expect(mainProfile(config, memory())).toBe(`aip_${ULID}`);
    expect(mainProfile(config, memory("aip_01JABCDEFGHJKMNPQRSTVWXYZ1"))).toBe(`aip_${ULID}`);
  });
  test("no usable profile leaves it to the Hub's legacy settings", () => {
    expect(mainProfile({ connections: [], profiles: [] }, memory())).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { AIConnection, AIProfile } from "@lumio/schema";
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, settingsSection } from "../../src/client/settings-sections.ts";
import { connectionSummary, profileSummary } from "../../src/client/ai-settings.ts";
import { ZH } from "../../src/client/i18n.ts";

describe("settings sections", () => {
  test("keys are unique, the default exists, and every label and hint is translated", () => {
    const keys = SETTINGS_SECTIONS.map(section => section.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(DEFAULT_SETTINGS_SECTION);
    for (const section of SETTINGS_SECTIONS) { expect(ZH[section.label]).toBeDefined(); expect(ZH[section.hint]).toBeDefined(); }
  });
  test("route ids resolve to a section; empty or unknown ids mean the section list", () => {
    expect(settingsSection("ai")).toBe("ai");
    expect(settingsSection("")).toBeUndefined();
    expect(settingsSection(undefined)).toBeUndefined();
    expect(settingsSection("constructor")).toBeUndefined();
  });
});

describe("AI settings summaries", () => {
  const stamp = "2026-11-08T00:00:00.000Z";
  const api = AIConnection.parse({ id: "aic_01J00000000000000000000000", owner: "act_01J00000000000000000000000", name: "Synthetic API", kind: "deepseek", host: "hub",
    base_url: "https://api.example.test/v1", api_key_set: true, revision: 1, created: stamp, updated: stamp });
  const codex = AIConnection.parse({ ...api, id: "aic_01J00000000000000000000001", name: "Laptop Codex", kind: "codex-account", host: "laptop", base_url: undefined, api_key_set: false });
  test("connection rows name the service and location but never the key", () => {
    expect(connectionSummary(api)).toBe("DeepSeek API · api.example.test · Key saved");
    expect(connectionSummary(codex)).toBe("Codex account · laptop · Official sign-in");
  });
  test("profile rows show connection, model and effort", () => {
    const profile = AIProfile.parse({ id: "aip_01J00000000000000000000000", owner: api.owner, name: "Daily", connection: api.id, engine: "lumio", model: "synthetic-chat", thinking: "default", effort: "high", revision: 1, created: stamp, updated: stamp });
    expect(profileSummary(profile, api)).toBe("Synthetic API · synthetic-chat · high");
    expect(profileSummary({ ...profile, model: "default", effort: undefined }, undefined)).toBe("Missing connection · Client default model · Default effort");
  });
});

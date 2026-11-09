import { expect, test } from "bun:test";
import { AIProfile } from "@lumio/schema";
import { assistantProfiles, defaultAssistantProfile, saveDefaultAssistantProfile } from "../../src/client/assistant-profile.ts";

const stamp = "2026-11-09T00:00:00+08:00";
const api = AIProfile.parse({
  id: "aip_01J00000000000000000000000", name: "Profile A", owner: "act_01J00000000000000000000000",
  connection: "aic_01J00000000000000000000000", engine: "lumio", model: "fixture", revision: 1, created: stamp, updated: stamp,
});
const other = AIProfile.parse({ ...api, id: "aip_01J00000000000000000000001", name: "Profile B" });
const codex = AIProfile.parse({ ...api, id: "aip_01J00000000000000000000002", engine: "codex", model: "default" });

test("new chats use only an explicitly saved, available profile for this owner", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const profiles = [other, api, codex];
  expect(defaultAssistantProfile([], storage)).toBe("");
  expect(defaultAssistantProfile(profiles, storage)).toBe("");
  expect(saveDefaultAssistantProfile(api.owner, api.id, storage)).toBe(true);
  expect(defaultAssistantProfile(profiles, storage)).toBe(api.id);
  expect(defaultAssistantProfile([other, codex], storage)).toBe("");
  expect(defaultAssistantProfile([{ ...api, owner: "act_01J00000000000000000000001" }], storage)).toBe("");
  expect(saveDefaultAssistantProfile(api.owner, "", storage)).toBe(true);
  expect(defaultAssistantProfile(profiles, storage)).toBe("");
});

test("new chats list all profiles, API chats can switch APIs, and native sessions keep their binding", () => {
  const profiles = [api, other, codex];
  expect(assistantProfiles(profiles, false)).toEqual(profiles);
  expect(assistantProfiles(profiles, true)).toEqual([api, other]);
  expect(assistantProfiles(profiles, true, codex.id)).toEqual([codex]);
  expect(assistantProfiles([api, other], true, codex.id)).toEqual([]);
});

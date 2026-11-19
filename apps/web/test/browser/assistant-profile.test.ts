import { expect, test } from "bun:test";
import { AIConfiguration, AIProfile, AssistantDefaultBinding, type AssistantDefaultBindingUpdate } from "@lumio/schema";
import { assistantProfiles, loadAssistantDefault, mainProfile, type AssistantDefaultClient } from "../../src/client/assistant-profile.ts";

const stamp = "2026-11-09T00:00:00+08:00";
const api = AIProfile.parse({
  id: "aip_01J00000000000000000000000", name: "Profile A", owner: "act_01J00000000000000000000000",
  connection: "aic_01J00000000000000000000000", engine: "lumio", model: "fixture", revision: 1, created: stamp, updated: stamp,
});
const other = AIProfile.parse({ ...api, id: "aip_01J00000000000000000000001", name: "Profile B" });
const codex = AIProfile.parse({ ...api, id: "aip_01J00000000000000000000002", engine: "codex", model: "default" });
const legacyKey = `lumio.assistant.default-profile:${api.owner}`;

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key); } };
}

function hub(initial: string | null = null) {
  const sent: AssistantDefaultBindingUpdate[] = [];
  let binding = initial ? AssistantDefaultBinding.parse({ purpose: "assistant.default", profile: initial, revision: 1 }) : null;
  const client: AssistantDefaultClient = {
    assistantDefault: async () => binding,
    setAssistantDefault: async input => {
      sent.push(input);
      binding = input.profile ? AssistantDefaultBinding.parse({ purpose: "assistant.default", profile: input.profile, revision: 2 }) : null;
      return binding;
    },
  };
  return { client, sent };
}

const config = (profiles: AIProfile[]) => AIConfiguration.parse({ connections: [], profiles });

test("the Hub's account default wins and ignores any old browser preference", async () => {
  const local = storage({ [legacyKey]: other.id });
  const { client, sent } = hub(api.id);
  expect(await loadAssistantDefault(client, config([api, other]), local)).toBe(api.id);
  expect(sent).toEqual([]);
});

test("an old browser-only default moves to the Hub once and the local copy is cleared", async () => {
  const local = storage({ [legacyKey]: api.id });
  const { client, sent } = hub();
  expect(await loadAssistantDefault(client, config([api, other]), local)).toBe(api.id);
  expect(sent.map(input => input.profile)).toEqual([api.id]);
  expect(local.values.has(legacyKey)).toBe(false);
  expect(await loadAssistantDefault(client, config([api, other]), local)).toBe(api.id);
  expect(sent).toHaveLength(1);
});

test("a stale or missing browser preference leaves no default", async () => {
  const local = storage({ [legacyKey]: "aip_01J00000000000000000000009" });
  const { client, sent } = hub();
  expect(await loadAssistantDefault(client, config([api]), local)).toBe("");
  expect(local.values.has(legacyKey)).toBe(false);
  expect(await loadAssistantDefault(client, config([]), storage())).toBe("");
  expect(sent).toEqual([]);
});

test("a deleted default profile reads as no default", async () => {
  const { client } = hub(other.id);
  expect(await loadAssistantDefault(client, config([api]), storage())).toBe("");
});

test("the main conversation follows the account default only when it is an API profile", () => {
  const connections = [{ id: api.connection, owner: api.owner, name: "API", kind: "deepseek", host: "hub",
    base_url: "https://api.deepseek.com/v1", api_key_set: true, revision: 1, created: stamp, updated: stamp }];
  const value = AIConfiguration.parse({ connections, profiles: [api, other, codex] });
  expect(mainProfile(value, other.id)).toBe(other.id);
  expect(mainProfile(value, codex.id)).toBe(api.id);
  expect(mainProfile(value)).toBe(api.id);
});

test("new chats list all profiles, API chats can switch APIs, and native sessions keep their binding", () => {
  const profiles = [api, other, codex];
  expect(assistantProfiles(profiles, false)).toEqual(profiles);
  expect(assistantProfiles(profiles, true)).toEqual([api, other]);
  expect(assistantProfiles(profiles, true, codex.id)).toEqual([codex]);
  expect(assistantProfiles([api, other], true, codex.id)).toEqual([]);
});

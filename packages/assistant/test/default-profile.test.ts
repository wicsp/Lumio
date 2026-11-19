import { expect, test } from "bun:test";
import { AssistantConversation, type AssistantModelResponse } from "@lumio/schema";
import { AssistantService, type AssistantModel } from "../src/index.ts";
import { memoryStore } from "./memory-store.ts";

const owner = "act_00000000000000000000000001";
const main = "conv_00000000000000000000000001";
const now = "2026-11-18T15:00:00.000Z";
const reply = (content: string): AssistantModelResponse => ({ content, tool_calls: [] });
const named = (name: string, used: string[]): AssistantModel => ({ async complete() { used.push(name); return reply(name); } });

function scenario(defaultProfile: string | undefined, conversationProfile?: string) {
  const store = memoryStore();
  const used: string[] = [];
  let counter = 0, request = 0;
  store.putConversation(AssistantConversation.parse({ id: main, owner, title: "Synthetic main", revision: 1, created: now, updated: now,
    ...(conversationProfile ? { profile: conversationProfile } : {}) }));
  const service = new AssistantService(store, named("legacy", used), [], {
    now: () => new Date(now), id: prefix => `${prefix}_${String(++counter).padStart(26, "0")}`,
    resolveModel: profile => ({ model: named(profile, used), settings: { model: `${profile}-model` } }),
    defaultProfile: requested => (requested === owner ? defaultProfile : undefined),
  });
  const chat = (profile?: string) => service.chat({ conversation: main, request_id: `synthetic-default-${++request}`, message: "Hello",
    ...(profile ? { profile } : {}) }, owner);
  return { used, chat };
}

const A = "aip_00000000000000000000000001", B = "aip_00000000000000000000000002", C = "aip_00000000000000000000000003";

test("a chat without a profile, like an F18 capture, uses the account default instead of the empty legacy settings (ADR 0083)", async () => {
  const f = scenario(A);
  expect((await f.chat()).turn.status).toBe("done");
  expect(f.used).toEqual([A]);
});

test("an explicit request or conversation profile still wins over the account default", async () => {
  const f = scenario(A, B);
  await f.chat();
  await f.chat(C);
  expect(f.used).toEqual([B, C]);
});

test("without an account default the Hub's legacy model still answers", async () => {
  const f = scenario(undefined);
  await f.chat();
  expect(f.used).toEqual(["legacy"]);
});

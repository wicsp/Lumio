import type { AssistantStore } from "../src/index.ts";
import type { AssistantConversation, AssistantMessage, AssistantTurn, AssistantToolCall, ResourceRef } from "@lumio/schema";

/** Deliberately isolated fixture: no database, files, credentials or vault. */
export function memoryStore(): AssistantStore {
  const conversations = new Map<string, AssistantConversation>();
  const messages = new Map<string, AssistantMessage>();
  const turns = new Map<string, AssistantTurn>();
  const calls = new Map<string, AssistantToolCall>();
  const receipts = new Map<string, { input: string; turn: string }>();
  const anchors = new Map<string, readonly ResourceRef[]>();
  const states = new Map<string, NonNullable<ReturnType<NonNullable<AssistantStore["modelState"]>>>>();
  return {
    transaction: action => action(),
    trash: () => undefined, putTrash() { throw new Error("Not used by this fixture"); },
    conversation: id => conversations.get(id), conversations: owner => [...conversations.values()].filter(value => value.owner === owner),
    putConversation: value => { conversations.set(value.id, value); },
    messages: conversation => [...messages.values()].filter(value => value.conversation === conversation),
    putMessage: value => { messages.set(value.id, value); },
    turns: conversation => [...turns.values()].filter(value => !conversation || value.conversation === conversation),
    putTurn: value => { turns.set(value.id, value); },
    calls: turn => [...calls.values()].filter(value => value.turn === turn), putCall: value => { calls.set(value.id, value); },
    receipt: (owner, request) => receipts.get(`${owner}:${request}`),
    putReceipt: (owner, request, input, turn) => { receipts.set(`${owner}:${request}`, { input, turn }); },
    putContext() {}, memories: () => [], putMemory() {}, removeMemory() {}, memoryReceipt: () => undefined, putMemoryReceipt() {},
    messageAnchors: () => anchors, putMessageAnchors: (message, refs) => { anchors.set(message, refs); },
    enqueueFragment() {}, recentFragments: () => [], nextFragment: () => undefined,
    deferFragment() {}, startFragment: () => false, finishFragment() {},
    putModelState: (message, state) => { states.set(message, state); }, modelState: message => states.get(message),
  };
}

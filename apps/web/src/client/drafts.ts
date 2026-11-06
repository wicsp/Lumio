import { DraftStore } from "./draft-store.ts";
export { DraftStore } from "./draft-store.ts";
let current = new DraftStore("signed-out");
export async function prepareDrafts(token: string): Promise<DraftStore> {
  const hub = document.querySelector<HTMLMetaElement>('meta[name="lumio-hub"]')?.content ?? location.origin;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${hub}\n${token}`));
  const scope = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  let storage: Storage | undefined;
  try { storage = localStorage; } catch { /* Storage is disabled in this browser. */ }
  return new DraftStore(scope, storage);
}
export function useDrafts(store?: DraftStore): void { current = store ?? new DraftStore("signed-out"); }
export function drafts(): DraftStore { return current; }

/** Preserve unsent text without turning it into a comment/message side effect. */
export function textDraft(input: HTMLInputElement | HTMLTextAreaElement, key: string): () => void {
  const store = drafts(), saved = store.read<unknown>(key);
  if (typeof saved === "string") input.value = saved;
  const capture = () => { if (input.value) store.write(key, input.value); else store.remove(key); };
  input.addEventListener("input", capture);
  return capture;
}

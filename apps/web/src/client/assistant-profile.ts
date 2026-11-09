import type { AIProfile } from "@lumio/schema";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const key = (owner: string) => `lumio.assistant.default-profile:${owner}`;

/** A browser preference for this Hub origin and the authenticated profile owner. */
export function defaultAssistantProfile(profiles: readonly AIProfile[], storage?: PreferenceStorage): string {
  const owner = profiles[0]?.owner;
  if (!owner) return "";
  try {
    const saved = (storage ?? localStorage).getItem(key(owner));
    return profiles.find(profile => profile.id === saved)?.id ?? "";
  } catch { return ""; }
}

export function saveDefaultAssistantProfile(owner: string, id: string, storage?: PreferenceStorage): boolean {
  try {
    (storage ?? localStorage).setItem(key(owner), id);
    return true;
  } catch { return false; }
}

export function assistantProfiles(profiles: readonly AIProfile[], existing: boolean, nativeProfile?: string): readonly AIProfile[] {
  if (nativeProfile) return profiles.filter(profile => profile.id === nativeProfile);
  if (existing) return profiles.filter(profile => profile.engine === "lumio");
  return profiles;
}

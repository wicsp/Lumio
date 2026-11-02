/** Browser-owned login state; never store pairing codes or business content. */
export interface SavedLogin { token: string; remember: boolean }
export type LoginScope = "device" | "tab" | "memory";
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface StoredLogin { version: 1; hub: string; token: string }

export class LoginStorage {
  readonly key: string;
  constructor(private hub: string, private tab: () => StoragePort, private device: () => StoragePort) {
    this.key = `lumio.web.login.v1:${encodeURIComponent(hub)}`;
  }
  private read(storage: () => StoragePort): StoredLogin | undefined {
    try {
      const raw = storage().getItem(this.key); if (raw === null) return;
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && "version" in value && value.version === 1 && "hub" in value && value.hub === this.hub && "token" in value && typeof value.token === "string" && value.token.trim()) return value as StoredLogin;
      storage().removeItem(this.key);
    } catch { /* Disabled storage or invalid saved data must not prevent sign-in. */ }
    return undefined;
  }
  load(): SavedLogin | undefined {
    const temporary = this.read(this.tab); if (temporary) return { token: temporary.token, remember: false };
    const remembered = this.read(this.device); if (remembered) return { token: remembered.token, remember: true };
    return undefined;
  }
  save(token: string, remember: boolean): LoginScope {
    this.clear();
    const value = JSON.stringify({ version: 1, hub: this.hub, token } satisfies StoredLogin);
    if (remember) { try { this.device().setItem(this.key, value); return "device"; } catch { /* Try tab-only login below. */ } }
    try { this.tab().setItem(this.key, value); return "tab"; } catch { return "memory"; }
  }
  /** A late rejection must not erase credentials replaced by a different login. */
  clear(token?: string): void {
    for (const storage of [this.tab, this.device]) {
      try { if (token === undefined || this.read(storage)?.token === token) storage().removeItem(this.key); } catch { /* The current in-memory session can still be closed. */ }
    }
  }
}

export function browserLoginStorage(): LoginStorage {
  // The old standalone Web server supplies its fixed upstream Hub origin; when the Hub serves
  // the page itself (ADR 0027) the page origin is the Hub. Origin-scoped browser storage also
  // separates different hosts/ports; this key separates upstream Hub changes.
  const hub = document.querySelector<HTMLMetaElement>('meta[name="lumio-hub"]')?.content || window.location.origin;
  return new LoginStorage(hub, () => window.sessionStorage, () => window.localStorage);
}

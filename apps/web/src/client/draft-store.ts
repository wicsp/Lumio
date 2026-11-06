/** Local recovery copies, isolated by Hub and a hash of the verified credential. */
export interface DraftStorage { readonly length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export class DraftStore {
  private memory = new Map<string, string>();
  private owners = new Map<string, symbol>();
  persistent = true;
  claim(key: string): { read<T>(): T | undefined; write(value: unknown): boolean; remove(): void } {
    const owner = Symbol(key); this.owners.set(key, owner);
    return { read: <T>() => this.read<T>(key), write: value => this.owners.get(key) === owner ? this.write(key, value) : true, remove: () => { if (this.owners.get(key) === owner) this.remove(key); } };
  }
  constructor(private scope: string, private storage?: DraftStorage) {}
  private key(key: string): string { return `lumio.draft.v1:${this.scope}:${key}`; }
  read<T>(key: string): T | undefined {
    try {
      const value = this.memory.get(this.key(key)) ?? this.storage?.getItem(this.key(key));
      if (!value) return;
      const parsed = JSON.parse(value);
      if (parsed.version === 1) return parsed.value as T;
    } catch { /* A damaged or inaccessible recovery copy must not break the app. */ }
    return;
  }
  write(key: string, value: unknown): boolean {
    const data = JSON.stringify({ version: 1, value });
    this.memory.set(this.key(key), data);
    try { if (this.storage) { this.storage.setItem(this.key(key), data); this.persistent = true; return true; } } catch { /* Keep this session's copy. */ }
    this.persistent = false; return false;
  }
  /** Remove every recovery copy in this scope (explicit sign-out). */
  clear(): void {
    const prefix = this.key("");
    for (const key of [...this.memory.keys()]) if (key.startsWith(prefix)) this.memory.delete(key);
    try {
      if (!this.storage) return;
      const keys: string[] = [];
      for (let i = 0; i < this.storage.length; i++) { const key = this.storage.key(i); if (key?.startsWith(prefix)) keys.push(key); }
      for (const key of keys) this.storage.removeItem(key);
    } catch { /* Ignore unavailable storage. */ }
  }
  remove(key: string): void {
    this.memory.delete(this.key(key));
    try { this.storage?.removeItem(this.key(key)); } catch { /* Ignore unavailable storage. */ }
  }
}

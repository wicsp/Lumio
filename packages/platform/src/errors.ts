export class PlatformError extends Error {
  constructor(public readonly code: string, public readonly params: { key: string; args: readonly unknown[] }) { super(code); this.name = "PlatformError"; }
}

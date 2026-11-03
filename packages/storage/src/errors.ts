export class StorageError extends Error {
  constructor(public readonly code: "INVALID" | "CONFLICT" | "NOT_FOUND" | "CORRUPT" | "INTERNAL", public readonly params: { key: string; args: readonly unknown[] }) {
    super(code); this.name = "StorageError";
  }
}

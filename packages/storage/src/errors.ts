export class StorageError extends Error {
  constructor(public readonly code: "INVALID" | "CONFLICT" | "NOT_FOUND" | "CORRUPT" | "INTERNAL", message: string) {
    super(message); this.name = "StorageError";
  }
}

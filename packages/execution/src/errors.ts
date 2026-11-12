import type { ApiError, ApiErrorCode } from "@lumio/schema";
export class ExecutionError extends Error {
  constructor(public readonly code: ApiErrorCode, public readonly params: { key: string; args: readonly unknown[] }, public readonly details: Omit<ApiError["error"], "code" | "message"> = {}) {
    super(code); this.name = "ExecutionError";
  }
}

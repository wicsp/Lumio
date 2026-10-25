import type { ApiError, ApiErrorCode } from "@lumio/schema";

export class HubError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string, public readonly details: Omit<ApiError["error"], "code" | "message"> = {}) {
    super(message);
    this.name = "HubError";
  }
}

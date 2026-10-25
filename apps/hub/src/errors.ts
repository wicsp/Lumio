import type { ApiErrorCode } from "@lumio/schema";

export class HubError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string) {
    super(message);
    this.name = "HubError";
  }
}

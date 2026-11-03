export class CoreError extends Error {
  constructor(public readonly code: string, public readonly params: { key: string; args: readonly unknown[] }, options?: ErrorOptions) {
    super(code, options);
    this.name = "CoreError";
  }
}

import { createPairer } from "@lumio/platform";
import { version } from "./version.ts";
export { PairingError } from "@lumio/platform";
const sharedPair = createPairer(version);

export function pair<T>(base: string, code: string, kind: "client" | "runtime", schema: { parse(value: unknown): T }, fetcher = globalThis.fetch, warn: (line: string) => void = console.error): Promise<T> {
  return sharedPair(base, code, kind, schema, fetcher, warn);
}

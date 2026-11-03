import { text } from "./messages.ts";
import { diagnosticIO as sharedIO, printChecks as sharedPrint } from "@lumio/platform";
export { timedFetch, httpURL, localAddress, environment, serviceCommand } from "@lumio/platform";
export type { Check, CommandResult, DiagnosticOptions } from "@lumio/platform";
export function diagnosticIO(options: Parameters<typeof sharedIO>[0] = {}) { return sharedIO({ ...options, text: options.text ?? text }); }
export function printChecks(checks: Parameters<typeof sharedPrint>[0], json: boolean, log: (line: string) => void, options: Parameters<typeof sharedPrint>[3] = {}) { return sharedPrint(checks, json, log, { ...options, text: options.text ?? text }); }

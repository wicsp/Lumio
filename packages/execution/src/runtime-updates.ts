import { ExecutionRuntimeUpdateCommandRequest, RuntimeUpdateDirective, RuntimeUpdateReport, RuntimeUpdateView, type RuntimeInfo, type RuntimeUpdatePolicy } from "@lumio/schema";
import { ExecutionError } from "./errors.ts";

export interface RuntimeUpdateRecord {
  policy: RuntimeUpdatePolicy;
  version?: string;
  hold: boolean;
  restart_now?: string;
  retry?: string;
  report?: RuntimeUpdateReport;
}
export interface RuntimeUpdateStore {
  get(actor: string): RuntimeUpdateRecord | undefined;
  put(actor: string, value: RuntimeUpdateRecord): void;
  receipt(owner: string, request: string): { fingerprint: string; result: RuntimeUpdateView } | undefined;
  saveReceipt(owner: string, request: string, fingerprint: string, result: RuntimeUpdateView): void;
  transaction<T>(action: () => T): T;
}
const initial = (): RuntimeUpdateRecord => ({ policy: "follow", hold: false });
/** Desired-version policy is independent of transport, disk layout, and signature trust. */
export class RuntimeUpdates {
  constructor(private readonly store: RuntimeUpdateStore, private readonly version: () => string) {}
  private desired(runtime: RuntimeInfo, value: RuntimeUpdateRecord): string | undefined {
    return value.policy === "follow" && runtime.registration.features?.includes("self_update") ? this.version() : undefined;
  }
  view(runtime: RuntimeInfo): RuntimeUpdateView {
    const value = this.store.get(runtime.actor) ?? initial(), desired = this.desired(runtime, value);
    return RuntimeUpdateView.parse({ policy: value.policy, desired, hold: value.version === desired && value.hold, report: value.report });
  }
  directive(runtime: RuntimeInfo): RuntimeUpdateDirective | undefined {
    const value = this.store.get(runtime.actor) ?? initial(), version = this.desired(runtime, value);
    if (!version) return;
    return RuntimeUpdateDirective.parse({ version, hold: value.version === version && value.hold,
      ...(value.version === version ? { restart_now: value.restart_now, retry: value.retry } : {}) });
  }
  report(runtime: RuntimeInfo, report?: RuntimeUpdateReport): void {
    if (!runtime.registration.features?.includes("self_update") || !report) return;
    const value = this.store.get(runtime.actor) ?? initial();
    this.store.put(runtime.actor, { ...value, report: RuntimeUpdateReport.parse(report) });
  }
  command(runtime: RuntimeInfo, owner: string, input: ExecutionRuntimeUpdateCommandRequest): RuntimeUpdateView {
    const request = ExecutionRuntimeUpdateCommandRequest.parse(input), { operation, request_id } = request;
    return this.store.transaction(() => {
      const value = this.store.get(runtime.actor) ?? initial(), desired = this.desired(runtime, value);
      if ("version" in operation.args && operation.args.version !== desired) throw new ExecutionError("CONFLICT", { key: "runtime.update_conflict", args: [] });
      const fingerprint = JSON.stringify(operation), previous = this.store.receipt(owner, request_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ExecutionError("CONFLICT", { key: "runtime.update_conflict", args: [] });
        return previous.result;
      }
      if (value.version !== desired) { value.hold = false; delete value.restart_now; delete value.retry; }
      value.version = desired;
      switch (operation.op) {
        case "execution.runtime.update.policy": value.policy = operation.args.policy; value.hold = false; delete value.restart_now; delete value.retry; break;
        case "execution.runtime.update.hold": value.hold = operation.args.hold; delete value.restart_now; break;
        case "execution.runtime.update.restart_now": value.restart_now = request_id; value.hold = false; break;
        case "execution.runtime.update.retry": value.retry = request_id; break;
      }
      this.store.put(runtime.actor, value);
      const result = this.view(runtime);
      this.store.saveReceipt(owner, request_id, fingerprint, result);
      return result;
    });
  }
}
export function runtimeDraining(runtime: RuntimeInfo): boolean {
  return !!runtime.registration.features?.includes("self_update") && !runtime.update?.hold &&
    !!runtime.update?.desired && runtime.update.report?.target === runtime.update.desired &&
    ["draining", "restarting"].includes(runtime.update.report.state);
}

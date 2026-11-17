import type { JobEngineActivityCapability, RuntimeInfo } from "@lumio/schema";
import type { Client } from "./api.ts";
import { clear, h } from "./dom.ts";
import { t } from "./i18n.ts";

export function jobInteractionStatus(online: boolean, capability?: JobEngineActivityCapability, codexConnections = 0) {
  if (!online) return "Offline";
  if (!capability) return "Runtime has not reported interaction support";
  if (capability.sandbox === "os" && ((capability.approvals && capability.questions) || (capability.account_reuse && codexConnections))) return "Live questions and approvals enabled";
  if (capability.account_reuse) return "Sign in to Codex in Connections to enable live interaction";
  return "Live questions and approvals are not enabled on this runtime";
}

export function jobInteractionChoice(input: {
  available: boolean; required: boolean; fullAccess: boolean; workdir: string; preferInteractive: boolean;
}) {
  const needsProjectDirectory = input.workdir === "~" || input.workdir === "~/";
  const selectable = input.available && !input.fullAccess && !needsProjectDirectory;
  return { selectable, needsProjectDirectory,
    checked: input.required || (selectable && input.preferInteractive), disabled: input.required || !selectable };
}

export class JobInteractionSettings {
  readonly element = h("div", { class: "set-rows" });
  private active = true;
  private rows = h("div", { role: "status" });
  private refresh = h("button", { type: "button", class: "btn btn-small", onclick: () => void this.load() }, t("Refresh"));

  constructor(private client: Client) {
    this.element.append(this.rows, h("div", { class: "set-row" },
      h("a", { href: "https://github.com/wicsp/Lumio/blob/main/docs/design/execution.md", target: "_blank", rel: "noopener noreferrer" },
        t("Runtime configuration instructions")), this.refresh));
    void this.load();
  }

  dispose(): void { this.active = false; }

  private async load(): Promise<void> {
    this.refresh.disabled = true;
    clear(this.rows, h("p", { class: "set-empty" }, t("Loading…")));
    try {
      const [runtimes, capabilities] = await Promise.all([this.client.runtimes(), this.client.jobActivityCapabilities()]);
      if (!this.active) return;
      const rows = runtimes.flatMap(runtime => {
        const reported = capabilities.find(value => value.runtime === runtime.actor);
        return runtime.registration.engines.map(engine => {
          const cap = reported?.engines.find(value => value.engine === engine.name && value.version === engine.version);
          return this.engineRow(runtime, engine.name, runtime.online && (reported?.online ?? true), cap,
            cap?.account_reuse ? reported?.codex_connections?.map(connection => connection.name) ?? [] : []);
        });
      });
      clear(this.rows, ...(rows.length ? rows : [h("p", { class: "set-empty" }, t("No registered runtime engines"))]));
    } catch {
      if (this.active) clear(this.rows, h("p", { class: "set-empty" }, t("Could not load runtime capabilities")));
    } finally { this.refresh.disabled = false; }
  }

  private engineRow(runtime: RuntimeInfo, engine: string, online: boolean, cap: JobEngineActivityCapability | undefined, connections: string[]): HTMLElement {
    return h("div", { class: "set-row" },
      h("span", { class: "set-label" }, `${engine} @ ${runtime.registration.name}`, online && cap?.progress &&
        h("span", { class: "set-sub" }, t("Live task progress available")), online && (connections.length > 0
        ? h("span", { class: "set-sub" }, t("Existing Codex connections: {0}", connections.join(", ")))
        : cap?.approvals && cap.questions && h("span", { class: "set-sub" }, t("Uses the runtime’s API key")))),
      h("span", { class: "set-value muted" }, t(jobInteractionStatus(online, cap, connections.length))));
  }
}

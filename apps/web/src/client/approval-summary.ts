import type { ApprovalSummaryResult } from "@lumio/schema";
import type { Client } from "./api.ts";
import { clear, h } from "./dom.ts";
import { t, translated } from "./i18n.ts";

const ACCESS = translated({ read: "Read only", write: "May write", unknown: "Cannot determine" });
const NETWORK = translated({
  none: "No network action identified", connection: "Connects to a network destination",
  exposure: "May expose a service", unknown: "Cannot determine",
});
const RECOMMENDATION = translated({ approve: "Suggest approval", caution: "Use caution", reject: "Suggest rejection" });

export function approvalSummaryCard(client: Client, proposal: string): HTMLElement {
  let result: ApprovalSummaryResult | undefined;
  let busy = false;
  let retryRead = false;
  const content = h("div", { class: "approval-ai-content", role: "status" });
  const action = h("button", { class: "btn btn-small", type: "button" });
  const panel = h("section", { class: "section approval-ai" },
    h("div", { class: "section-head" }, h("h3", {}, t("AI command summary")), h("div", { class: "detail-actions" }, action)),
    h("p", { class: "muted" }, t("AI-generated guidance. You decide whether to approve.")),
    content);

  const summary = () => result?.status === "ready" ? result.summary : result?.status === "failed" ? result.previous : undefined;
  function render(): void {
    const previous = summary();
    const model = previous?.model ?? (result && "model" in result ? result.model : undefined);
    action.disabled = busy;
    action.hidden = (!result && !retryRead) || result?.status === "disabled" || result?.status === "blocked";
    action.textContent = result?.status === "ready" ? t("Refresh summary")
      : result?.status === "empty" ? t("Generate summary") : t("Retry");
    clear(content,
      model && h("p", { class: "muted" }, t("Model"), " · ", model),
      previous
        ? h("div", { class: "approval-ai-content" },
          h("p", {}, previous.intent),
          h("dl", { class: "meta-grid" },
            h("div", {}, h("dt", {}, t("File access")), h("dd", {}, ACCESS[previous.access])),
            h("div", {}, h("dt", {}, t("Affected machines or paths")), h("dd", {}, previous.targets.length
              ? h("ul", { class: "approval-ai-targets" }, ...previous.targets.map(value => h("li", {}, h("code", {}, value))))
              : t("None identified from the command"))),
            h("div", {}, h("dt", {}, t("Privilege")), h("dd", {}, t("Runs as administrator"))),
            h("div", {}, h("dt", {}, t("Network")), h("dd", {}, NETWORK[previous.network]))),
          h("p", {}, h("strong", {}, RECOMMENDATION[previous.recommendation]), " · ", previous.reason))
        : !busy && h("p", {}, t("No summary available")),
      result?.status === "empty" && h("p", { class: "muted" }, t("Generating a summary sends the command arguments to the configured model service.")),
      result?.status === "disabled" && h("p", { class: "muted" }, t("No command summary model is configured for this account.")),
      result?.status === "blocked" && h("p", { class: "muted" }, result.reason === "sensitive"
        ? t("The command may contain secrets. Its arguments were kept on the Hub.")
        : t("The command is too long to summarize.")),
      !busy && result?.status === "failed" && previous && h("p", { class: "muted" }, t("Refresh failed. Showing the previous summary.")),
      busy && h("p", { class: "muted" }, result ? t("Generating summary…") : t("Checking for a summary…")));
  }

  async function load(generate = false): Promise<void> {
    if (busy) return;
    busy = true;
    const previous = summary();
    const model = result && "model" in result ? result.model : previous?.model;
    render();
    try {
      const signal = AbortSignal.timeout(15_000);
      result = await (generate
        ? client.generateApprovalSummary(proposal, previous ? { refresh: true } : {}, signal)
        : client.approvalSummary(proposal, signal));
      retryRead = false;
    } catch {
      if (generate && model) result = { status: "failed", model, ...(previous ? { previous } : {}) };
      else { result = undefined; retryRead = true; }
    } finally {
      busy = false;
      render();
    }
  }
  action.addEventListener("click", () => void load(!retryRead));
  void load();
  return panel;
}

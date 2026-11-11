import { AIQuotaSettings, type AIConnection, type AIQuotaView, type AIQuotaWindow } from "@lumio/schema";
import { errorText, type Client } from "./api.ts";
import { clear, failure, h, openDialog, toast } from "./dom.ts";
import { t, translated } from "./i18n.ts";
import { formatTime } from "./commands.ts";

const CLAUDE_ISSUE = translated({
  login_required: "Sign in to Claude Code for background refresh",
  trust_required: "Claude Code requires trust for the usage workspace",
  account_unverified: "Claude Code did not identify the signed-in account",
  account_changed: "Claude Code account changed",
  version_unsupported: "Claude Code version or device policy is unsupported",
  unknown_layout: "Claude Code usage panel could not be read",
  rate_limited: "Claude Code is rate limiting usage queries",
  timeout: "Claude Code usage query timed out",
});
const STATUS = translated({
  ready: "Up to date", waiting: "Waiting for first reading", offline: "Runtime disconnected",
  credentials: "Sign-in or API key required", unsupported: "Usage unavailable for this source",
  error: "Usage refresh failed", stale: "Previous reading",
});

export function amount(currency: string, value: string): string {
  return currency === "CNY" ? `¥${value}` : `$${value}`;
}

function windowLabel(window: AIQuotaWindow): string {
  const minutes = window.minutes;
  const length = !minutes ? "" : minutes % 1440 === 0 ? t("{0} days", minutes / 1440)
    : minutes % 60 === 0 ? t("{0} hours", minutes / 60) : t("{0} minutes", minutes);
  const label = window.label ?? (window.id.startsWith("codex:") || window.id === "five_hour" || window.id === "seven_day" ? "" : window.id.split(":")[0]);
  return [label, length].filter(Boolean).join(" · ") || t("Quota window");
}

function percentage(used: number): number {
  return Math.round((100 - used) * 100) / 100;
}

export function windowRow(window: AIQuotaWindow): HTMLElement {
  const label = windowLabel(window);
  const remaining = window.used_percent === undefined ? undefined : percentage(window.used_percent);
  const expired = window.resets_at && Date.parse(window.resets_at) <= Date.now();
  return h("div", { class: "ai-quota-window" },
    h("span", {}, label),
    remaining === undefined ? h("span", {}, t("Remaining unknown")) :
      h("span", {}, h("meter", { min: 0, max: 100, value: remaining, "aria-label": `${label} · ${t("Remaining {0}%", remaining)}` }),
        h("strong", {}, t("Remaining {0}%", remaining))),
    h("span", { class: "set-sub" }, expired ? t("Window ended · waiting for an update")
      : window.resets_at ? t("Resets {0}", formatTime(window.resets_at)) : t("Reset time unknown")));
}

export function usageSummary(usage: AIQuotaView): string {
  const snapshot = usage.snapshot;
  const label = usage.attention ? t("Needs attention") : t(usage.claude_issue ? CLAUDE_ISSUE[usage.claude_issue] : STATUS[usage.status]);
  if (!snapshot) return label;
  const status = usage.status === "ready" ? label : `${label} · ${formatTime(snapshot.sampled_at)}`;
  if (snapshot.source === "deepseek") {
    return [...snapshot.balances.map(balance => amount(balance.currency, balance.total)), status].join(" · ");
  }
  const windows = snapshot.windows.filter(window => window.used_percent !== undefined)
    .slice(0, 2).map(window => `${windowLabel(window)} ${t("Remaining {0}%", percentage(window.used_percent!))}`);
  return [...windows, status].join(" · ");
}

export function usageDetails(connection: AIConnection, usage: AIQuotaView, client: Client, updated: (usage: AIQuotaView) => void): HTMLElement {
  const isClaude = connection.kind === "claude-code-subscription";
  const background = isClaude && usage.settings.claude_mode === "background";
  const snapshot = usage.snapshot;
  const details = h("details", { class: "ai-quota-details", "data-connection": connection.id },
    h("summary", {}, t("Usage & balance"), h("span", { class: "set-sub" }, usageSummary(usage))));
  const message = h("div", { role: "status" });
  const actions = h("div", { class: "button-row" });
  const action = (label: string, run: () => Promise<AIQuotaView>, feedback = message) => {
    const button = h("button", { type: "button", class: "btn btn-small" }, t(label));
    button.onclick = async () => {
      button.disabled = true;
      clear(feedback);
      try { updated(await run()); }
      catch (cause) { clear(feedback, failure(errorText(cause))); }
      finally { button.disabled = false; }
    };
    return button;
  };
  if (background || (!isClaude && usage.status !== "unsupported")) actions.append(action("Refresh usage", () => client.refreshAIUsage(connection.id)));
  if (usage.status !== "unsupported" || isClaude) actions.append(h("button", { type: "button", class: "btn btn-small",
    onclick: () => settingsDialog(connection, usage, client, updated) }, t("Monitoring settings")));
  const replaceBinding = (label: string, hint: string) => h("button", { type: "button", class: "btn btn-small", onclick: () => {
    const feedback = h("div", { role: "status" });
    const replace = action(label, async () => {
      const result = await client.bindClaudeUsage(connection.id);
      dialog.close();
      return result;
    }, feedback);
    const dialog = openDialog(t(label), h("div", {}, h("p", {}, t(hint)), feedback), [replace]);
  } }, t(label));
  if (background) {
    details.append(h("p", { class: "field-hint" }, t(usage.settings.monitor
      ? "Claude Code is queried in the background every 15 minutes." : "Automatic Claude Code refresh is paused.")));
    if (usage.claude_issue === "login_required") {
      details.append(h("p", { class: "field-hint" }, t("On {0}, sign in through Claude Code with this command, then refresh usage.", connection.host)),
        h("pre", { class: "ai-quota-command" }, h("code", {}, "lumio runtime claude-quota-login")));
    } else if (usage.claude_issue === "trust_required") {
      details.append(h("p", { class: "field-hint" }, t("On {0}, run this command, approve the dedicated folder if prompted, and exit Claude Code.", connection.host)),
        h("pre", { class: "ai-quota-command" }, h("code", {}, "lumio runtime claude-quota-login --trust")));
    } else if (usage.claude_issue === "account_changed") {
      actions.append(replaceBinding("Confirm new Claude account", "The next successful query will bind this connection to the newly signed-in account."));
    }
  } else if (isClaude) {
    actions.append(action("Use background refresh", () => client.saveAIUsageSettings(connection.id,
      { ...usage.settings, claude_mode: "background", monitor: true })));
    if (usage.claude_binding) {
      const { connection: id, generation } = usage.claude_binding;
      const settings = JSON.stringify({ statusLine: { type: "command", command: `lumio runtime claude-usage-sample ${id} ${generation}` } });
      details.append(h("p", { class: "field-hint" }, t("Run this on {0} in a Claude Code session signed in to the subscription you want to monitor.", connection.host)),
        h("pre", { class: "ai-quota-command" }, h("code", {}, `claude --settings '${settings}'`)),
        h("p", { class: "field-hint" }, t("If you already have a status line, add the sampling command to your existing script. Use --state-dir if this runtime has a custom state directory.")));
      actions.append(replaceBinding("Replace sampling setup", "After switching Claude accounts, replace the setup to clear old readings and get a new command."));
    } else actions.append(action("Set up Claude sampling", () => client.bindClaudeUsage(connection.id)));
  }
  if (snapshot?.source === "deepseek") {
    for (const balance of snapshot.balances) details.append(h("div", { class: "ai-quota-window" },
      h("strong", {}, `${amount(balance.currency, balance.total)} ${balance.currency}`),
      h("span", {}, t("Topped up {0} · Granted {1}", amount(balance.currency, balance.topped_up), amount(balance.currency, balance.granted)))));
    if (!snapshot.available) details.append(h("p", { class: "field-hint" }, t("DeepSeek reports insufficient balance for API calls.")));
  } else if (snapshot) {
    details.append(...snapshot.windows.map(windowRow));
  }
  if (snapshot) details.append(h("p", { class: "field-hint" }, t(snapshot.source === "claude-code" && !snapshot.collection ? "Last session sample {0}" : "Last successful reading {0}", formatTime(snapshot.sampled_at))));
  details.append(actions, message);
  return details;
}

function settingsDialog(connection: AIConnection, usage: AIQuotaView, client: Client, updated: (usage: AIQuotaView) => void): void {
  const monitor = h("input", { type: "checkbox", checked: usage.settings.monitor });
  const field = (label: string, value: string) => {
    const input = h("input", { type: "text", value, inputmode: "decimal", autocomplete: "off" });
    return { input, element: h("label", { class: "field" }, h("span", { class: "field-label" }, t(label)), input) };
  };
  const isClaude = connection.kind === "claude-code-subscription";
  const mode = h("select", {},
    h("option", { value: "sample" }, t("Session sampling")),
    h("option", { value: "background" }, t("Background refresh")));
  mode.value = usage.settings.claude_mode ?? "sample";
  mode.onchange = () => { if (mode.value === "background") monitor.checked = true; };
  const thresholds = usage.settings.thresholds;
  const cny = field("CNY balance below", thresholds.CNY ?? "");
  const usd = field("USD balance below", thresholds.USD ?? "");
  const percent = field("Remaining quota below (%)", thresholds.remaining_percent?.toString() ?? "");
  const message = h("div", { role: "status" });
  const form = h("form", { class: "form-stack" },
    isClaude && h("label", { class: "field" }, h("span", { class: "field-label" }, t("Claude Code usage source")), mode),
    h("label", { class: "field" }, h("span", { class: "field-label" }, monitor, " ", t("Enable monitoring"))),
    h("p", { class: "field-hint" }, t("Leave a threshold blank to skip that alert. Enable AI usage alerts in your device’s notification settings.")),
    ...(connection.kind === "deepseek" ? [cny.element, usd.element] : [percent.element]), message);
  const save = h("button", { type: "button", class: "btn btn-primary", onclick: () => form.requestSubmit() }, t("Save"));
  const dialog = openDialog(t("Monitoring settings"), form, [save]);
  form.onsubmit = async event => {
    event.preventDefault();
    const remaining = percent.input.value.trim();
    const settings = AIQuotaSettings.safeParse({ monitor: monitor.checked, claude_mode: isClaude ? mode.value : undefined, thresholds: connection.kind === "deepseek"
      ? { CNY: cny.input.value.trim() || undefined, USD: usd.input.value.trim() || undefined }
      : { remaining_percent: remaining ? (/^\d+(\.\d+)?$/.test(remaining) ? Number(remaining) : NaN) : undefined } });
    if (!settings.success) { clear(message, failure(t("Enter a valid balance or a percentage between 0 and 100."))); return; }
    save.disabled = true;
    try {
      const result = await client.saveAIUsageSettings(connection.id, settings.data);
      dialog.close();
      updated(result);
      toast(t("Saved."));
    } catch (cause) { clear(message, failure(errorText(cause))); }
    finally { save.disabled = false; }
  };
}

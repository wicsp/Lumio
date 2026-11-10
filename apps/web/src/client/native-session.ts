import type { NativeSession, NativeAction, NativeEventRecord } from "@lumio/schema";
import type { Client } from "./api.ts";
import { errorText } from "./api.ts";
import { h, clear, failure, toast } from "./dom.ts";
import { t } from "./i18n.ts";
const LABEL: Record<string, string> = { starting: "Starting Codex", login_required: "Sign in to Codex", ready: "Ready", running: "Working", awaiting_approval: "Waiting for your approval", recovering: "Restoring session", unknown: "Execution outcome needs review", failed: "Session unavailable", closed: "Session closed", offline: "Runtime disconnected" };
export class NativeSessionPanel {
    readonly element = h("div", { class: "native-panel", hidden: true });
    private status = h("div", { class: "native-status" });
    private controls = h("div", { class: "button-row" });
    private advanced = h("details", { class: "native-advanced" });
    private restoreAttempted = false;
    private approvals = h("div", {});
    private history = h("div", { class: "native-history-list" });
    readonly activity = h("details", { class: "native-history", hidden: true },
        h("summary", {}, t("Codex activity")), this.history);
    private toolbar = h("div", { class: "native-toolbar" }, this.status, this.controls, this.advanced);
    private model = h("select", { "aria-label": t("Model") });
    private effort = h("select", { "aria-label": t("Thinking effort") });
    private id?: string;
    private active = true;
    private timer?: ReturnType<typeof setTimeout>;
    private generation = 0;
    private after = 0;
    private summary = new Map<string, HTMLElement>();
    private tools = new Map<string, { entry: HTMLDetailsElement; label: HTMLElement; body: HTMLElement }>();
    private optionsKey = "";
    private effortKey = "";
    private desiredModel = "";
    private desiredEffort = "";
    private busy = false;
    private configured = false;
    private formKey = "";
    session?: NativeSession;
    get bound(){return !!this.id;}
    constructor(private client: Client, private ready: (ready: boolean) => void, private openSettings: () => void) { this.element.append(this.approvals, this.toolbar); this.controls.append(this.model, this.effort); this.model.addEventListener("change", () => { this.desiredModel = this.model.value; this.efforts(); }); this.effort.addEventListener("change", () => { this.desiredEffort = this.effort.value; this.efforts(); }); }
    dispose() { this.active = false; clearTimeout(this.timer); this.generation++; }
    bind(id?: string, model = "") { if (id === this.id)
        return; this.generation++; clearTimeout(this.timer); this.busy = false; this.id = id; this.session = undefined; this.after = 0; this.summary.clear(); this.tools.clear(); this.optionsKey = ""; this.effortKey = ""; this.desiredModel = model; this.restoreAttempted = false; this.desiredEffort = ""; this.configured = false; this.formKey = ""; clear(this.history); this.activity.hidden = true; this.activity.open = false; clear(this.status); clear(this.approvals); this.controls.hidden = true; this.advanced.hidden = true; this.advanced.open = false; this.element.hidden = !id; if (id) {
        this.ready(false);
        void this.poll(this.generation);
    }
    else
        this.ready(true); }
    settings() { return this.id ? { ...(this.model.value ? { model: this.model.value } : {}), effort: this.effort.value || "default" } : {}; }
    private async poll(generation: number) { if (!this.id || !this.active)
        return; try {
        const [s, events] = await Promise.all([this.client.nativeSession(this.id), this.client.nativeEvents(this.id, this.after)]);
        if (generation !== this.generation || !this.active)
            return;
        if (!this.configured) {
            this.desiredEffort = s.profile.effort ?? "";
            this.configured = true;
        }
        this.session = s;
        this.render(s);
        if (s.view.state === "ready") this.restoreAttempted = false;
        if (s.view.state === "offline" && !s.quarantined && !this.restoreAttempted) {
            this.restoreAttempted = true;
            void this.action({ action: "resume" }, true);
        }
        for (const e of events) {
            this.after = e.sequence;
            this.event(e);
        }
    }
    catch (e) {
        if (generation === this.generation) {
            clear(this.status, failure(errorText(e)));
            this.ready(false);
        }
    }
    finally {
        if (this.active && generation === this.generation)
            this.timer = setTimeout(() => void this.poll(generation), 1000);
    } }
    private efforts() {
        const choices = this.session?.view.models.find(model => model.id === this.model.value)?.efforts ?? [];
        const valid = !this.desiredEffort || choices.includes(this.desiredEffort);
        const key = JSON.stringify([choices, this.desiredEffort]);
        if (key !== this.effortKey) {
            this.effortKey = key;
            clear(this.effort, h("option", { value: "" }, t("Default effort")),
                ...(!valid ? [h("option", { value: this.desiredEffort, selected: true, disabled: true }, t("Choose a supported effort"))] : []),
                ...choices.map(value => h("option", { value, selected: value === this.desiredEffort }, value)));
        }
        this.ready(valid && this.session?.view.state === "ready" && !this.session.quarantined);
    }
    private render(s: NativeSession) {
        const label = t(LABEL[s.view.state] ?? "Session unavailable");
        if (this.status.textContent !== label) this.status.textContent = label;
        this.status.dataset.state = s.view.state;
        const selected = [this.desiredModel, s.profile.model, s.view.model, s.view.default_model]
            .find(value => s.view.models.some(model => model.id === value));
        const optionsKey = JSON.stringify([s.view.models, selected]);
        if (optionsKey !== this.optionsKey) {
            this.optionsKey = optionsKey;
            clear(this.model, ...s.view.models.map(m => h("option", { value: m.id, selected: m.id === selected }, m.id)));
        }
        this.controls.hidden = !s.view.models.length;
        this.efforts();
        this.model.disabled = this.effort.disabled = s.view.state !== "ready";
        if (!this.advanced.firstChild) this.advanced.append(h("summary", {}, t("Advanced")),
            h("button", { type: "button", class: "btn btn-small", onclick: () => {
                this.advanced.open = false;
                if (this.session?.view.state === "ready" && !this.session.quarantined) void this.action({ action: "compact" });
            } }, t("Compact context")));
        this.advanced.hidden = s.view.state !== "ready";
        const formKey = JSON.stringify([s.view.state, s.view.approval, s.view.error, s.quarantined, s.view.stopped]);
        if (formKey === this.formKey)
            return;
        this.formKey = formKey;
        clear(this.approvals);
        if (s.view.state === "failed" || s.view.state === "offline") {
            if (s.view.error === "native.connection_sign_in" || s.view.error === "native.login_required") {
                this.approvals.append(h("button", { type: "button", class: "btn btn-small", onclick: this.openSettings }, t("Open AI settings")));
            }
            if (!["native.account_changed", "native.rebuild_required", "native.context_expired", "native.state_lost"].includes(s.view.error ?? "")) {
                this.approvals.append(h("button", { type: "button", class: "btn btn-small", disabled: s.quarantined, onclick: () => void this.action({ action: "resume" }) }, t("Restore session")));
            }
        }
        if (s.view.state === "login_required")
            this.approvals.append(h("p", { class: "notice" }, t("Sign in to this Codex connection in AI settings.")),
                h("button", { type: "button", class: "btn btn-small", onclick: this.openSettings }, t("Open AI settings")));
        if (s.view.error)
            this.approvals.append(h("p", { class: "notice" }, t(({ "native.connection_sign_in": "Sign in to this Codex connection in AI settings.", "native.login_required": "Sign in to this Codex connection in AI settings.", "native.account_changed": "This chat belongs to a different Codex account.", "native.rebuild_required": "This chat’s connection changed. Start a new chat.", "native.context_expired": "Saved context changed. Start a new chat." } as Record<string, string>)[s.view.error] ?? "The session could not continue safely. Review the saved history before starting another operation.")));
        const approval = s.view.approval;
        if (approval) {
            const answers: Record<string, string[]> = {};
            const fields = (approval.questions ?? []).map(q => { const answer = h("input", { placeholder: q.options?.map(o => o.label).join(" / ") ?? t("Your answer…") }); answer.addEventListener("input", () => answers[q.id] = [answer.value]); return h("label", { class: "field" }, q.question, answer); });
            const title = approval.method === "input" ? "The assistant has a question" : ({ command: "Approve command", file: "Approve file change", mcp: "Approve tool use" } as const)[approval.method];
            this.approvals.append(h("article", { class: "native-approval", "aria-label": t(title) }, h("strong", {}, t(title)), h("pre", {}, approval.description), ...fields, h("div", { class: "button-row" }, h("button", { class: "btn btn-primary btn-small", disabled: this.busy, onclick: () => void this.action({ action: "approval", approval: approval.id, instance: approval.instance, accept: true, ...(fields.length ? { answers } : {}) }) }, t(approval.method === "input" ? "Answer and continue" : "Allow once")), h("button", { class: "btn btn-small", disabled: this.busy, onclick: () => void this.action({ action: "approval", approval: approval.id, instance: approval.instance, accept: false }) }, t("Reject")))));
        }
        if (s.quarantined) {
            const note = h("textarea", { placeholder: t("Describe what you checked and the outcome."), rows: 2 });
            const resolution = h("select", {}, h("option", { value: "verified-complete" }, t("Verified completed")), h("option", { value: "verified-not-executed" }, t("Verified not executed")), h("option", { value: "retry-at-own-risk" }, t("Outcome still unknown; accept duplicate risk")));
            const checked = h("input", { type: "checkbox" });
            const review = h("button", { class: "btn btn-small", disabled: true, onclick: () => { if (note.value.trim().length < 8) {
                    toast(t("Describe what you checked and the outcome."));
                    return;
                } void this.action({ action: "resolve", resolution: resolution.value as "verified-complete", note: note.value.trim(), processes_stopped: true }); } }, t("Record review"));
            checked.addEventListener("change", () => review.disabled = !checked.checked);
            this.approvals.append(h("p", {}, t("Nothing is retried automatically. Check tool results and stopped processes first. A new thread does not undo side effects.")), h("label", { class: "check-field" }, checked, t("I checked that this session’s processes are stopped.")), resolution, note, review);
        }
    }
    private async action(input: NativeAction, silent = false) {
        if (!this.id || this.busy) return;
        const generation = this.generation;
        const controls = input.action === "approval" ? [...this.approvals.querySelectorAll("button")] : [];
        for (const button of controls) button.disabled = true;
        this.busy = true;
        try {
            await this.client.nativeAction(this.id, input);
            if (generation === this.generation && !silent && input.action !== "approval") toast(t("Request sent"));
        } catch (error) {
            if (generation === this.generation) {
                this.approvals.querySelector(".state-error")?.remove();
                this.approvals.append(failure(errorText(error)));
                for (const button of controls) button.disabled = false;
            }
        } finally {
            if (generation === this.generation) this.busy = false;
        }
    }

    private event(record: NativeEventRecord) {
        const event = record.event;
        if (event.type === "reasoning") {
            const key = record.turn ?? "summary";
            let body = this.summary.get(key);
            if (!body) {
                body = h("pre", {});
                this.summary.set(key, body);
                this.history.append(h("details", {}, h("summary", {}, t("Thinking summary")), body));
            }
            body.textContent += event.delta;
        } else if (event.type === "tool") {
            const key = `${record.turn ?? ""}:${event.id}`;
            let tool = this.tools.get(key);
            if (!tool) {
                const label = h("summary", {});
                const body = h("pre", {});
                const entry = h("details", {}, label, body);
                tool = { entry, label, body };
                this.tools.set(key, tool);
            }
            tool.label.textContent = `${event.name.replaceAll("__", " › ")} · ${t({
                running: "Running", completed: "Done", failed: "Failed", unknown: "Unknown result",
            }[event.status])}`;
            tool.body.textContent = event.description;
            if (!tool.entry.parentElement) this.history.append(tool.entry);
        } else return;
        this.activity.hidden = false;
    }
}

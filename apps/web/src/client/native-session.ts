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
    private approvals = h("div", {});
    private history = h("div", { class: "native-history" });
    private model = h("select", { "aria-label": t("Model") });
    private effort = h("select", { "aria-label": t("Thinking effort") });
    private id?: string;
    private active = true;
    private timer?: ReturnType<typeof setTimeout>;
    private generation = 0;
    private after = 0;
    private summary = new Map<string, HTMLElement>();
    private seen = new Set<string>();
    private desiredModel = "";
    private desiredEffort = "";
    private busy = false;
    private configured = false;
    private formKey = "";
    session?: NativeSession;
    get bound(){return !!this.id;}
    constructor(private client: Client, private ready: (ready: boolean) => void) { this.element.append(this.status, this.controls, this.approvals, this.history); this.model.addEventListener("change", () => { this.desiredModel = this.model.value; this.efforts(); }); this.effort.addEventListener("change", () => { this.desiredEffort = this.effort.value; this.efforts(); }); }
    dispose() { this.active = false; clearTimeout(this.timer); this.generation++; }
    bind(id?: string) { if (id === this.id)
        return; this.generation++; clearTimeout(this.timer); this.id = id; this.session = undefined; this.after = 0; this.summary.clear(); this.seen.clear(); this.desiredModel = ""; this.desiredEffort = ""; this.configured = false; this.formKey = ""; clear(this.history); this.element.hidden = !id; if (id) {
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
    private efforts() { const m = this.session?.view.models.find(m => m.id === this.model.value); const valid = !this.desiredEffort || !!m?.efforts.includes(this.desiredEffort); clear(this.effort, h("option", { value: "" }, t("Default effort")), ...(!valid ? [h("option", { value: this.desiredEffort, selected: true, disabled: true }, t("Choose a supported effort"))] : []), ...(m?.efforts ?? []).map(value => h("option", { value, selected: value === this.desiredEffort }, value))); this.ready(valid && this.session?.view.state === "ready" && !this.session.quarantined); }
    private render(s: NativeSession) {
        this.ready(s.view.state === "ready" && !s.quarantined);
        clear(this.status, h("strong", {}, t(LABEL[s.view.state] ?? "Session unavailable")), h("span", { class: "muted" }, ` · ${s.view.model ?? s.profile.model} · ${s.view.effort ?? t("Default effort")}`));
        const selected = this.desiredModel || s.view.model || s.view.default_model || s.profile.model;
        clear(this.model, ...s.view.models.map(m => h("option", { value: m.id, selected: m.id === selected }, m.id)));
        this.efforts();
        this.model.disabled = this.effort.disabled = s.view.state !== "ready";
        clear(this.controls, this.model, this.effort, ...([["resume", "Restore session"], ["compact", "Compact context"], ["interrupt", "Stop execution"], ["close", "Close session"]] as const).map(([action, label]) => h("button", { type: "button", class: "btn btn-small", disabled: this.busy || s.quarantined || (action === "compact" && s.view.state !== "ready") || (action === "resume" && !["offline", "failed"].includes(s.view.state)), onclick: () => void this.action({ action }) }, t(label))));
        const formKey = JSON.stringify([s.view.state, s.view.approval, s.view.login_url, s.view.login_code, s.view.error, s.quarantined, s.view.stopped]);
        if (formKey === this.formKey)
            return;
        this.formKey = formKey;
        clear(this.approvals);
        if (s.view.state === "login_required")
            this.approvals.append(h("p", {}, t("This conversation uses an isolated official client. Sign in with your own ChatGPT account.")), h("button", { class: "btn btn-primary btn-small", disabled: this.busy, onclick: () => void this.action({ action: "login" }) }, t("Sign in with Codex")));
        if (s.view.login_url) {
            this.approvals.append(h("a", { href: s.view.login_url, target: "_blank", rel: "noopener noreferrer", class: "btn btn-small" }, t("Open official sign-in")), h("code", { class: "native-code" }, s.view.login_code ?? ""));
        }
        if (s.view.error)
            this.approvals.append(h("p", { class: "notice" }, t("The session could not continue safely. Review the saved history before starting another operation.")));
        const approval = s.view.approval;
        if (approval) {
            const answers: Record<string, string[]> = {};
            const fields = (approval.questions ?? []).map(q => { const answer = h("input", { placeholder: q.options?.map(o => o.label).join(" / ") ?? t("Your answer…") }); answer.addEventListener("input", () => answers[q.id] = [answer.value]); return h("label", { class: "field" }, q.question, answer); });
            this.approvals.append(h("article", { class: "native-approval" }, h("strong", {}, t(approval.method === "input" ? "The assistant has a question" : "Approval required")), h("pre", {}, approval.description), ...fields, h("div", { class: "button-row" }, h("button", { class: "btn btn-primary btn-small", disabled: this.busy, onclick: () => void this.action({ action: "approval", approval: approval.id, instance: approval.instance, accept: true, ...(fields.length ? { answers } : {}) }) }, t(approval.method === "input" ? "Answer and continue" : "Allow once")), h("button", { class: "btn btn-small", disabled: this.busy, onclick: () => void this.action({ action: "approval", approval: approval.id, instance: approval.instance, accept: false }) }, t("Reject")))));
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
    private async action(input: NativeAction) { if (!this.id || this.busy)
        return; this.busy = true; try {
        await this.client.nativeAction(this.id, input);
        toast(t("Request sent"));
    }
    catch (e) {
        this.approvals.append(failure(errorText(e)));
    }
    finally {
        this.busy = false;
    } }
    private event(record: NativeEventRecord) {
        const e = record.event;
        if (e.type === "reasoning") {
            const key = record.turn ?? "summary";
            let body = this.summary.get(key);
            if (!body) {
                body = h("pre", {});
                this.summary.set(key, body);
                this.history.append(h("details", {}, h("summary", {}, t("Thinking summary")), body));
            }
            body.textContent = (body.textContent ?? "") + e.delta;
        }
        if (e.type === "tool") {
            const key = `${e.id}:${e.status}`;
            if (this.seen.has(key))
                return;
            this.seen.add(key);
            this.history.append(h("details", {}, h("summary", {}, `${e.name} · ${e.status}`), h("pre", {}, e.description)));
        }
        while (this.history.children.length > 40)
            this.history.firstElementChild?.remove();
    }
}

import type { AIConfiguration, AIConnection, AIProfile, AIRuntime, NativeSession } from "@lumio/schema";
import type { Client } from "./api.ts";
import { errorText } from "./api.ts";
import { h, clear, failure, openDialog, toast } from "./dom.ts";
import { t } from "./i18n.ts";
export class AISettings {
    readonly element = h("div", { class: "set-form-wrap" });
    private active = true;
    private config: AIConfiguration = { connections: [], profiles: [] };
    private runtimes: AIRuntime[] = [];
    private sessions: NativeSession[] = [];
    constructor(private client: Client) { void this.load(); }
    dispose() { this.active = false; }
    async load() { try {
        const [config, runtimes, sessions] = await Promise.all([this.client.aiConfiguration(), this.client.aiRuntimes(), this.client.nativeSessions()]);
        if (!this.active)
            return;
        this.config = config;
        this.runtimes = runtimes;
        this.sessions = sessions;
        this.render();
    }
    catch (e) {
        if (this.active)
            clear(this.element, failure(errorText(e)));
    } }
    private render() {
        clear(this.element, h("h3", {}, t("AI profiles")), h("p", { class: "muted" }, t("Choose an API or an official Codex session. Profiles share model settings; each conversation keeps its own permissions and history.")), ...this.config.profiles.map(p => h("div", { class: "set-row" }, h("span", { class: "set-label" }, p.name, h("span", { class: "set-sub" }, `${p.engine} · ${p.model} · ${p.effort ?? t("Default effort")}`)), h("button", { class: "btn btn-small", onclick: () => this.profile(p) }, t("Edit")))), h("div", { class: "button-row" }, h("button", { class: "btn btn-small", onclick: () => this.connection() }, t("Add connection")), h("button", { class: "btn btn-small", disabled: !this.config.connections.length, onclick: () => this.profile() }, t("New profile"))), h("h4", {}, t("Connections")), ...this.config.connections.map(c => h("div", { class: "set-row" }, h("span", { class: "set-label" }, c.name, h("span", { class: "set-sub" }, `${c.kind} · ${c.host} · ${c.api_key_set ? t("Key saved") : t("Official login or no key")}`)), h("button", { class: "btn btn-small", onclick: () => this.connection(c) }, t("Edit")))));
    }
    private connection(old?: AIConnection) {
        const name = h("input", { required: true, value: old?.name ?? "", placeholder: t("Connection name") }), kind = h("select", {}, ...[["codex-account", "Codex account"], ["deepseek", "DeepSeek API"], ["doubao", "Doubao API"], ["openai-compatible", "Compatible API"]].map(([value, label]) => h("option", { value, selected: old?.kind === value }, t(label!))));
        const host = h("select", {}, ...this.runtimes.map(r => h("option", { value: r.name, selected: old?.host === r.name }, `${r.name}${r.online ? "" : " · " + t("Offline")}`))), base = h("input", { type: "url", value: old?.base_url ?? "", placeholder: "https://…/v1", autocomplete: "off" }), key = h("input", { type: "password", autocomplete: "new-password", placeholder: old?.api_key_set ? t("Saved. Leave blank to keep it.") : t("API key") });
        const api = h("div", { class: "form-stack" }, h("label", { class: "field" }, t("API address"), base), h("label", { class: "field" }, t("API key"), key));
        const native = h("div", { class: "form-stack" }, h("label", { class: "field" }, t("Runtime"), host), h("p", { class: "muted" }, t("Sign in through the official Codex client for each isolated conversation. Your personal Codex configuration stays separate.")));
        const change = () => { api.hidden = kind.value === "codex-account"; native.hidden = !api.hidden; if (!base.value && kind.value === "deepseek")
            base.value = "https://api.deepseek.com/v1"; if (!base.value && kind.value === "doubao")
            base.value = "https://ark.cn-beijing.volces.com/api/v3"; };
        kind.disabled = !!old;
        host.disabled = !!old;
        kind.addEventListener("change", change);
        change();
        const message = h("div", { role: "status" });
        const save = h("button", { type: "submit", class: "btn btn-primary" }, t("Save"));
        const form = h("form", { class: "form-stack" }, h("label", { class: "field" }, t("Name"), name), h("label", { class: "field" }, t("Service"), kind), native, api, message, save);
        const dialog = openDialog(t("Connection"), form, []);
        form.addEventListener("submit", e => { e.preventDefault(); save.disabled = true; void this.client.saveAIConnection({ name: name.value.trim(), kind: kind.value as AIConnection["kind"], host: kind.value === "codex-account" ? host.value : "hub", ...(kind.value !== "codex-account" ? { base_url: base.value.trim(), ...(key.value ? { api_key: key.value } : {}) } : {}) }, old?.id).then(() => { key.value = ""; dialog.close(); toast(t("Saved.")); void this.load(); }).catch(e => { clear(message, failure(errorText(e))); save.disabled = false; }); });
    }
    private profile(old?: AIProfile) {
        const name = h("input", { required: true, value: old?.name ?? "", placeholder: t("Profile name") }), connection = h("select", {}, ...this.config.connections.map(c => h("option", { value: c.id, selected: old?.connection === c.id }, c.name))), model = h("input", { required: true, value: old?.model ?? (this.config.connections[0]?.kind === "codex-account" ? "default" : ""), placeholder: t("Model") }), thinking = h("select", {}, ...["default", "off", "on"].map(value => h("option", { value, selected: old?.thinking === value }, t(value === "default" ? "Provider default" : value === "on" ? "Thinking on" : "Thinking off")))), effort = h("select", {});
        const choices = () => { const c = this.config.connections.find(c => c.id === connection.value); const known = this.sessions.flatMap(s => s.connection.id === c?.id ? s.view.models : []).find(m => m.id === model.value); const values = c?.kind === "deepseek" ? ["low", "high", "max"] : known?.efforts ?? []; clear(effort, h("option", { value: "" }, t("Default effort")), ...values.map(v => h("option", { value: v, selected: old?.effort === v }, v))); thinking.disabled = c?.kind !== "deepseek"; if (thinking.disabled)
            thinking.value = "default"; };
        connection.addEventListener("change", choices);
        model.addEventListener("input", choices);
        choices();
        const message = h("div", { role: "status" }), save = h("button", { type: "submit", class: "btn btn-primary" }, t("Save"));
        const form = h("form", { class: "form-stack" }, h("label", { class: "field" }, t("Name"), name), h("label", { class: "field" }, t("Connection"), connection), h("label", { class: "field" }, t("Model"), model), h("p", { class: "muted" }, t("For Codex, default uses the client model. Available models and effort levels appear after official sign-in.")), h("label", { class: "field" }, t("Thinking mode"), thinking), h("label", { class: "field" }, t("Thinking effort"), effort), message, save);
        const dialog = openDialog(t("AI profile"), form, []);
        form.addEventListener("submit", e => { e.preventDefault(); const c = this.config.connections.find(c => c.id === connection.value)!; save.disabled = true; void this.client.saveAIProfile({ name: name.value.trim(), connection: c.id, engine: c.kind === "codex-account" ? "codex" : "lumio", model: model.value.trim(), thinking: thinking.value as AIProfile["thinking"], ...(effort.value ? { effort: effort.value } : {}) }, old?.id).then(() => { dialog.close(); toast(t("Saved.")); void this.load(); }).catch(e => { clear(message, failure(errorText(e))); save.disabled = false; }); });
    }
}

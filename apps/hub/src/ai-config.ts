import { randomBytes } from "node:crypto";
import { AIConnection, AIConnectionInput, AIProfile, AIProfileInput, AIConfiguration, type AIModel } from "@lumio/schema";
import { newId } from "@lumio/foundation";
import { SqliteAIStore } from "@lumio/storage";
import { ChatCompletionsModel, type ModelConfiguration } from "./assistant-model.ts";
import { HubError } from "./errors.ts";
const fail = () => new HubError("INVALID", { key: "ai.invalid", args: [] });
export class AIConfigurationService {
    constructor(readonly store: SqliteAIStore, private legacy?: ModelConfiguration) { }
    list(owner: string): AIConfiguration {
        if (!this.store.connections(owner).length && this.legacy) {
            const c = this.connection(owner, { name: "Existing API", kind: new URL(this.legacy.baseUrl).hostname === "api.deepseek.com" ? "deepseek" : "openai-compatible", host: "hub", base_url: this.legacy.baseUrl, api_key: this.legacy.credential() });
            this.profile(owner, { name: "Existing assistant", connection: c.id, engine: "lumio", model: this.legacy.model, thinking: "default" });
        }
        return AIConfiguration.parse({ connections: this.store.connections(owner), profiles: this.store.profiles(owner) });
    }
    connection(owner: string, raw: unknown, id?: string): AIConnection {
        const p = AIConnectionInput.safeParse(raw);
        if (!p.success)
            throw fail();
        const v = p.data, old = id ? this.store.connection(id) : undefined;
        if (id && old?.owner !== owner)
            throw fail();
        if (old && (old.kind !== v.kind || old.host !== v.host))
            throw fail();
        const secret = v.clear_api_key ? undefined : v.api_key ?? (id ? this.store.secret(id) : undefined);
        if ([v.name, v.base_url ?? "", secret ?? ""].some(x => /[\r\n\0]/.test(x)) || (secret && [v.name, v.base_url ?? ""].some(x => x.includes(secret))))
            throw fail();
        // Changing an existing credential/endpoint never mutates a native session's frozen copy.
        const now = new Date().toISOString();
        const result = AIConnection.parse({ id: old?.id ?? newId("aic", new Date(), randomBytes), owner, name: v.name, kind: v.kind, host: v.host, base_url: v.base_url?.replace(/\/+$/, ""), api_key_set: !!secret, revision: (old?.revision ?? 0) + 1, created: old?.created ?? now, updated: now });
        this.store.putConnection(result, secret);
        return result;
    }
    profile(owner: string, raw: unknown, id?: string): AIProfile {
        const p = AIProfileInput.safeParse(raw);
        if (!p.success)
            throw fail();
        const v = p.data, c = this.store.connection(v.connection), old = id ? this.store.profile(id) : undefined;
        if (!c || c.owner !== owner || (id && old?.owner !== owner) || (v.engine === "codex") !== (c.kind === "codex-account"))
            throw fail();
        if (c.kind === "codex-account" && v.thinking !== "default")
            throw fail();
        if (v.effort && !/^[a-z]+$/.test(v.effort))
            throw fail();
        if (c.kind !== "codex-account" && c.kind !== "deepseek" && (v.thinking !== "default" || v.effort))
            throw fail();
        if (c.kind === "deepseek" && v.effort && !["low", "high", "max"].includes(v.effort))
            throw fail();
        const secret = this.store.secret(c.id);
        if (secret && [v.name, v.model].some(x => x.includes(secret)))
            throw fail();
        const now = new Date().toISOString();
        const result = AIProfile.parse({ ...v, id: old?.id ?? newId("aip", new Date(), randomBytes), owner, revision: (old?.revision ?? 0) + 1, created: old?.created ?? now, updated: now });
        this.store.putProfile(result);
        return result;
    }
    get(owner: string, id: string) { const profile = this.store.profile(id), connection = profile ? this.store.connection(profile.connection) : undefined; if (!profile || profile.owner !== owner || !connection || connection.owner !== owner)
        throw fail(); return { profile, connection }; }
    model(owner: string, id: string) { const { profile, connection } = this.get(owner, id); if (profile.engine !== "lumio" || !connection.base_url)
        throw fail(); const key=this.store.secret(connection.id); return { model: new ChatCompletionsModel({ baseUrl: connection.base_url, model: profile.model, credential: () => key }), settings: { model: profile.model, thinking: profile.thinking, reasoning_effort: profile.effort } }; }
    models(id: string, owner: string): AIModel[] { const { connection, profile } = this.get(owner, id); return [{ id: profile.model, efforts: connection.kind === "deepseek" ? ["low", "high", "max"] : [] }]; }
}

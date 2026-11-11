import { randomBytes } from "node:crypto";
import {
  AIConnection,
  AIConnectionInput,
  AIProfile,
  AIProfileInput,
  AIConfiguration,
  AIConfigurationDelete,
  AIConfigurationDeleted,
  type AIModel,
} from "@lumio/schema";
import { newId } from "@lumio/foundation";
import { SqliteAIStore } from "@lumio/storage";
import { ChatCompletionsModel, type ModelConfiguration } from "./assistant-model.ts";
import { HubError } from "./errors.ts";

const failure = (problem: string, code: "INVALID" | "NOT_FOUND" = "INVALID") =>
  new HubError(code, { key: `ai.${problem}`, args: [] }, { reason: `ai-${problem.replaceAll("_", "-")}` });
const MIGRATION = "ai.legacy-migration";

export class AIConfigurationService {
  knowledgeProfileInUse?: (profile: string, nextEngine?: AIProfile["engine"]) => boolean;
  constructor(
    readonly store: SqliteAIStore,
    private readonly legacy?: ModelConfiguration,
  ) {}

  /** Called before serving requests. Each owner's pair and receipt commit together. */
  migrateLegacy(owners: string[]): void {
    const legacy = this.legacy;
    if (!legacy) return;
    for (const owner of owners) {
      this.store.db
        .transaction(() => {
          if (this.store.receipt(MIGRATION, owner, "v1")) return;
          // Existing configurations (including earlier lazy imports) take precedence.
          if (!this.store.connections(owner).length && !this.store.profiles(owner).length) {
            const connection = this.connection(owner, {
              name: "Existing API",
              kind: new URL(legacy.baseUrl).hostname === "api.deepseek.com" ? "deepseek" : "openai-compatible",
              host: "hub",
              base_url: legacy.baseUrl,
              api_key: legacy.credential(),
            });
            this.profile(owner, {
              name: "Existing assistant",
              connection: connection.id,
              engine: "lumio",
              model: legacy.model,
              thinking: "default",
            });
          }
          // No credentials in receipts. Removing all configurations must not reimport them.
          this.store.putReceipt(MIGRATION, owner, "v1", { migrated: true });
        })
        .immediate();
    }
  }

  list(owner: string): AIConfiguration {
    return AIConfiguration.parse({ connections: this.store.connections(owner), profiles: this.store.profiles(owner) });
  }

  connection(owner: string, raw: unknown, id?: string): AIConnection {
    const parsed = AIConnectionInput.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue?.message === "Use the official TypeSafe API address") throw failure("jev_address");
      const field = issue?.path[0];
      const problem =
        field === "name"
          ? "name"
          : field === "api_key" || field === "clear_api_key"
            ? "credential"
            : field === "base_url" || issue?.message === "Invalid API address"
              ? "address"
              : issue?.message === "Conflicting credential changes"
                ? "credential"
                : "connection_input";
      throw failure(problem);
    }
    const input = parsed.data;
    const old = id ? this.store.connection(id) : undefined;
    if (id && old?.owner !== owner) throw failure("connection_missing", "NOT_FOUND");
    if (old && (old.kind !== input.kind || old.host !== input.host)) throw failure("connection_immutable");
    const secret = input.clear_api_key ? undefined : (input.api_key ?? (id ? this.store.secret(id) : undefined));
    if (input.kind === "typesafe-jev" && !secret?.trim()) throw failure("jev_key_required");
    if (
      [input.name, input.base_url ?? "", secret ?? ""].some((value) => /[\r\n\0]/.test(value)) ||
      (secret && [input.name, input.base_url ?? ""].some((value) => value.includes(secret)))
    ) {
      throw failure("credential");
    }
    // Changing a credential/endpoint never mutates an active turn's frozen copy.
    const now = new Date().toISOString();
    const result = AIConnection.parse({
      id: old?.id ?? newId("aic", new Date(), randomBytes),
      owner,
      name: input.name,
      kind: input.kind,
      host: input.host,
      base_url: input.base_url?.replace(/\/+$/, ""),
      api_key_set: !!secret,
      revision: (old?.revision ?? 0) + 1,
      created: old?.created ?? now,
      updated: now,
    });
    this.store.putConnection(result, secret);
    return result;
  }

  profile(owner: string, raw: unknown, id?: string): AIProfile {
    const parsed = AIProfileInput.safeParse(raw);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      throw failure(field === "name" ? "name" : field === "model" ? "model" : "profile_input");
    }
    const input = parsed.data;
    const connection = this.store.connection(input.connection);
    const old = id ? this.store.profile(id) : undefined;
    if (id && old?.owner !== owner) throw failure("profile_missing", "NOT_FOUND");
    if (old && this.knowledgeProfileInUse?.(old.id, input.engine)) throw new HubError("CONFLICT", { key: "ai.profile_in_use", args: [] });
    if (!connection || connection.owner !== owner) throw failure("connection_missing", "NOT_FOUND");
    if (connection.kind === "typesafe-jev") throw failure("jev_chat_unsupported");
    if (connection.kind === "claude-code-subscription") throw failure("engine_mismatch");
    if ((input.engine === "codex") !== (connection.kind === "codex-account")) throw failure("engine_mismatch");
    if ((input.engine === "speech") !== (connection.kind === "dashscope")) throw failure("engine_mismatch"); // ADR 0055：语音 Profile 只用于语音用途
    if (connection.kind === "codex-account" && input.thinking !== "default") throw failure("thinking_unsupported");
    if (input.effort && !/^[a-z]+$/.test(input.effort)) throw failure("effort_unsupported");
    if (connection.kind !== "codex-account" && connection.kind !== "deepseek") {
      if (input.thinking !== "default") throw failure("thinking_unsupported");
      if (input.effort) throw failure("effort_unsupported");
    }
    if (connection.kind === "deepseek" && input.effort && !["low", "high", "max"].includes(input.effort)) {
      throw failure("effort_unsupported");
    }
    const secret = this.store.secret(connection.id);
    if (secret && [input.name, input.model].some((value) => value.includes(secret))) throw failure("credential");
    const now = new Date().toISOString();
    const result = AIProfile.parse({
      ...input,
      id: old?.id ?? newId("aip", new Date(), randomBytes),
      owner,
      revision: (old?.revision ?? 0) + 1,
      created: old?.created ?? now,
      updated: now,
    });
    this.store.putProfile(result);
    return result;
  }

  async remove(owner: string, kind: "connection" | "profile", id: string, raw: unknown,
    cleanConnection: (connection: AIConnection) => Promise<void>): Promise<AIConfigurationDeleted> {
    const input = AIConfigurationDelete.parse(raw);
    const scope = `ai-delete:${owner}:${id}`;
    const fingerprint = JSON.stringify(input);
    const replay = () => {
      const receipt = this.store.receipt(scope, input.request_id, fingerprint);
      if (!receipt) return undefined;
      if (!receipt.matches) throw new HubError("CONFLICT", { key: "ai.conflict", args: [] });
      return AIConfigurationDeleted.parse(receipt.result);
    };
    const owned = () => {
      const value = kind === "connection" ? this.store.connection(id) : this.store.profile(id);
      if (!value || value.owner !== owner) throw failure(kind + "_missing", "NOT_FOUND");
      if (value.revision !== input.expected_revision) throw new HubError("CONFLICT", { key: "ai.conflict", args: [] });
      const inUse = kind === "connection"
        ? this.store.profiles(owner).some(profile => profile.connection === id)
        : this.knowledgeProfileInUse?.(id) || this.store.sessions(owner).some(session => session.profile.id === id && session.view.state !== "closed");
      if (inUse) throw new HubError("CONFLICT", { key: kind === "connection" ? "ai.connection_in_use" : "ai.profile_in_use", args: [] });
      return value;
    };
    const prior = replay();
    if (prior) return prior;
    const value = owned();
    if ("kind" in value) await cleanConnection(value);
    return this.store.db.transaction(() => {
      const prior = replay();
      if (prior) return prior;
      owned();
      if (kind === "connection") this.store.deleteConnection(id);
      else this.store.deleteProfile(id);
      const result = AIConfigurationDeleted.parse({ id, deleted: true });
      this.store.putReceipt(scope, input.request_id, fingerprint, result);
      return result;
    }).immediate();
  }

  get(owner: string, id: string) {
    const profile = this.store.profile(id);
    if (!profile || profile.owner !== owner) throw failure("profile_missing", "NOT_FOUND");
    const connection = this.store.connection(profile.connection);
    if (!connection || connection.owner !== owner) throw failure("connection_missing", "NOT_FOUND");
    if (connection.kind === "typesafe-jev") throw failure("jev_chat_unsupported");
    if (profile.engine === "speech") throw failure("engine_mismatch"); // ADR 0055：语音 Profile 不能用于聊天
    return { profile, connection };
  }

  model(owner: string, id: string) {
    const { profile, connection } = this.get(owner, id);
    if (profile.engine !== "lumio" || !connection.base_url) throw failure("api_profile_required");
    const key = this.store.secret(connection.id);
    return {
      model: new ChatCompletionsModel({ baseUrl: connection.base_url, model: profile.model, credential: () => key }),
      settings: { model: profile.model, thinking: profile.thinking, reasoning_effort: profile.effort },
    };
  }

  models(id: string, owner: string): AIModel[] {
    const { connection, profile } = this.get(owner, id);
    return [{ id: profile.model, efforts: connection.kind === "deepseek" ? ["low", "high", "max"] : [] }];
  }
}

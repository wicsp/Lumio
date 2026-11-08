import { randomBytes } from "node:crypto";
import {
  AIConnection,
  AIConnectionInput,
  AIProfile,
  AIProfileInput,
  AIConfiguration,
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
    if (!connection || connection.owner !== owner) throw failure("connection_missing", "NOT_FOUND");
    if ((input.engine === "codex") !== (connection.kind === "codex-account")) throw failure("engine_mismatch");
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

  get(owner: string, id: string) {
    const profile = this.store.profile(id);
    if (!profile || profile.owner !== owner) throw failure("profile_missing", "NOT_FOUND");
    const connection = this.store.connection(profile.connection);
    if (!connection || connection.owner !== owner) throw failure("connection_missing", "NOT_FOUND");
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

import { createHash } from "node:crypto";
import {
  DASHSCOPE_BASE_URLS, SpeechBinding, SpeechBindingUpdate, SpeechTerm,
  SpeechVocabulary, SpeechVocabularyUpdate, type AIConnection, type ApiErrorCode,
} from "@lumio/schema";
import { SqliteAIStore, SqliteSpeechStore, type StoredVocabulary, type StoredVocabularySync } from "@lumio/storage";
import { WriteCoordinator } from "./coordinator.ts";
import { HubError } from "./errors.ts";
import { FUN_ASR_MODEL, type FunAsr } from "./fun-asr.ts";
import { errorMessage } from "./messages.ts";
import type { Identity } from "./store.ts";

export const SPEECH_PATH = "/v2/speech/transcribe";
export const VOCABULARY_PATH = "/v2/speech/vocabulary";
export const BINDINGS_PATH = "/v2/speech/bindings";

export function speechError(code: ApiErrorCode, key: string) {
  return new HubError(code, { key: "speech." + key, args: [] }, { reason: "speech-" + key.replaceAll("_", "-") });
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const isBeijing = (connection: AIConnection) => connection.kind === "dashscope" && connection.base_url === DASHSCOPE_BASE_URLS.beijing;

export class SpeechConfiguration {
  private readonly writes = new WriteCoordinator();
  private readonly scheduled = new Set<string>();

  constructor(
    private readonly store: SqliteSpeechStore,
    private readonly ai: SqliteAIStore,
    private readonly provider: FunAsr,
    private readonly projectNames: () => string[],
    private readonly now: () => Date,
  ) {}

  drain() { return this.writes.drain(); }

  configurationWrite<T>(action: () => Promise<T>): Promise<T> { return this.writes.exclusive(action); }

  /** Called inside configurationWrite, while the connection and its credential still exist. */
  async cleanConnection(connection: AIConnection) {
    const stored = this.store.sync(connection.id);
    if (!stored || (!stored.vocabularyId && stored.view.state === "synced")) return;
    const key = this.ai.secret(connection.id);
    if (!key) throw speechError("CONFLICT", "cleanup_requires_key");
    if (stored.vocabularyCredentialHash && stored.vocabularyCredentialHash !== hash(key)) {
      // A replacement key may belong to a different account. Confirm it can see the original list.
      const found = await this.provider.findVocabulary(key, connection.id);
      if (!found || (stored.vocabularyId && found !== stored.vocabularyId)) throw speechError("CONFLICT", "cleanup_requires_key");
    }
    const id = stored.vocabularyId ?? await this.provider.findVocabulary(key, connection.id);
    if (id) {
      this.store.putSync({ ...stored, submittedHash: undefined, vocabularyId: id, vocabularyCredentialHash: hash(key),
        view: { connection: connection.id, state: "pending", updated: this.now().toISOString() } });
      await this.deleteVocabulary(key, connection.id, id);
    }
  }

  private resolveProfile(owner: string, id: string, purpose: SpeechBinding["purpose"]) {
    const profile = this.ai.profile(id);
    if (!profile || profile.owner !== owner) throw speechError("NOT_FOUND", "profile_missing");
    const connection = this.ai.connection(profile.connection);
    if (!connection || connection.owner !== owner) throw speechError("NOT_FOUND", "profile_missing");
    if (profile.engine !== "speech" || connection.kind !== "dashscope") throw speechError("INVALID", "profile_mismatch");
    if (purpose === "speech.asr" && (!isBeijing(connection) || profile.model !== FUN_ASR_MODEL)) {
      throw speechError("INVALID", "asr_unsupported");
    }
    if (purpose === "speech.tts" && profile.model === FUN_ASR_MODEL) throw speechError("INVALID", "profile_mismatch");
    return { profile, connection };
  }

  asr(owner: string, explicitProfile?: string) {
    const id = explicitProfile ?? this.store.binding(owner, "speech.asr")?.profile;
    if (!id) throw speechError("NOT_FOUND", "binding_missing");
    const resolved = this.resolveProfile(owner, id, "speech.asr");
    const secret = this.ai.secret(resolved.connection.id);
    if (!secret?.trim()) throw speechError("INVALID", "credential_missing");
    return { ...resolved, secret };
  }

  private vocabulary(owner: string): StoredVocabulary {
    return this.store.vocabulary(owner) ?? {
      owner, terms: [], include_project_names: false, revision: 1, updated: new Date(0).toISOString(),
    };
  }

  private effectiveTerms(value: StoredVocabulary) {
    const terms = new Map(value.terms.map(term => [term.toLowerCase(), term]));
    if (value.include_project_names) {
      for (const name of this.projectNames()) {
        if (terms.size >= 200) break;
        const parsed = SpeechTerm.safeParse(name);
        if (parsed.success && !terms.has(parsed.data.toLowerCase())) terms.set(parsed.data.toLowerCase(), parsed.data);
      }
    }
    return [...terms.values()];
  }

  private connections(owner: string) {
    const asrConnections = new Set(this.ai.profiles(owner)
      .filter(profile => profile.engine === "speech" && profile.model === FUN_ASR_MODEL).map(profile => profile.connection));
    return this.ai.connections(owner).filter(connection =>
      isBeijing(connection) && (asrConnections.has(connection.id) || this.store.sync(connection.id)));
  }

  private view(value: StoredVocabulary) {
    const desired = hash(JSON.stringify(this.effectiveTerms(value)));
    return SpeechVocabulary.parse({ ...value, sync: this.connections(value.owner).map(connection => {
      const stored = this.store.sync(connection.id);
      const key = this.ai.secret(connection.id);
      if (stored && stored.attemptedHash === desired && stored.credentialHash === (key ? hash(key) : undefined)) {
        return stored.view.state === "error"
          ? { ...stored.view, error: errorMessage(speechError("INTERNAL", "vocabulary_failed")) }
          : stored.view;
      }
      return { connection: connection.id, state: "pending", updated: value.updated };
    }) });
  }

  private updateVocabulary(owner: string, input: SpeechVocabularyUpdate) {
    return this.writes.exclusive(async () => {
      const scope = "speech-vocabulary:" + owner;
      const fingerprint = hash(JSON.stringify(input));
      const current = this.vocabulary(owner);
      const receipt = this.ai.receipt(scope, input.request_id, fingerprint);
      let value: StoredVocabulary;
      if (receipt) {
        if (!receipt.matches) throw speechError("CONFLICT", "revision_conflict");
        const { revision, updated } = receipt.result as Pick<StoredVocabulary, "revision" | "updated">;
        value = { owner, terms: input.terms, include_project_names: input.include_project_names, revision, updated };
        if (current.revision !== revision) return SpeechVocabulary.parse({ ...value, sync: [] });
      } else {
        if (input.expected_revision !== current.revision) throw speechError("CONFLICT", "revision_conflict");
        const { terms, include_project_names } = input;
        value = { owner, terms, include_project_names, revision: current.revision + 1, updated: this.now().toISOString() };
        this.store.db.transaction(() => {
          this.store.putVocabulary(value);
          this.ai.putReceipt(scope, input.request_id, fingerprint, { revision: value.revision, updated: value.updated });
        }).immediate();
      }
      await Promise.all(this.connections(owner).map(connection => this.syncVocabulary(connection, value)));
      return this.view(value);
    });
  }

  private updateBinding(owner: string, input: SpeechBindingUpdate) {
    const scope = "speech-binding:" + owner;
    const fingerprint = hash(JSON.stringify(input));
    return this.store.db.transaction(() => {
      const receipt = this.ai.receipt(scope, input.request_id, fingerprint);
      if (receipt) {
        if (!receipt.matches) throw speechError("CONFLICT", "revision_conflict");
        return SpeechBinding.nullable().parse(receipt.result);
      }
      const current = this.store.binding(owner, input.purpose);
      if (input.expected_revision !== undefined && input.expected_revision !== current?.revision) {
        throw speechError("CONFLICT", "revision_conflict");
      }
      const revision = (current?.revision ?? 0) + 1;
      if (input.profile) this.resolveProfile(owner, input.profile, input.purpose);
      this.store.putBinding(owner, input.purpose, input.profile, revision);
      const result = input.profile ? SpeechBinding.parse({ purpose: input.purpose, profile: input.profile, revision }) : null;
      this.ai.putReceipt(scope, input.request_id, fingerprint, result);
      return result;
    }).immediate();
  }

  async handle(request: Request, identity: Identity) {
    if (identity.actor.role !== "human") throw speechError("FORBIDDEN", "human_required");
    const path = new URL(request.url).pathname;
    const owner = identity.actor.id;
    if (request.method === "GET") {
      if (path === VOCABULARY_PATH) return Response.json(this.view(this.vocabulary(owner)));
      if (path === BINDINGS_PATH) return Response.json(this.store.bindings(owner));
    }
    if (request.method === "PUT") {
      const raw: unknown = await request.json().catch(() => undefined);
      if (path === VOCABULARY_PATH) {
        const input = SpeechVocabularyUpdate.safeParse(raw);
        if (!input.success) throw speechError("INVALID", "invalid_vocabulary");
        return Response.json(await this.updateVocabulary(owner, input.data));
      }
      if (path === BINDINGS_PATH) {
        const input = SpeechBindingUpdate.safeParse(raw);
        if (!input.success) throw speechError("INVALID", "invalid_binding");
        return Response.json(this.updateBinding(owner, input.data));
      }
    }
    throw speechError("NOT_FOUND", "endpoint_missing");
  }

  vocabularyFor(connection: AIConnection, secret: string) {
    const value = this.vocabulary(connection.owner);
    const terms = this.effectiveTerms(value);
    const previous = this.store.sync(connection.id);
    if (previous?.view.state === "synced" && previous.submittedHash === hash(JSON.stringify(terms))
        && previous.credentialHash === hash(secret)) return previous.vocabularyId;
    if ((!terms.length && !previous) || this.scheduled.has(connection.id)) return undefined;
    this.scheduled.add(connection.id);
    void this.writes.exclusive(async () => {
      if (this.ai.secret(connection.id) === secret) await this.syncVocabulary(connection, this.vocabulary(connection.owner));
    }).catch(() => {}).finally(() => this.scheduled.delete(connection.id));
    return undefined;
  }

  private async deleteVocabulary(key: string, connection: string, id: string) {
    try {
      await this.provider.deleteVocabulary(key, id);
    } catch (cause) {
      // The service may have deleted the list before the response was lost.
      if (await this.provider.findVocabulary(key, connection)) throw cause;
    }
  }

  private async syncVocabulary(connection: AIConnection, value: StoredVocabulary) {
    const terms = this.effectiveTerms(value);
    const desired = hash(JSON.stringify(terms));
    const key = this.ai.secret(connection.id);
    const credentialHash = key ? hash(key) : undefined;
    const previous = this.store.sync(connection.id);
    let vocabularyId = previous?.vocabularyId;
    let submittedHash = previous?.submittedHash;
    let vocabularyCredentialHash = previous?.vocabularyCredentialHash;
    const save = (state: StoredVocabularySync["view"]["state"]) => {
      const record: StoredVocabularySync = {
        view: { connection: connection.id, state, updated: this.now().toISOString(),
          ...(state === "synced" ? { revision: value.revision } : {}) },
        vocabularyId, submittedHash, credentialHash, vocabularyCredentialHash, attemptedHash: desired,
      };
      this.store.putSync(record);
    };
    if (previous?.view.state === "synced" && desired === submittedHash && credentialHash === previous.credentialHash) {
      if (previous.view.revision !== value.revision) save("synced");
      return vocabularyId;
    }
    try {
      if (!key && (vocabularyId || vocabularyCredentialHash || terms.length)) throw speechError("INVALID", "credential_missing");
      if (key && vocabularyCredentialHash && credentialHash !== vocabularyCredentialHash) {
        const found = await this.provider.findVocabulary(key, connection.id);
        if (!found || (vocabularyId && found !== vocabularyId)) throw speechError("CONFLICT", "cleanup_requires_key");
        vocabularyId = found;
        vocabularyCredentialHash = credentialHash;
      }
      if (key && !vocabularyId && (terms.length || (previous && previous.view.state !== "synced"))) {
        vocabularyCredentialHash = credentialHash;
        save("pending");
        vocabularyId = await this.provider.findVocabulary(key, connection.id);
        submittedHash = undefined;
        if (vocabularyId) vocabularyCredentialHash = credentialHash;
      }
      if (!terms.length) {
        if (key && vocabularyId) {
          save("pending");
          await this.deleteVocabulary(key, connection.id, vocabularyId);
        }
        vocabularyId = undefined;
        vocabularyCredentialHash = undefined;
      } else if (key) {
        if (vocabularyId && desired !== submittedHash) {
          save("pending");
          try {
            await this.provider.updateVocabulary(key, vocabularyId, terms);
          } catch (cause) {
            if (await this.provider.findVocabulary(key, connection.id)) throw cause;
            vocabularyId = undefined;
          }
        }
        if (!vocabularyId) vocabularyId = await this.provider.createVocabulary(key, connection.id, terms);
        submittedHash = desired;
        vocabularyCredentialHash = credentialHash;
        save("pending");
        if (!await this.provider.vocabularyReady(key, vocabularyId)) return undefined;
      }
      submittedHash = desired;
      save("synced");
      return vocabularyId;
    } catch {
      save("error");
      return undefined;
    }
  }
}

import { type AIConnection, type AIProfile, type SearchHit, type SearchResult } from "@lumio/schema";
import { embeddingNamespace, fuseSearch, pendingEmbeddings, saveEmbeddings, semanticHits, unitVector } from "@lumio/storage";

import type { HubConfig } from "./config.ts";
import { boundedText } from "./bounded-body.ts";

type Provider = { namespace: string; endpoint: string; model: string; key?: string };

export class SemanticSearch {
  private indexing = false;
  private readonly retryAt = new Map<string, number>();
  constructor(private readonly config: HubConfig,
    private readonly resolve: (owner: string) => { connection: AIConnection; profile: AIProfile; key?: string } | undefined,
    private readonly signal: AbortSignal) {}

  private provider(owner: string): Provider | undefined {
    if (!this.config.vault) return;
    try {
      const resolved = this.resolve(owner);
      if (!resolved) return;
      const { connection, profile, key } = resolved;
      if (!connection.base_url || profile.engine !== "embedding") return;
      const base = connection.kind === "dashscope" ? `${connection.base_url}/compatible-mode/v1` : connection.base_url;
      return { endpoint: `${base.replace(/\/+$/, "")}/embeddings`, model: profile.model, key,
        namespace: embeddingNamespace("v1", profile.id, profile.revision, connection.id, connection.revision, base, profile.model) };
    } catch { return; }
  }

  private async embed(provider: Provider, input: string[], timeout: number): Promise<Float32Array[]> {
    const response = await fetch(provider.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.any([this.signal, AbortSignal.timeout(timeout)]),
      headers: { "Content-Type": "application/json", ...(provider.key ? { Authorization: `Bearer ${provider.key}` } : {}) },
      body: JSON.stringify({ model: provider.model, input, encoding_format: "float" }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Embedding HTTP ${response.status}`); }
    const reply = JSON.parse(await boundedText(response.body, 2_000_000));
    if (!Array.isArray(reply.data) || reply.data.length !== input.length) throw new Error("Invalid embedding response");
    const vectors: (Float32Array | undefined)[] = Array(input.length).fill(undefined);
    for (const row of reply.data) {
      if (!Number.isSafeInteger(row?.index) || row.index < 0 || row.index >= input.length || vectors[row.index] || !Array.isArray(row.embedding)) throw new Error("Invalid embedding response");
      const vector = unitVector(row.embedding);
      if (!vector) throw new Error("Invalid embedding vector");
      vectors[row.index] = vector;
    }
    if (!vectors.every(value => value && value.length === vectors[0]!.length)) throw new Error("Invalid embedding dimensions");
    return vectors as Float32Array[];
  }

  async refresh(owners: readonly string[]): Promise<void> {
    if (this.indexing || this.signal.aborted) return;
    this.indexing = true;
    const options = { stateDir: this.config.stateDir };
    try {
      for (const owner of owners) {
        const provider = this.provider(owner);
        if (!provider || (this.retryAt.get(provider.namespace) ?? 0) > Date.now()) continue;
        try {
          const documents = await pendingEmbeddings(this.config.vault, options, provider.namespace, 8);
          if (!documents.length) continue;
          const vectors = await this.embed(provider, documents.map(doc => doc.text), 20_000);
          if (this.provider(owner)?.namespace !== provider.namespace || this.signal.aborted) continue;
          await saveEmbeddings(this.config.vault, options, provider.namespace, documents.map((document, index) => ({ document, vector: vectors[index]! })));
          this.retryAt.delete(provider.namespace);
        } catch { this.retryAt.set(provider.namespace, Date.now() + 60_000); }
      }
    } finally { this.indexing = false; }
  }

  async hits(owner: string, query: string, type: SearchHit["note"]["type"] | undefined, limit: number): Promise<SearchHit[]> {
    const provider = query.trim() ? this.provider(owner) : undefined;
    if (!provider || this.signal.aborted || (this.retryAt.get(provider.namespace) ?? 0) > Date.now()) return [];
    try {
      const [vector] = await this.embed(provider, [query.slice(0, 6_000)], 4_000);
      if (this.provider(owner)?.namespace !== provider.namespace) return [];
      return await semanticHits(this.config.vault, { stateDir: this.config.stateDir }, provider.namespace, vector!, type, limit);
    } catch { return []; }
  }

  async search(owner: string, lexical: SearchResult, type: SearchHit["note"]["type"] | undefined, limit: number): Promise<SearchResult> {
    return fuseSearch(lexical, await this.hits(owner, lexical.query, type, Math.max(30, limit)), limit);
  }
}

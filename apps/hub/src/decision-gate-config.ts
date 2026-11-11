import {
  DECISION_GATE_DEFAULTS, DecisionGateBinding, DecisionGateBindingUpdate, TYPESAFE_JEV_BASE_URL, type AIConnection,
} from "@lumio/schema";
import type { SqliteAIStore } from "@lumio/storage";
import { HubError } from "./errors.ts";

const PURPOSE = "decision.gate";

type BindingRow = { connection: string | null; model: string; revision: number };

function isJevConnection(connection: AIConnection): boolean {
  return connection.kind === "typesafe-jev" && connection.host === "hub" &&
    connection.base_url === TYPESAFE_JEV_BASE_URL && connection.api_key_set;
}

export class DecisionGateConfiguration {
  constructor(private readonly store: SqliteAIStore) {
    this.store.db.exec(
      "CREATE TABLE IF NOT EXISTS decision_gate_bindings (" +
      "owner TEXT PRIMARY KEY, connection TEXT REFERENCES ai_connections(id), model TEXT NOT NULL, revision INTEGER NOT NULL)",
    );
  }

  private row(owner: string): BindingRow | null {
    return this.store.db.query<BindingRow, [string]>(
      "SELECT connection, model, revision FROM decision_gate_bindings WHERE owner=?",
    ).get(owner);
  }

  private view(row: BindingRow | null): DecisionGateBinding | null {
    if (!row?.connection) return null;
    return DecisionGateBinding.parse({ purpose: PURPOSE, ...row });
  }

  binding(owner: string): DecisionGateBinding | null {
    return this.view(this.row(owner));
  }

  update(owner: string, raw: unknown): DecisionGateBinding | null {
    const input = DecisionGateBindingUpdate.parse(raw);
    const scope = PURPOSE + ":" + owner;
    const fingerprint = JSON.stringify(input);
    const conflict = () => new HubError("CONFLICT", { key: "ai.conflict", args: [] });
    return this.store.db.transaction(() => {
      const receipt = this.store.receipt(scope, input.request_id, fingerprint);
      if (receipt) {
        if (!receipt.matches) throw conflict();
        return DecisionGateBinding.nullable().parse(receipt.result);
      }

      const current = this.row(owner);
      if (input.expected_revision !== undefined &&
          (!current?.connection || current.revision !== input.expected_revision)) throw conflict();
      const connection = input.connection;
      if (connection) {
        const owned = this.store.connection(connection);
        if (!owned || owned.owner !== owner) throw new HubError("NOT_FOUND", { key: "ai.connection_missing", args: [] });
        if (!isJevConnection(owned) || !this.store.secret(connection)?.trim()) {
          throw new HubError("INVALID", { key: "ai.decision_gate_connection", args: [] });
        }
      }

      // Keep the revision after unbinding so a stale revision cannot target a future binding.
      const model = input.model ?? DECISION_GATE_DEFAULTS.model;
      const revision = (current?.revision ?? 0) + 1;
      this.store.db.query(
        "INSERT INTO decision_gate_bindings(owner, connection, model, revision) VALUES(?, ?, ?, ?) " +
        "ON CONFLICT(owner) DO UPDATE SET connection=excluded.connection, model=excluded.model, revision=excluded.revision",
      ).run(owner, connection, model, revision);
      const result = this.view({ connection, model, revision });
      this.store.putReceipt(scope, input.request_id, fingerprint, result);
      return result;
    }).immediate();
  }

  resolve(owner: string): { binding: DecisionGateBinding; credential: string } | undefined {
    const binding = this.binding(owner);
    if (!binding) return undefined;
    const connection = this.store.connection(binding.connection);
    if (!connection || connection.owner !== owner || !isJevConnection(connection)) return undefined;
    const credential = this.store.secret(connection.id);
    if (!credential?.trim()) return undefined;
    return { binding, credential };
  }
}

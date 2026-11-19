import { AssistantDefaultBinding, AssistantDefaultBindingUpdate, type AIConfiguration } from "@lumio/schema";
import type { SqliteAIStore } from "@lumio/storage";
import { HubError } from "./errors.ts";

const PURPOSE = "assistant.default";

type Row = { profile: string | null; revision: number };

/**
 * 主对话可直接调用的 Profile：`lumio` 引擎、连接在 Hub 上并带 API 地址。
 * 网页和 Hub 用同一条规则，设置页显示的默认模型就是 Hub 实际会用的模型（ADR 0083）。
 */
export function usableAssistantProfiles(config: AIConfiguration): AIConfiguration["profiles"] {
  return config.profiles.filter(profile => profile.engine === "lumio" &&
    config.connections.some(connection => connection.id === profile.connection && connection.host === "hub" && !!connection.base_url));
}

/** ADR 0083：账号级默认助手 Profile。以前只存在浏览器里，Hub 处理不带 Profile 的聊天时读不到。 */
export class AssistantDefaultConfiguration {
  constructor(private readonly store: SqliteAIStore) {
    this.store.db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_default_bindings (" +
      "owner TEXT PRIMARY KEY, profile TEXT, revision INTEGER NOT NULL)",
    );
  }

  private row(owner: string): Row | null {
    return this.store.db.query<Row, [string]>("SELECT profile, revision FROM assistant_default_bindings WHERE owner=?").get(owner);
  }

  /** Profile 被删除后绑定自动失效，不阻止删除。 */
  binding(owner: string): AssistantDefaultBinding | null {
    const row = this.row(owner);
    if (!row?.profile) return null;
    const profile = this.store.profile(row.profile);
    if (!profile || profile.owner !== owner) return null;
    return AssistantDefaultBinding.parse({ purpose: PURPOSE, profile: row.profile, revision: row.revision });
  }

  update(owner: string, raw: unknown): AssistantDefaultBinding | null {
    const parsed = AssistantDefaultBindingUpdate.safeParse(raw);
    if (!parsed.success) throw new HubError("INVALID", { key: "ai.invalid", args: [] });
    const input = parsed.data;
    const scope = PURPOSE + ":" + owner;
    const fingerprint = JSON.stringify(input);
    const conflict = () => new HubError("CONFLICT", { key: "ai.conflict", args: [] });
    return this.store.db.transaction(() => {
      const receipt = this.store.receipt(scope, input.request_id, fingerprint);
      if (receipt) {
        if (!receipt.matches) throw conflict();
        return AssistantDefaultBinding.nullable().parse(receipt.result);
      }
      const current = this.row(owner);
      if (input.expected_revision !== undefined && current?.revision !== input.expected_revision) throw conflict();
      if (input.profile) {
        const profile = this.store.profile(input.profile);
        if (!profile || profile.owner !== owner) throw new HubError("NOT_FOUND", { key: "ai.profile_missing", args: [] });
        // 助手只能用聊天 Profile；Codex Profile 可作新对话的默认（原生会话），API 主对话按 usableAssistantProfiles 解析。
        if (profile.engine !== "lumio" && profile.engine !== "codex") throw new HubError("INVALID", { key: "ai.engine_mismatch", args: [] });
      }
      // 清除后保留版本号，旧版本号不能指向之后的新绑定。
      const revision = (current?.revision ?? 0) + 1;
      this.store.db.query(
        "INSERT INTO assistant_default_bindings(owner, profile, revision) VALUES(?, ?, ?) " +
        "ON CONFLICT(owner) DO UPDATE SET profile=excluded.profile, revision=excluded.revision",
      ).run(owner, input.profile, revision);
      const result = input.profile
        ? AssistantDefaultBinding.parse({ purpose: PURPOSE, profile: input.profile, revision })
        : null;
      this.store.putReceipt(scope, input.request_id, fingerprint, result);
      return result;
    }).immediate();
  }

  /**
   * 不带 Profile 的主对话请求用哪个 Profile：账号默认（可直接调用时）→ 第一个可用的 API Profile。
   * 都没有时返回 undefined，调用方再用 Hub 的旧 API 设置兜底。
   */
  resolve(owner: string, config: AIConfiguration): string | undefined {
    const usable = usableAssistantProfiles(config);
    const chosen = this.binding(owner)?.profile;
    return usable.find(profile => profile.id === chosen)?.id ?? usable[0]?.id;
  }
}

import type { SqliteAssistantStore } from "@lumio/storage";
import { HubError } from "./errors.ts";
import type { HubStore } from "./store.ts";

/** Hub's owner-to-conversation binding. Assistant continues to own conversation records. */
export class AssistantMainConversations {
  constructor(private readonly hub: HubStore, private readonly assistant: SqliteAssistantStore) {
    this.hub.db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_main_conversations (
        owner TEXT PRIMARY KEY REFERENCES actors(id),
        conversation TEXT NOT NULL UNIQUE REFERENCES assistant_conversations(id) ON DELETE CASCADE
      );
    `);
  }

  mainConversation(owner: string): string | undefined {
    const binding = this.hub.db.query<{ conversation: string }, [string]>(
      "SELECT conversation FROM assistant_main_conversations WHERE owner=?",
    ).get(owner);
    if (binding && this.assistant.conversation(binding.conversation)?.owner === owner && !this.assistant.trash(binding.conversation)) {
      return binding.conversation;
    }
  }

  isMain(owner: string, conversation: string): boolean {
    return this.mainConversation(owner) === conversation;
  }

  bindMain(owner: string, conversation: string): void {
    this.hub.db.transaction(() => {
      const human = this.hub.actors().some(actor => actor.id === owner && actor.role === "human");
      if (!human || this.assistant.conversation(conversation)?.owner !== owner || this.assistant.trash(conversation)) {
        throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
      }
      const current = this.mainConversation(owner);
      if (current === conversation) return;
      if (current) throw new HubError("CONFLICT", { key: "assistant.main.already_bound", args: [] });
      this.hub.db.query(`INSERT INTO assistant_main_conversations (owner, conversation) VALUES (?, ?)
        ON CONFLICT(owner) DO UPDATE SET conversation=excluded.conversation`).run(owner, conversation);
    })();
  }
}

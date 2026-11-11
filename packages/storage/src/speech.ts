import type { Database } from "bun:sqlite";
import { SpeechBinding, SpeechVocabulary, SpeechVocabularySync } from "@lumio/schema";

export type SpeechPurpose = SpeechBinding["purpose"];
export type StoredVocabulary = Omit<SpeechVocabulary, "sync">;
export interface StoredVocabularySync {
  view: SpeechVocabularySync;
  vocabularyId?: string | undefined;
  submittedHash?: string | undefined;
  credentialHash?: string | undefined;
  attemptedHash?: string | undefined;
  vocabularyCredentialHash?: string | undefined;
}

export class SqliteSpeechStore {
  constructor(readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS speech_vocabulary(owner TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS speech_vocabulary_sync(
        connection TEXT PRIMARY KEY REFERENCES ai_connections(id) ON DELETE CASCADE,
        record TEXT NOT NULL CHECK(json_valid(record))
      );
      CREATE TABLE IF NOT EXISTS speech_bindings(
        owner TEXT NOT NULL, purpose TEXT NOT NULL, profile TEXT REFERENCES ai_profiles(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL, PRIMARY KEY(owner,purpose)
      );
      CREATE TRIGGER IF NOT EXISTS speech_profile_removed BEFORE DELETE ON ai_profiles BEGIN
        UPDATE speech_bindings SET profile=NULL, revision=revision+1 WHERE profile=OLD.id;
      END;
    `);
  }

  vocabulary(owner: string): StoredVocabulary | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM speech_vocabulary WHERE owner=?").get(owner);
    if (row) {
      const { sync: _, ...value } = SpeechVocabulary.parse({ ...JSON.parse(row.record), sync: [] });
      return value;
    }
  }

  putVocabulary(value: StoredVocabulary) {
    SpeechVocabulary.parse({ ...value, sync: [] });
    this.db.query("INSERT INTO speech_vocabulary VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET record=excluded.record")
      .run(value.owner, JSON.stringify(value));
  }

  sync(connection: string): StoredVocabularySync | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM speech_vocabulary_sync WHERE connection=?").get(connection);
    return row ? JSON.parse(row.record) as StoredVocabularySync : undefined;
  }

  putSync(value: StoredVocabularySync) {
    SpeechVocabularySync.parse(value.view);
    this.db.query("INSERT INTO speech_vocabulary_sync VALUES(?,?) ON CONFLICT(connection) DO UPDATE SET record=excluded.record")
      .run(value.view.connection, JSON.stringify(value));
  }

  bindings(owner: string): SpeechBinding[] {
    return this.db.query<SpeechBinding, [string]>("SELECT purpose, profile, revision FROM speech_bindings WHERE owner=? AND profile IS NOT NULL ORDER BY purpose")
      .all(owner).map(row => SpeechBinding.parse(row));
  }

  binding(owner: string, purpose: SpeechPurpose) {
    return this.db.query<{ profile: string | null; revision: number }, [string, SpeechPurpose]>(
      "SELECT profile, revision FROM speech_bindings WHERE owner=? AND purpose=?").get(owner, purpose);
  }

  putBinding(owner: string, purpose: SpeechPurpose, profile: string | null, revision: number) {
    this.db.query(`INSERT INTO speech_bindings VALUES(?,?,?,?)
      ON CONFLICT(owner,purpose) DO UPDATE SET profile=excluded.profile,revision=excluded.revision`).run(owner, purpose, profile, revision);
  }
}

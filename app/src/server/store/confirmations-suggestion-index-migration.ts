import type Database from 'better-sqlite3';
import { CONFIRMATIONS_SUGGESTION_INDEX_SQL } from './schema';

const normalize = (sql: string) => sql.toLowerCase().replace(/\s+/g, '').replace('ifnotexists', '').replace(/;$/, '');

/** Add the lookup index without rebuilding or modifying append-only confirmation history. */
export function migrateConfirmationsSuggestionIndex(db: Database.Database): void {
  const name = 'idx_confirmations_suggestion_id';
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as { sql: string | null } | undefined;
  if (existing && (!existing.sql || normalize(existing.sql) !== normalize(CONFIRMATIONS_SUGGESTION_INDEX_SQL))) {
    throw new Error('Existing confirmation suggestion index has an unexpected definition');
  }
  db.exec(CONFIRMATIONS_SUGGESTION_INDEX_SQL);
  const installed = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as { sql: string | null } | undefined;
  if (!installed?.sql || normalize(installed.sql) !== normalize(CONFIRMATIONS_SUGGESTION_INDEX_SQL)) {
    throw new Error('Confirmation suggestion index migration failed');
  }
}

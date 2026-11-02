import type Database from 'better-sqlite3';
import { EVIDENCE_QUOTE_CACHE_SQL, ONTOLOGY_SNIPPET_LOOKUP_INDEX_SQL, ONTOLOGY_SUMMARY_INDEX_SQL, ONTOLOGY_SYNTHESIS_SQL, PORTFOLIO_LEVEL_REVIEWS_SQL, PORTFOLIO_SNAPSHOTS_SQL, QUOTE_CACHE_V3_SQL, REPORT_INPUT_REVISION_SQL } from './schema';
import { migrateConfirmationsSuggestionIndex } from './confirmations-suggestion-index-migration';

const normalizeIndexSql = (sql: string) => sql.split("'").map((part, index) => index % 2 ? part : part.toLowerCase().replace(/\s+/g, '').replace('ifnotexists', '')).join("'").replace(/;$/, '');

/** Preserve history and row ordering while upgrading levels and project deletion. */
export function migratePortfolioLevels(db: Database.Database): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ontology_portfolio_level_reviews'").get() as {sql: string} | undefined;
  if (!table) return;
  const fks = db.pragma('foreign_key_list(ontology_portfolio_level_reviews)') as Array<{ table: string; on_delete: string }>;
  const cascadeReady = ['projects', 'ontology_imports'].every((parent) => fks.some((fk) => fk.table === parent && fk.on_delete === 'CASCADE'));
  if (table.sql.includes("'Lv5'") && cascadeReady) return;
  if (!table.sql.includes("'Lv4'")) throw new Error('Unexpected portfolio level table definition');
  db.transaction(() => {
    db.exec(`DROP TRIGGER IF EXISTS trg_ontology_portfolio_level_reviews_no_update;
      DROP TRIGGER IF EXISTS trg_ontology_portfolio_level_reviews_no_delete;
      DROP TRIGGER IF EXISTS trg_portfolio_level_revision_insert;
      DROP INDEX IF EXISTS idx_ontology_portfolio_level_reviews_node;
      ALTER TABLE ontology_portfolio_level_reviews RENAME TO ontology_portfolio_level_reviews_old;`);
    db.exec(PORTFOLIO_LEVEL_REVIEWS_SQL);
    db.exec(`INSERT INTO ontology_portfolio_level_reviews (rowid, id, project_id, import_id, node_id, node_type, outcome_family, ai_level, team_level, reviewer, created_at)
      SELECT rowid, id, project_id, import_id, node_id, node_type, outcome_family, ai_level, team_level, reviewer, created_at FROM ontology_portfolio_level_reviews_old;
      DROP TABLE ontology_portfolio_level_reviews_old;`);
  })();
}

/** Prepare only the new cache objects and index; never replace an existing index. */
export function migrateAdditiveSchema(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get('idx_ontology_sources_summary') as { sql: string | null } | undefined;
  if (row && (!row.sql || normalizeIndexSql(row.sql) !== normalizeIndexSql(ONTOLOGY_SUMMARY_INDEX_SQL))) {
    throw new Error('Existing ontology source summary index has an unexpected definition');
  }
  const snippetIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get('idx_ontology_snippets_project_id_id') as { sql: string | null } | undefined;
  if (snippetIndex && (!snippetIndex.sql || normalizeIndexSql(snippetIndex.sql) !== normalizeIndexSql(ONTOLOGY_SNIPPET_LOOKUP_INDEX_SQL))) {
    throw new Error('Existing ontology snippet lookup index has an unexpected definition');
  }
  db.exec(QUOTE_CACHE_V3_SQL);
  db.exec(EVIDENCE_QUOTE_CACHE_SQL);
  db.exec(PORTFOLIO_LEVEL_REVIEWS_SQL);
  migratePortfolioLevels(db);
  db.exec(PORTFOLIO_SNAPSHOTS_SQL);
  db.exec(ONTOLOGY_SUMMARY_INDEX_SQL);
  db.exec(ONTOLOGY_SNIPPET_LOOKUP_INDEX_SQL);
  migrateConfirmationsSuggestionIndex(db);
  db.exec(ONTOLOGY_SYNTHESIS_SQL);
  // Older revisions of this table referenced projects with ON DELETE CASCADE.
  // Cascaded child-delete revision triggers run after the project row is gone,
  // so that FK makes legitimate project deletion fail. Rebuild the tiny marker
  // table without the FK; the project-delete trigger removes its marker after
  // cascades finish.
  const revisionForeignKeys = db.pragma('foreign_key_list(report_input_revisions)') as Array<{ table: string }>;
  if (revisionForeignKeys.some((fk) => fk.table === 'projects')) {
    db.transaction(() => {
      db.exec(`CREATE TABLE report_input_revisions_rebuild (
        project_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
      )`);
      db.exec('INSERT INTO report_input_revisions_rebuild(project_id, revision) SELECT project_id, revision FROM report_input_revisions');
      db.exec('DROP TABLE report_input_revisions');
      db.exec('ALTER TABLE report_input_revisions_rebuild RENAME TO report_input_revisions');
    })();
  }
  db.exec(REPORT_INPUT_REVISION_SQL);
  const installedSnippetIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get('idx_ontology_snippets_project_id_id') as { sql: string | null } | undefined;
  if (!installedSnippetIndex?.sql || normalizeIndexSql(installedSnippetIndex.sql) !== normalizeIndexSql(ONTOLOGY_SNIPPET_LOOKUP_INDEX_SQL)) {
    throw new Error('Ontology snippet lookup index migration failed');
  }
  const result = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get('idx_ontology_sources_summary') as { sql: string | null } | undefined;
  if (!result?.sql || normalizeIndexSql(result.sql) !== normalizeIndexSql(ONTOLOGY_SUMMARY_INDEX_SQL)) {
    throw new Error('Ontology source summary index migration failed');
  }
}

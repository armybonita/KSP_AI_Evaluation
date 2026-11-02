import type Database from 'better-sqlite3';
import { getDatabase } from './db';

export interface ExcludedDocumentSummary {
  unconfirmed: number;
  past: number;
}

/** Count excluded documents without reading document names or derived content. */
export function excludedDocumentSummary(projectId: string, db: Database.Database = getDatabase()): ExcludedDocumentSummary {
  return db.prepare(`SELECT
    COUNT(CASE WHEN is_past_final_report IS NULL THEN 1 END) AS unconfirmed,
    COUNT(CASE WHEN is_past_final_report = 1 THEN 1 END) AS past
    FROM documents WHERE project_id = ? AND is_included = 1`).get(projectId) as ExcludedDocumentSummary;
}

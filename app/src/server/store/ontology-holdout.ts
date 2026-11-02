import type Database from 'better-sqlite3';
import { isConfirmedNonPastReport } from '../documents/holdout';

/** Resolve the current document state, not the state at graph creation time. */
export function holdoutOntologySources(projectId: string, db: Database.Database, sources: Map<string, Record<string, unknown>>): Set<string> {
  const documentIds = [...new Set([...sources.values()].flatMap(source =>
    typeof source.document_id === 'string' && source.document_id ? [source.document_id] : []))];
  if (!documentIds.length) return new Set();
  const documents = db.prepare(`SELECT id, doc_type, is_past_final_report FROM documents
    WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .all(projectId, JSON.stringify(documentIds)) as Array<{ id: string; doc_type: string | null; is_past_final_report: number | null }>;
  const excluded = new Set(documents.filter(document => !isConfirmedNonPastReport(document)).map(document => document.id));
  return new Set([...sources].flatMap(([id, source]) =>
    typeof source.document_id === 'string' && excluded.has(source.document_id) ? [id] : []));
}

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from './db';

/** Hash persisted inputs without assembling the knowledge map or invoking AI. */
export function reportInputFingerprint(projectId: string, db: Database.Database = getDatabase()): string {
  const row = db.prepare('SELECT revision FROM report_input_revisions WHERE project_id = ?').get(projectId) as { revision: number } | undefined;
  // Missing revision state means the additive migration has not been applied.
  // Fail closed so an old draft can never be accepted on an untracked DB.
  if (!row) return '';
  return crypto.createHash('sha256').update(`report-input-revision-v1|${projectId}|${row.revision}`).digest('hex');
}

export function reportDraftCount(projectId: string, db: Database.Database = getDatabase()): number {
  const rows = db.prepare('SELECT content_json FROM reports WHERE project_id = ?').all(projectId) as Array<{ content_json: string }>;
  const numbered = new Set<number>();
  let legacyDrafts = 0;
  for (const row of rows) {
    try {
      const data = JSON.parse(row.content_json) as { draft_number?: unknown; report_finalization?: unknown };
      if (Number.isInteger(data.draft_number) && Number(data.draft_number) > 0) numbered.add(Number(data.draft_number));
      else if (!data.report_finalization) legacyDrafts += 1;
    } catch {
      legacyDrafts += 1;
    }
  }
  // 번호 없는 옛 판은 v1..vN 으로 본다. 번호 있는 판은 그 뒤에 매겨졌으므로 더하지 않고 큰 쪽을 쓴다.
  return Math.max(legacyDrafts, ...numbered);
}
/** Count project-owned paragraphs without exposing database access to callers. */
export function reportParagraphCount(projectId: string, db: Database.Database = getDatabase()): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM paragraphs p
    JOIN documents d ON d.id = p.document_id WHERE d.project_id = ?`).get(projectId) as { count: number }).count;
}
/** Indexed readiness count for the report screen's no-draft state. */
export function getReportTargetCount(projectId: string, db: Database.Database = getDatabase()): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM indicators i
    WHERE i.project_id = ? AND EXISTS (
      SELECT 1 FROM confirmations c WHERE c.indicator_id = i.id
        AND c.rowid = (SELECT MAX(latest.rowid) FROM confirmations latest WHERE latest.indicator_id = i.id)
        AND c.confirmation_type IN ('확정', '수정 후 확정')
    )`).get(projectId) as { count: number }).count;
}
export function reportSourceRows(projectId: string, importId: string | null, db: Database.Database = getDatabase()): Array<{ id: string; data_json: string }> {
  return importId ? db.prepare('SELECT id, data_json FROM ontology_sources WHERE project_id = ? AND import_id = ?').all(projectId, importId) as Array<{ id: string; data_json: string }> : [];
}
export function reportIndicatorLevels(projectId: string, db: Database.Database = getDatabase()): Array<{ id: string; level: string }> {
  return db.prepare('SELECT id, level FROM indicators WHERE project_id = ?').all(projectId) as Array<{ id: string; level: string }>;
}
export function reportEvidenceDetails(id: string, db: Database.Database = getDatabase()): { quote: string; speaker: string; document_id: string; is_citation_banned: number } | undefined {
  return db.prepare('SELECT quote, speaker, document_id, is_citation_banned FROM evidences WHERE id = ?').get(id) as { quote: string; speaker: string; document_id: string; is_citation_banned: number } | undefined;
}
export function reportIndicatorReview(id: string, db: Database.Database = getDatabase()): { confirmation_type: string; confirmer_name: string; created_at: string } | undefined {
  return db.prepare('SELECT confirmation_type, confirmer_name, created_at FROM confirmations WHERE indicator_id = ? ORDER BY rowid DESC LIMIT 1').get(id) as { confirmation_type: string; confirmer_name: string; created_at: string } | undefined;
}
export function reportDocumentState(projectId: string, id: string, db: Database.Database = getDatabase()): { is_included: number; doc_type: string | null; is_past_final_report: number | null } | undefined {
  return db.prepare('SELECT is_included, doc_type, is_past_final_report FROM documents WHERE id = ? AND project_id = ?').get(id, projectId) as { is_included: number; doc_type: string | null; is_past_final_report: number | null } | undefined;
}
export function reportParagraphContent(id: string, documentId: string, db: Database.Database = getDatabase()): string | undefined {
  return (db.prepare('SELECT content FROM paragraphs WHERE id = ? AND document_id = ?').get(id, documentId) as { content: string } | undefined)?.content;
}
export function reportBannedParagraphIds(projectId: string, db: Database.Database = getDatabase()): Set<string> {
  const rows = db.prepare('SELECT DISTINCT s.paragraph_id FROM sentences s JOIN documents d ON d.id = s.document_id WHERE d.project_id = ? AND s.is_citation_banned = 1').all(projectId) as Array<{ paragraph_id: string }>;
  return new Set(rows.map(row => row.paragraph_id));
}

export interface ReportSnippetFact {
  id: string;
  snippet_json: string;
  source_json: string;
  document_id: string | null;
  is_included: number | null;
  masked: number | null;
  approved_ai: string | null;
  is_past_final_report: number | null;
  doc_type: string | null;
  cache_verified: number | null;
}

/** Resolve saved ontology snippet IDs through the current import and its source row. */
export function reportSnippetFacts(projectId: string, ids: string[], db: Database.Database = getDatabase()): ReportSnippetFact[] {
  if (!ids.length) return [];
  const facts: ReportSnippetFact[] = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(',');
    facts.push(...db.prepare(`SELECT sn.id, sn.data_json AS snippet_json, src.data_json AS source_json,
      json_extract(src.data_json, '$.document_id') AS document_id,
      d.is_included, d.masked, d.approved_ai, d.is_past_final_report, d.doc_type,
      q.verified AS cache_verified
    FROM ontology_imports i
    JOIN ontology_snippets sn ON sn.project_id = i.project_id AND sn.import_id = i.id
    JOIN ontology_sources src ON src.project_id = i.project_id AND src.import_id = i.id
      AND src.id = json_extract(sn.data_json, '$.source')
    LEFT JOIN documents d ON d.id = json_extract(src.data_json, '$.document_id') AND d.project_id = i.project_id
    LEFT JOIN ontology_quote_verification_cache_v3 q ON q.project_id = i.project_id AND q.import_id = i.id AND q.snippet_id = sn.id
    WHERE i.project_id = ? AND i.id = (SELECT id FROM ontology_imports WHERE project_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT 1)
      AND sn.id IN (${placeholders})`).all(projectId, projectId, ...chunk) as ReportSnippetFact[]);
  }
  return facts;
}

/** Latest review status for a bounded set of current-import nodes. */
export function reportLatestNodeReviewStatuses(projectId: string, nodeIds: string[], db: Database.Database = getDatabase()): Array<{ node_id: string; status: string }> {
  if (!nodeIds.length) return [];
  const statuses: Array<{ node_id: string; status: string }> = [];
  for (let offset = 0; offset < nodeIds.length; offset += 400) {
    const chunk = nodeIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(',');
    statuses.push(...db.prepare(`SELECT r.node_id, r.status FROM ontology_note_reviews r
    WHERE r.project_id = ?
      AND r.import_id = (SELECT id FROM ontology_imports WHERE project_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT 1)
      AND r.node_id IN (${placeholders})
      AND r.rowid = (SELECT MAX(r2.rowid) FROM ontology_note_reviews r2
        WHERE r2.project_id = r.project_id AND r2.import_id = r.import_id AND r2.node_id = r.node_id)`)
    .all(projectId, projectId, ...chunk) as Array<{ node_id: string; status: string }>);
  }
  return statuses;
}

export function reportLatestNodeData(projectId: string, nodeIds: string[], db: Database.Database = getDatabase()): Array<{ id: string; data_json: string }> {
  if (!nodeIds.length) return [];
  const nodes: Array<{ id: string; data_json: string }> = [];
  for (let offset = 0; offset < nodeIds.length; offset += 400) {
    const chunk = nodeIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(',');
    nodes.push(...db.prepare(`SELECT n.id, n.data_json FROM ontology_nodes n
      WHERE n.project_id = ?
        AND n.import_id = (SELECT id FROM ontology_imports WHERE project_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT 1)
        AND n.id IN (${placeholders})`).all(projectId, projectId, ...chunk) as Array<{ id: string; data_json: string }>);
  }
  return nodes;
}

export function reportLatestIndicatorConfirmations(projectId: string, indicatorIds: string[], db: Database.Database = getDatabase()): Array<{ indicator_id: string; confirmation_type: string }> {
  if (!indicatorIds.length) return [];
  const confirmations: Array<{ indicator_id: string; confirmation_type: string }> = [];
  for (let offset = 0; offset < indicatorIds.length; offset += 400) {
    const chunk = indicatorIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(',');
    confirmations.push(...db.prepare(`SELECT i.id AS indicator_id, c.confirmation_type FROM indicators i
      JOIN confirmations c ON c.indicator_id = i.id
      WHERE i.project_id = ? AND c.rowid = (SELECT MAX(c2.rowid) FROM confirmations c2 WHERE c2.indicator_id = i.id)
        AND i.id IN (${placeholders})`).all(projectId, ...chunk) as Array<{ indicator_id: string; confirmation_type: string }>);
  }
  return confirmations;
}

/** Resolve paragraph footnotes through documents owned by the requested project. */
export function reportParagraphFacts(projectId: string, paragraphIds: string[], db: Database.Database = getDatabase()): Array<{ id: string; document_id: string; content: string; location: string; is_included: number; doc_type: string | null; is_past_final_report: number | null }> {
  if (!paragraphIds.length) return [];
  const facts: Array<{ id: string; document_id: string; content: string; location: string; is_included: number; doc_type: string | null; is_past_final_report: number | null }> = [];
  for (let offset = 0; offset < paragraphIds.length; offset += 400) {
    const chunk = paragraphIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(',');
    facts.push(...db.prepare(`SELECT p.id, p.document_id, p.content, p.location, d.is_included, d.doc_type, d.is_past_final_report FROM paragraphs p
      JOIN documents d ON d.id = p.document_id WHERE d.project_id = ? AND p.id IN (${placeholders})`)
      .all(projectId, ...chunk) as Array<{ id: string; document_id: string; content: string; location: string; is_included: number; doc_type: string | null; is_past_final_report: number | null }>);
  }
  return facts;
}

export function reportEvidenceFacts(projectId: string, ids: string[], db: Database.Database = getDatabase()): Array<{ id: string; quote: string; document_id: string; location: string; is_citation_banned: number; is_included: number; masked: number | null; approved_ai: string | null; is_past_final_report: number | null; doc_type: string | null; verified: number | null }> {
  if (!ids.length) return [];
  const facts: Array<{ id: string; quote: string; document_id: string; location: string; is_citation_banned: number; is_included: number; masked: number | null; approved_ai: string | null; is_past_final_report: number | null; doc_type: string | null; verified: number | null }> = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(',');
    facts.push(...db.prepare(`SELECT e.id, e.quote, e.document_id, e.location, e.is_citation_banned,
        d.is_included, d.masked, d.approved_ai, d.is_past_final_report, d.doc_type,
        c.verified
      FROM evidences e JOIN suggestions s ON s.id = e.suggestion_id JOIN indicators i ON i.id = s.indicator_id
      JOIN documents d ON d.id = e.document_id AND d.project_id = i.project_id
      LEFT JOIN evidence_quote_verification_cache c ON c.project_id = i.project_id AND c.evidence_id = e.id AND c.algorithm_version = 1
      WHERE i.project_id = ? AND e.id IN (${placeholders})`).all(projectId, ...chunk) as Array<{ id: string; quote: string; document_id: string; location: string; is_citation_banned: number; is_included: number; masked: number | null; approved_ai: string | null; is_past_final_report: number | null; doc_type: string | null; verified: number | null }>);
  }
  return facts;
}

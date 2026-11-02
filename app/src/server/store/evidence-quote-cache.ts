import type Database from 'better-sqlite3';
import { createForbiddenSentenceIndex, createForbiddenSentenceMatcher, maskForbiddenSentenceInContent } from './citation-ban';
import { isCitableEvidence } from './citable-evidence';

/** Called in the writer's transaction or a per-project preparation transaction. */
export function prepareEvidenceQuoteCache(projectId: string, db: Database.Database): number {
  const banned = (db.prepare(`SELECT s.content FROM sentences s
    JOIN paragraphs p ON p.id = s.paragraph_id
    JOIN documents d ON d.id = p.document_id
    WHERE d.project_id = ? AND s.is_citation_banned = 1
    ORDER BY s.sequence_no ASC`).all(projectId) as Array<{ content: string }>).map(row => row.content);
  const index = createForbiddenSentenceIndex(banned);
  const overlaps = createForbiddenSentenceMatcher(banned);
  const rows = db.prepare(`SELECT e.id, e.quote, e.speaker, e.is_citation_banned, e.document_id, e.location
    FROM evidences e
    JOIN suggestions s ON s.id = e.suggestion_id
    JOIN indicators i ON i.id = s.indicator_id
    JOIN documents d ON d.id = e.document_id AND d.project_id = i.project_id
    WHERE i.project_id = ? AND NOT EXISTS (
      SELECT 1 FROM evidence_quote_verification_cache c
      WHERE c.project_id = i.project_id AND c.evidence_id = e.id AND c.algorithm_version = 1
    )`).all(projectId) as Array<{
      id: string; quote: string; speaker: string; is_citation_banned: number; document_id: string; location: string;
    }>;
  const findParagraph = db.prepare('SELECT content FROM paragraphs WHERE document_id = ? AND location = ? LIMIT 1');
  const paragraphs = new Map<string, string | null>();
  const checks = new Map<string, boolean>();
  const save = db.prepare(`INSERT INTO evidence_quote_verification_cache (project_id, evidence_id, verified, algorithm_version) VALUES (?, ?, ?, 1)
    ON CONFLICT(project_id, evidence_id) DO UPDATE SET verified = excluded.verified, algorithm_version = excluded.algorithm_version`);
  for (const evidence of rows) {
    const key = JSON.stringify([evidence.document_id, evidence.location]);
    if (!paragraphs.has(key)) {
      const paragraph = findParagraph.get(evidence.document_id, evidence.location) as { content: string } | undefined;
      paragraphs.set(key, paragraph ? maskForbiddenSentenceInContent(paragraph.content, banned, overlaps) : null);
    }
    const checkKey = JSON.stringify([key, evidence.quote, evidence.speaker, evidence.is_citation_banned]);
    if (!checks.has(checkKey)) checks.set(checkKey, isCitableEvidence(evidence, paragraphs.get(key), banned, index));
    save.run(projectId, evidence.id, Number(checks.get(checkKey)));
  }
  return rows.length;
}

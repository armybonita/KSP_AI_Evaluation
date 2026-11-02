import { getDatabase } from './db';
import type { DbConnection } from './db';

export interface ProjectEligibilityFingerprintInputs {
  documents: Array<{
    id: string;
    is_included: number;
    is_past_final_report: number | null;
    masked: number | null;
    approved_ai: string;
    status: string;
  }>;
  bannedSentences: Array<{
    sequence_no: number;
    id: string;
    is_citation_banned: number;
    content: string;
  }>;
}

/** Reads the small project-scoped inputs used to identify AI eligibility changes. */
export function getProjectEligibilityFingerprintInputs(
  projectId: string,
  db: DbConnection = getDatabase(),
): ProjectEligibilityFingerprintInputs {
  const documents = db.prepare(`SELECT id, is_included, is_past_final_report, masked, approved_ai, status
    FROM documents WHERE project_id = ? ORDER BY id`).all(projectId) as ProjectEligibilityFingerprintInputs['documents'];
  const bannedSentences = db.prepare(`SELECT s.id, s.sequence_no, s.is_citation_banned, s.content
    FROM sentences s JOIN paragraphs p ON p.id = s.paragraph_id JOIN documents d ON d.id = p.document_id
    WHERE d.project_id = ? AND s.is_citation_banned = 1 ORDER BY s.sequence_no, s.id`).all(projectId) as ProjectEligibilityFingerprintInputs['bannedSentences'];
  return { documents, bannedSentences };
}

import { getDatabase } from './db';

/** Existing graph evidence linked to this project's document, regardless of its current eligibility. */
export function documentHasOntologyEvidence(projectId: string, documentId: string): boolean {
  return Boolean(getDatabase().prepare(`
    SELECT 1 FROM ontology_sources src
    JOIN ontology_snippets snip ON snip.project_id = src.project_id AND snip.import_id = src.import_id
      AND json_extract(snip.data_json, '$.source') = src.id
    WHERE src.project_id = ? AND json_extract(src.data_json, '$.document_id') = ? LIMIT 1
  `).get(projectId, documentId));
}

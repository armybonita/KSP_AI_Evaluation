import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export const PDM_PARSER_VERSION = 4;

/** The content digest catches edits made by older versions without a revision counter. */
export function withTocSourceFingerprint<T>(projectId: string, db: Database.Database, sync: () => T, read: () => T): T {
  db.exec(`CREATE TABLE IF NOT EXISTS toc_source_fingerprints (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL
  )`);
  return db.transaction(() => {
    const hash = crypto.createHash('sha256');
    const docs = db.prepare(`SELECT id, file_name, doc_type, is_included, is_past_final_report, created_at FROM documents
      WHERE project_id = ? AND doc_type IN ('성과관리표', '사업계획서') ORDER BY id`).all(projectId);
    const paragraphs = db.prepare(`SELECT p.id, p.document_id, p.sequence_no, p.location, p.content,
      p.table_index, p.table_cols, p.table_row, p.table_col, p.grid_coord_version
      FROM paragraphs p JOIN documents d ON d.id = p.document_id
      WHERE d.project_id = ? AND d.is_included = 1 AND d.doc_type IN ('성과관리표', '사업계획서')
      ORDER BY p.document_id, p.sequence_no, p.id`);
    hash.update(`pdm-parser:${PDM_PARSER_VERSION}\n`);
    hash.update(JSON.stringify(docs));
    for (const paragraph of paragraphs.iterate(projectId)) hash.update(JSON.stringify(paragraph));
    const fingerprint = hash.digest('hex');
    const saved = db.prepare('SELECT fingerprint FROM toc_source_fingerprints WHERE project_id = ?').get(projectId) as { fingerprint: string } | undefined;
    if (saved?.fingerprint === fingerprint) return read();
    const result = sync();
    db.prepare(`INSERT INTO toc_source_fingerprints (project_id, fingerprint) VALUES (?, ?)
      ON CONFLICT(project_id) DO UPDATE SET fingerprint = excluded.fingerprint`).run(projectId, fingerprint);
    return result;
  })();
}

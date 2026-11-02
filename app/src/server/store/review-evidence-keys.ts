import type Database from 'better-sqlite3';

type Row = { id: string; data_json: string };
type Snapshot = { source: string; locator: string; quote: string };
const record = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};

// Capture still available snapshots before older graph rows are pruned. The
// completion record is committed with the keys; a failed migration can retry.
export function backfillReviewEvidenceKeys(db: Database.Database, projectId?: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS ontology_review_evidence_backfills (
    project_id TEXT NOT NULL, import_id TEXT NOT NULL,
    PRIMARY KEY (project_id, import_id)
  );
  CREATE TRIGGER IF NOT EXISTS trg_ontology_review_evidence_backfills_no_update
    BEFORE UPDATE ON ontology_review_evidence_backfills BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
  CREATE TRIGGER IF NOT EXISTS trg_ontology_review_evidence_backfills_no_delete
    BEFORE DELETE ON ontology_review_evidence_backfills BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;`);
  // Legacy databases can contain a node whose project and import each exist,
  // but belong to different projects: the foreign keys allow that. Iterate
  // project/import pairs so those nodes retain the old backfill behavior too.
  const imports = db.prepare(`SELECT p.id AS project_id, i.id AS import_id FROM projects p CROSS JOIN ontology_imports i
    WHERE ${projectId ? 'p.id = ?' : `NOT EXISTS (SELECT 1 FROM ontology_review_evidence_backfills b WHERE b.project_id = p.id AND b.import_id = i.id)`}
    AND EXISTS (SELECT 1 FROM ontology_nodes n WHERE n.project_id = p.id AND n.import_id = i.id LIMIT 1)`);
  const nodes = db.prepare('SELECT id, data_json FROM ontology_nodes WHERE project_id=? AND import_id=?');
  const snippets = db.prepare('SELECT id, data_json FROM ontology_snippets WHERE project_id=? AND import_id=?');
  const sources = db.prepare('SELECT id, data_json FROM ontology_sources WHERE project_id=? AND import_id=?');
  const insert = db.prepare('INSERT OR IGNORE INTO ontology_review_evidence_keys VALUES (?, ?, ?, ?, ?, ?)');
  const mark = db.prepare('INSERT OR IGNORE INTO ontology_review_evidence_backfills VALUES (?, ?)');
  db.transaction(() => {
    const pending = imports.all(...(projectId ? [projectId] : [])) as Array<{project_id: string; import_id: string}>;
    for (const {project_id: project, import_id: imp} of pending) {
      const sourceRows = new Map((sources.all(project, imp) as Row[]).map(row => [row.id, row.data_json]));
      const sourceCache = new Map<string, Record<string, unknown>>();
      const snippetById = new Map<string, Snapshot>();
      const byNode = new Map<string, Set<Snapshot>>();
      const index = (ids: unknown, snapshot: Snapshot) => {
        if (!Array.isArray(ids)) return;
        for (const id of ids) {
          if (typeof id !== 'string') continue;
          const matches = byNode.get(id) ?? new Set<Snapshot>();
          matches.add(snapshot);
          byNode.set(id, matches);
        }
      };
      for (const row of snippets.all(project, imp) as Row[]) {
        const snippet = record(JSON.parse(row.data_json));
        const source = typeof snippet.source === 'string' ? snippet.source : '';
        const rawSource = sourceRows.get(source);
        let sourceData = sourceCache.get(source);
        if (rawSource !== undefined && !sourceData) {
          sourceData = record(JSON.parse(rawSource));
          sourceCache.set(source, sourceData);
        }
        const meta = record(record(sourceData?.evidence_metadata)[row.id]);
        if (!source || typeof snippet.locator !== 'string' || !snippet.locator || typeof snippet.quote !== 'string' || !snippet.quote) continue;
        const snapshot = {source, locator: snippet.locator, quote: snippet.quote};
        snippetById.set(row.id, snapshot);
        index(snippet.proves, snapshot);
        index(snippet.supports, snapshot);
        index(meta.proves, snapshot);
        index(meta.supports, snapshot);
      }
      for (const node of nodes.all(project, imp) as Row[]) {
        const data = record(JSON.parse(node.data_json));
        const matches = new Set(byNode.get(node.id));
        if (Array.isArray(data.evidence)) {
          for (const snippetId of data.evidence) {
            const snapshot = snippetById.get(snippetId);
            if (snapshot) matches.add(snapshot);
          }
        }
        for (const snapshot of matches) insert.run(project, imp, node.id, snapshot.source, snapshot.locator, snapshot.quote);
      }
      mark.run(project, imp);
    }
  })();
}

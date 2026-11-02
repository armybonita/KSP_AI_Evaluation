import type Database from 'better-sqlite3';
import { nodeHash, stableNodeId } from '../ontology/node-id';

// Only retained snapshots can identify an old generated ID safely. Never guess a
// title for snapshots already removed by a previous version.
export function backfillReviewNodeAliases(db: Database.Database, projectId?: string): void {
  const rows = db.prepare(`SELECT project_id, import_id, id, node_type, title FROM ontology_nodes ${projectId ? 'WHERE project_id = ?' : ''}`).all(...(projectId ? [projectId] : [])) as Array<{project_id:string; import_id:string; id:string; node_type:string; title:string}>;
  const alias = db.prepare('INSERT OR IGNORE INTO ontology_review_node_aliases VALUES (?, ?, ?, ?)');
  const title = db.prepare('INSERT OR IGNORE INTO ontology_review_node_titles VALUES (?, ?, ?, ?)');
  for (const row of rows) {
    title.run(row.project_id, row.import_id, row.id, row.title);
    const code = `P${nodeHash(row.project_id, 6)}`;
    const legacy = new RegExp(`^(?:PRJ|CNY|IMP|POL|ORG|ACT|OPT|IND|OUT-S|OUT-M|FAC-E|FAC-C)-${code}-[A-Z0-9]+-\\d{2,}$`).test(row.id);
    const hash = /-H[0-9A-F]{16}(?:-[0-9A-F]{10})?$/.test(row.id);
    if (!legacy && !hash) continue;
    try { alias.run(row.project_id, row.import_id, row.id, stableNodeId(code, row.node_type, row.title)); } catch { /* unknown historical types are retained without guessing */ }
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { closeDatabase, openDatabase } from './db';
import { CREATE_TABLES_SQL } from './schema';
import { getProjectOntologyGraph } from './ontology';
import { getNoteReviewData } from './note-review';

it('adds review protections to an existing database without deleting records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieas-review-migration-'));
  const file = path.join(dir, 'fixture.sqlite');
  try {
    const old = new Database(file);
    old.exec(CREATE_TABLES_SQL);
    old.exec(`INSERT INTO projects (id, name, created_at) VALUES ('p', '가상', '2026');
      INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
      VALUES ('i', 'p', 'fake', '2026', 1, 0, 0, 0, 0, 0, '가상');
      INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
      VALUES ('i2', 'p', 'fake', '2027', 1, 0, 0, 0, 0, 0, '가상');
      INSERT INTO ontology_nodes VALUES ('n', 'p', 'i2', 'outcome-mid', '가상', '{}');
      INSERT INTO ontology_nodes VALUES ('s', 'p', 'i2', 'outcome-short', '가상 단기', '{}');
      INSERT INTO ontology_relation_candidates VALUES ('p', 'i', 's', 'n', 'extends_to');
      INSERT INTO ontology_relation_candidates VALUES ('p', 'i2', 's', 'n', 'extends_to');
      INSERT INTO ontology_link_reviews VALUES ('l', 'p', 'i', 's', 'n', '확정', '가상', '2026');
      INSERT INTO ontology_link_reviews VALUES ('lost-link', 'p', 'i', 'lost-source', 'n', '확정', '가상', '2026');
      INSERT INTO ontology_note_reviews VALUES ('r', 'p', 'i', 'n', '확정', '가상', '가상', '미확인', '', '', '가상', '2026');
      INSERT INTO ontology_note_reviews VALUES ('r2', 'p', 'i', 'lost', '확정', '가상', '가상', '미확인', '', '', '가상', '2026');
      DROP TRIGGER trg_prevent_note_reviews_update;
      DROP TRIGGER trg_prevent_note_reviews_delete;
      DROP TRIGGER trg_prevent_link_reviews_update;
      DROP TRIGGER trg_prevent_link_reviews_delete;
      DROP TABLE ontology_review_node_keys;`);
    old.close();
    const migrated = openDatabase(file);
    expect(migrated.prepare('SELECT text FROM ontology_note_reviews WHERE id = ?').get('r')).toEqual({ text: '가상' });
    expect(migrated.prepare('SELECT node_type FROM ontology_review_node_keys WHERE node_id = ? AND import_id = ?').get('n', 'i')).toEqual({ node_type: 'outcome-mid' });
    expect(getNoteReviewData('p', migrated).items.find(i => i.id === 'n')!.history.map(h => h.id)).toEqual(['r']);
    expect(getNoteReviewData('p', migrated).unknownReviewedCount).toBe(1);
    expect(getNoteReviewData('p', migrated).unknownRelationLinks).toHaveLength(2);
    expect(getNoteReviewData('p', migrated).items.find(i => i.id === 'n')!.candidates[0]).toMatchObject({ status: 'AI 후보', unknownRelation: true });
    expect(getProjectOntologyGraph('p', migrated).edges).toEqual([]);
    expect(() => migrated.prepare('DELETE FROM ontology_note_reviews WHERE id = ?').run('r')).toThrow();
  } finally {
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

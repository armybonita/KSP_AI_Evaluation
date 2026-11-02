import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { migrateReviewSnapshots } from './db';
import { CREATE_TABLES_SQL } from './schema';

// 85b1eea's startup statements, kept as an independent result oracle.
function originalMigration(db: Database.Database) {
  db.exec(`INSERT OR IGNORE INTO ontology_review_node_keys (project_id, import_id, node_id, node_type) SELECT project_id, import_id, id, node_type FROM ontology_nodes;
    INSERT OR IGNORE INTO ontology_review_node_keys (project_id, import_id, node_id, node_type)
    SELECT refs.project_id, refs.import_id, refs.node_id,
      COALESCE((SELECT CASE WHEN COUNT(DISTINCT k.node_type) = 1 THEN MIN(k.node_type) END
        FROM ontology_review_node_keys k WHERE k.project_id = refs.project_id
        AND k.node_id = refs.node_id AND k.node_type != '종류 불명'), '종류 불명')
    FROM (SELECT project_id, import_id, node_id FROM ontology_note_reviews
      UNION SELECT project_id, import_id, source_id FROM ontology_link_reviews
      UNION SELECT project_id, import_id, target_id FROM ontology_link_reviews) refs;
    INSERT OR IGNORE INTO ontology_relation_candidates SELECT e.project_id, e.import_id, e.source_id, e.target_id, e.relation_field FROM ontology_edges e JOIN ontology_imports i ON i.id = e.import_id WHERE i.source_kind = 'generated' AND e.relation_field IN ('extends_to', 'targets');`);
}

function fixture() {
  const db = new Database(':memory:');
  db.exec(CREATE_TABLES_SQL);
  db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('p', '가상', '2026'), ('q', '가상 다른 사업', '2026');
    INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor, source_kind)
    VALUES ('old','p','가상','2025',0,0,0,0,0,0,'가상','vault'), ('new','p','가상','2026',0,0,0,0,0,0,'가상','generated'), ('empty','p','가상','2028',0,0,0,0,0,0,'가상','generated');
    INSERT INTO ontology_nodes VALUES ('n','p','new','output','가상','{}'), ('m','p','new','indicator','가상','{}'), ('cross','q','new','output','가상','{}');
    INSERT INTO ontology_edges VALUES ('e','p','new','n','m','targets'), ('other','p','new','n','m','other'), ('crossedge','q','new','cross','m','targets');
    INSERT INTO ontology_note_reviews VALUES ('r','p','old','n','확정','가상','가상','미확인','','','가상','2025'), ('r2','p','old','lost','확정','가상','가상','미확인','','','가상','2025');
    INSERT INTO ontology_link_reviews VALUES ('l','p','old','m','lost','확정','가상','2025');`);
  return db;
}
function snapshot(db: Database.Database) {
  return {
    keys: db.prepare('SELECT * FROM ontology_review_node_keys ORDER BY project_id, import_id, node_id').all(),
    candidates: db.prepare('SELECT * FROM ontology_relation_candidates ORDER BY project_id, import_id, source_id, target_id, relation').all(),
  };
}

it('시작 스냅숏 증분 이관이 기존 전체 이관과 같고 이전 앱의 새 판과 검토도 반영한다', () => {
  const before = fixture(), after = fixture();
  try {
    originalMigration(before);
    migrateReviewSnapshots(after);
    expect(snapshot(after)).toEqual(snapshot(before));
    const receipts = after.prepare('SELECT COUNT(*) AS count FROM ontology_graph_migration_receipts').get();
    const marks = after.prepare('SELECT COUNT(*) AS count FROM ontology_review_migration_watermarks').get();
    migrateReviewSnapshots(after);
    expect(after.prepare('SELECT COUNT(*) AS count FROM ontology_graph_migration_receipts').get()).toEqual(receipts);
    expect(after.prepare('SELECT COUNT(*) AS count FROM ontology_review_migration_watermarks').get()).toEqual(marks);
    for (const db of [before, after]) db.exec(`
      INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor, source_kind)
      VALUES ('later','p','가상','2027',0,0,0,0,0,0,'가상','generated');
      INSERT INTO ontology_nodes VALUES ('x','p','later','enabler','가상','{}'), ('afterempty','p','empty','output','가상','{}');
      INSERT INTO ontology_edges VALUES ('lateredge','p','later','x','m','extends_to');
      INSERT INTO ontology_note_reviews VALUES ('r3','p','old','x','보완 필요','가상','가상','미확인','','','가상','2027');
      INSERT INTO ontology_link_reviews VALUES ('l2','p','old','x','another-lost','확정','가상','2027');`);
    originalMigration(before);
    migrateReviewSnapshots(after);
    expect(snapshot(after)).toEqual(snapshot(before));
    expect(after.prepare("SELECT node_type FROM ontology_review_node_keys WHERE import_id='old' AND node_id='x'").get()).toEqual({node_type: 'enabler'});
    expect(after.prepare("SELECT COUNT(*) AS count FROM ontology_relation_candidates WHERE import_id='later'").get()).toEqual({count: 1});
  } finally {
    before.close();
    after.close();
  }
});

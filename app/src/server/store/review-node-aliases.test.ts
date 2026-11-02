import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CREATE_TABLES_SQL } from './schema';
import { backfillReviewNodeAliases } from './review-node-aliases';
import { nodeHash, stableNodeId } from '../ontology/node-id';

it('retains an old generated key and its title without changing existing rows', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(CREATE_TABLES_SQL);
  const code = `P${nodeHash('p', 6)}`;
  const old = `OUT-M-${code}-D12345-01`;
  db.prepare('INSERT INTO ontology_nodes VALUES (?, ?, ?, ?, ?, ?)').run(old, 'p', 'i', 'outcome-mid', '가상 성과', '{}');
  backfillReviewNodeAliases(db); backfillReviewNodeAliases(db);
  expect(db.prepare('SELECT new_node_id FROM ontology_review_node_aliases WHERE old_node_id = ?').get(old)).toEqual({new_node_id: stableNodeId(code, 'outcome-mid', '가상 성과')});
  expect(db.prepare('SELECT title FROM ontology_review_node_titles WHERE node_id = ?').get(old)).toEqual({title:'가상 성과'});
  for (const table of ['ontology_review_node_aliases', 'ontology_review_node_titles']) {
    expect(() => db.prepare(`UPDATE ${table} SET project_id = 'x'`).run()).toThrow();
    expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow();
  }
  db.close();
});

it('protects imported review keys and relation candidates against update and deletion', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(CREATE_TABLES_SQL);
  db.prepare("INSERT INTO ontology_review_node_keys VALUES ('p','i','n','outcome-mid')").run();
  db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('p','i','n','d','1','가상')").run();
  db.prepare("INSERT INTO ontology_relation_candidates VALUES ('p','i','a','n','targets')").run();
  for (const table of ['ontology_review_node_keys', 'ontology_review_evidence_keys', 'ontology_relation_candidates']) {
    expect(() => db.prepare(`UPDATE ${table} SET project_id = 'x'`).run()).toThrow();
    expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow();
  }
  db.close();
});

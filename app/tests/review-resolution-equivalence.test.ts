import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CREATE_TABLES_SQL } from '../src/server/store/schema';
import { reviewResolver } from '../src/server/store/review-resolution';
import { reviewResolver as legacyResolver } from './fixtures/review-resolution-legacy';

it('검토 판별 색인은 기존 판별의 일치·분리·병합·미확인과 근거 중복을 보존한다', () => {
  const db = new Database(':memory:');
  try {
    db.exec(CREATE_TABLES_SQL);
    db.exec(`INSERT INTO projects (id,name,created_at) VALUES ('p','가상','2026');
      INSERT INTO ontology_imports (id,project_id,vault_code,imported_at,node_count,edge_count,source_count,snippet_count,error_count,warning_count,executor)
        VALUES ('old','p','가상','2025',0,0,0,0,0,0,'test'), ('new','p','가상','2026',0,0,0,0,0,0,'test');
      INSERT INTO ontology_nodes VALUES ('same','p','new','output','가상','{}'), ('new-id','p','new','output','가상','{}'),
        ('split-a','p','new','output','가상','{}'), ('split-b','p','new','output','가상','{}'), ('merged','p','new','output','가상','{}');
      INSERT INTO ontology_review_node_aliases VALUES ('p','old','old-id','new-id'), ('p','old','split','split'),
        ('p','old','merge-a','merged'), ('p','old','merge-b','merged');
      INSERT INTO ontology_review_node_keys VALUES ('p','old','old-id','output'), ('p','old','split','output'),
        ('p','old','merge-a','output'), ('p','old','merge-b','output');
      INSERT INTO ontology_review_evidence_keys VALUES ('p','old','old-id','doc','1','가상 문장'), ('p','old','old-id','doc','2','가상 문장'),
        ('p','new','new-id','doc','1','가상 문장'), ('p','new','new-id','doc','2','가상 문장'),
        ('p','old','merge-a','doc','1','가상 문장'), ('p','new','merged','doc','1','가상 문장');`);
    const before = legacyResolver('p', db), after = reviewResolver('p', db);
    for (const id of ['same', 'old-id', 'split', 'merge-a', 'merge-b', 'missing']) {
      for (const type of ['output', 'indicator', '종류 불명']) {
        for (const imp of ['old', 'new']) {
          expect(after.resolve(imp, id, type)).toEqual(before.resolve(imp, id, type));
          expect(after.resolve(imp, id, type)).toEqual(before.resolve(imp, id, type));
        }
      }
      for (const target of ['same', 'new-id', 'split-a', 'merged'])
        expect(after.overlap('old', id, target)).toBe(before.overlap('old', id, target));
    }
  } finally { db.close(); }
});

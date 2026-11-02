import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CREATE_TABLES_SQL } from './schema';
import { reviewResolver, reviewResolversForProjects } from './review-resolution';

describe('목록 검토 해석 묶음', () => {
  it('분할·병합·불확실·동일 ID의 이력에서 전체 근거 해석과 같은 결과를 낸다', () => {
    const db = new Database(':memory:');
    db.exec(CREATE_TABLES_SQL);
    db.exec(`INSERT INTO projects (id,name,created_at) VALUES ('p','가상 사업','2026');
      INSERT INTO ontology_imports (id,project_id,vault_code,imported_at,node_count,edge_count,source_count,snippet_count,error_count,warning_count,executor)
      VALUES ('old','p','가상','2025',0,0,0,0,0,0,'test'), ('new','p','가상','2026',0,0,0,0,0,0,'test');`);
    const node = db.prepare("INSERT INTO ontology_nodes VALUES (?, 'p', 'new', 'indicator', '가상', '{}')");
    for (const id of ['split-a', 'split-b', 'merged', 'rename', 'same', 'unknown-match', 'unknown-miss']) node.run(id);
    const aliases: Array<[string, string]> = [['split', 'split'], ['m1', 'merged'], ['m2', 'merged'], ['old-name', 'rename'], ['same', 'same']];
    const alias = db.prepare("INSERT INTO ontology_review_node_aliases VALUES ('p', 'old', ?, ?)");
    for (const [oldId, newId] of aliases) alias.run(oldId, newId);
    const cases: Array<[string, string]> = [['split','indicator'], ['m1','indicator'], ['m2','indicator'], ['old-name','indicator'], ['same','indicator'], ['unknown-match','종류 불명'], ['unknown-miss','종류 불명']];
    const key = db.prepare("INSERT INTO ontology_review_node_keys VALUES ('p','old',?,?)");
    const review = db.prepare("INSERT INTO ontology_note_reviews VALUES (?, 'p','old',?,'확정','판단','판단','미확인','','','담당','2026')");
    for (const [id, type] of cases) { key.run(id, type); review.run(`review-${id}`, id); }
    const evidence = db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('p', ?, ?, ?, '위치', ?)");
    for (const [importId, id] of [['old','m1'],['old','m2'],['new','merged'],['old','old-name'],['new','rename'],['old','same'],['new','same'],['old','unknown-match'],['new','unknown-match']]) {
      evidence.run(importId, id, '공통 문서', '가상 근거 문장');
    }
    evidence.run('old', 'unknown-miss', '첫 문서', '이전 근거');
    evidence.run('new', 'unknown-miss', '다른 문서', '다른 근거');
    const full = reviewResolver('p', db);
    const batch = reviewResolversForProjects(db).get('p')!.resolver;
    for (const [id, type] of cases) expect(batch.resolve('old', id, type)).toMatchObject(full.resolve('old', id, type));
    expect(batch.resolve('old', 'split', 'indicator')).toMatchObject({split: true, uncertain: false});
    expect(batch.resolve('old', 'm1', 'indicator')).toMatchObject({split: true, mergeCount: 2});
    expect(batch.resolve('old', 'old-name', 'indicator')).toMatchObject({id: 'rename', split: false});
    expect(batch.resolve('old', 'same', 'indicator')).toMatchObject({id: 'same', split: false});
    expect(batch.resolve('old', 'unknown-match', '종류 불명')).toMatchObject({id: 'unknown-match', type: 'indicator', uncertain: false});
    expect(batch.resolve('old', 'unknown-miss', '종류 불명')).toMatchObject({id: 'unknown-miss', type: '종류 불명', uncertain: true});
    db.close();
  });
});

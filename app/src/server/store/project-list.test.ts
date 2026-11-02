import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import * as reviewResolution from './review-resolution';
import { listProjectsWithCount, migrateProjectMetadata } from './db';
import { CREATE_TABLES_SQL } from './schema';
import { getNoteReviewData } from './note-review';

describe('사업 목록 저장소 집계', () => {
  it('기존 프로젝트 행을 보존하면서 사업 메타 컬럼을 추가한다', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO projects VALUES ('legacy', '가상 이전 사업', '2025-01-01');`);
    migrateProjectMetadata(db);
    expect(db.prepare('SELECT id, name, country, is_ended FROM projects').get()).toEqual({
      id: 'legacy', name: '가상 이전 사업', country: null, is_ended: null,
    });
    db.close();
  });

  it('PDM·PCP 포함 자료와 최신 제안에 연결된 최신 확정만 카드 집계에 반영한다', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    db.exec(`INSERT INTO projects (id, name, created_at, project_year, country, region, is_ended)
      VALUES ('p', '가상 평가 사업', '2026-01-01', 2026, '가상국', '가상지역', 1);
      INSERT INTO documents (id, project_id, file_name, file_type, status, doc_type, is_included, created_at)
      VALUES ('pdm', 'p', 'plan.xlsx', 'xlsx', '추출 완료', '성과관리표', 1, '2026-01-01'),
        ('pcp', 'p', 'pcp.docx', 'docx', '추출 완료', '국문 PCP', 1, '2026-01-02');
      UPDATE documents SET is_past_final_report = 0 WHERE project_id = 'p';
      INSERT INTO indicators (id, project_id, level, name, ovi, created_at)
      VALUES ('i1', 'p', '단기성과', '가상 지표1', '수치', '2026-01-01'), ('i2', 'p', '산출물', '가상 지표2', '수치', '2026-01-01');
      INSERT INTO suggestions (id, indicator_id, verdict_status, proposal_text, created_at)
      VALUES ('s1', 'i1', '미확인', '이전 제안', '2026-01-01'), ('s2', 'i1', '실현', '최신 제안', '2026-01-02'),
        ('s3', 'i2', '미확인', '가상 제안2', '2026-01-01');
      INSERT INTO confirmations (id, indicator_id, suggestion_id, confirmation_type, confirmer_name, created_at)
      VALUES ('c1', 'i1', 's1', '보완 필요', '이전 평가자', '2026-01-01'), ('c2', 'i1', 's2', '확정', '평가자 1', '2026-01-02'),
        ('c3', 'i2', 's3', '보완 필요', '평가자 2', '2026-01-03');`);

    const project = listProjectsWithCount(db)[0];
    expect(project).toMatchObject({
      project_year: 2026, country: '가상국', region: '가상지역', is_ended: 1,
      has_pdm: 1, has_pcp: 1, review_total: 2, reviewed_count: 2, needs_revision_count: 1, evaluator_name: '평가자 2',
      pdm_document: { id: 'pdm', file_name: 'plan.xlsx', doc_type: '성과관리표', created_at: '2026-01-01' },
      pcp_document: { id: 'pcp', file_name: 'pcp.docx', doc_type: '국문 PCP', created_at: '2026-01-02' },
    });
    db.prepare("UPDATE documents SET status = '읽지 못함' WHERE id = 'pdm'").run();
    const updated = listProjectsWithCount(db)[0];
    expect(updated.has_pdm).toBe(0);
    expect(updated.pdm_document).toBeNull();
    db.prepare("UPDATE documents SET doc_type = '사업계획서' WHERE id = 'pcp'").run();
    const updated2 = listProjectsWithCount(db)[0];
    expect(updated2.has_pcp).toBe(0);
    expect(updated2.pcp_document).toBeNull();
    db.close();
  });

  it('각 사업의 자료 종류별 최신 포함 판을 동률과 상태 조건에 따라 찾는다', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('a', '사업 가', '2026'), ('b', '사업 나', '2026');
      INSERT INTO documents (id, project_id, file_name, file_type, status, doc_type, is_included, created_at) VALUES
        ('old', 'a', '이전', 'txt', '추출 완료', '성과관리표', 1, '2025'),
        ('z-pdm', 'a', '선택 판', 'txt', '추출 완료', '성과관리표', 1, '2026'),
        ('a-pdm', 'a', '나중 삽입', 'txt', '추출 완료', '성과관리표', 1, '2026'),
        ('ineligible', 'a', '미완료', 'txt', '추출 중', '성과관리표', 1, '2027'),
        ('excluded', 'a', '제외', 'txt', '추출 완료', '성과관리표', 0, '2028'),
        ('z-pcp', 'a', '선택 국문', 'txt', '추출 완료', '국문 PCP', 1, '2026'),
        ('a-pcp', 'a', '나중 삽입 국문', 'txt', '추출 완료', '국문 PCP', 1, '2026'),
        ('pcp-failed', 'a', '읽지 못한 국문', 'txt', '읽지 못함', '국문 PCP', 1, '2027'),
        ('pcp-excluded', 'a', '제외 국문', 'txt', '추출 완료', '국문 PCP', 0, '2028'),
        ('other', 'b', '다른 사업', 'txt', '추출 완료', '성과관리표', 1, '2027');
      UPDATE documents SET is_past_final_report = 0 WHERE project_id IN ('a', 'b');`);
    const projects = listProjectsWithCount(db);
    expect(projects.find((p) => p.id === 'a')).toMatchObject({has_pdm: 1, has_pcp: 1, pdm_document: {id: 'a-pdm'}, pcp_document: {id: 'a-pcp'}});
    expect(projects.find((p) => p.id === 'b')).toMatchObject({has_pdm: 1, has_pcp: 0, pdm_document: {id: 'other'}, pcp_document: null});
    db.prepare("UPDATE documents SET status = '읽지 못함' WHERE project_id = 'a' AND doc_type = '국문 PCP'").run();
    expect(listProjectsWithCount(db).find((p) => p.id === 'a')).toMatchObject({has_pcp: 0, pcp_document: null});
    db.prepare("UPDATE documents SET status = '읽지 못함' WHERE project_id = 'a' AND doc_type = '성과관리표'").run();
    expect(listProjectsWithCount(db).find((p) => p.id === 'a')).toMatchObject({has_pdm: 0, pdm_document: null});
    db.close();
  });

  it('동시각 제안과 확정은 삽입순으로 고르고 평가자는 모든 확정 중 최신을 따른다', () => {
    const db = new Database(':memory:');
    db.exec(CREATE_TABLES_SQL);
    db.exec(`INSERT INTO projects (id,name,created_at) VALUES ('p','가상 사업','2026');
      INSERT INTO indicators (id,project_id,level,name,ovi,created_at) VALUES
        ('i','p','산출물','지표','계획','2026'), ('j','p','산출물','다른 지표','계획','2026');
      INSERT INTO suggestions (id,indicator_id,verdict_status,proposal_text,created_at) VALUES
        ('z','i','미확인','이전','2026'), ('a','i','실현','나중','2026'), ('other','j','미확인','제안','2026');
      INSERT INTO confirmations (id,indicator_id,suggestion_id,confirmation_type,confirmer_name,created_at) VALUES
        ('z','i','a','확정','이전 담당','2026'), ('a','i','a','보완 필요','나중 담당','2026'),
        ('older-suggestion','i','z','확정','전체 최신 담당','2027');`);
    expect(listProjectsWithCount(db)[0]).toMatchObject({review_total: 2, reviewed_count: 1, needs_revision_count: 1, evaluator_name: '전체 최신 담당'});
    db.close();
  });

  it('해석기가 없는 사업만 노트 검토 해석을 생략하고 다른 사업의 집계는 유지한다', () => {
    const db = new Database(':memory:');
    db.exec(CREATE_TABLES_SQL);
    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('a','사업 가','2026'), ('b','사업 나','2026');
      INSERT INTO ontology_imports (id,project_id,vault_code,imported_at,node_count,edge_count,source_count,snippet_count,error_count,warning_count,executor)
      VALUES ('ia','a','가상','2026',1,0,0,0,0,0,'test'), ('ib','b','가상','2026',1,0,0,0,0,0,'test');
      INSERT INTO ontology_nodes VALUES ('n','a','ia','indicator','지표','{}'), ('n','b','ib','indicator','지표','{}');
      INSERT INTO ontology_review_node_keys VALUES ('a','ia','n','indicator'), ('b','ib','n','indicator');
      INSERT INTO ontology_note_reviews VALUES ('ra','a','ia','n','보완 필요','판단','판단','미확인','','','담당','2026'),
        ('rb','b','ib','n','보완 필요','판단','판단','미확인','','','담당','2026');`);
    const actual = reviewResolution.reviewResolversForProjects(db);
    actual.delete('a');
    const spy = vi.spyOn(reviewResolution, 'reviewResolversForProjects').mockReturnValue(actual);
    try {
      const projects = listProjectsWithCount(db);
      expect(projects.find((project) => project.id === 'a')).toMatchObject({review_total: 1, reviewed_count: 0, needs_revision_count: 0});
      expect(projects.find((project) => project.id === 'b')).toMatchObject({review_total: 1, reviewed_count: 1, needs_revision_count: 1});
    } finally {
      spy.mockRestore();
      db.close();
    }
  });

  it('최신 노트 검토와 지표 확정의 보완 필요 건수를 함께 센다', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('p', '가상 사업', '2026-01-01');
      INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
      VALUES ('import', 'p', 'VA01', '2026-01-02', 2, 0, 0, 0, 0, 0, 'test');
      INSERT INTO ontology_nodes VALUES ('n1','p','import','output','가상 산출','{}'), ('n2','p','import','indicator','가상 지표','{}');
      INSERT INTO ontology_review_node_keys VALUES ('p','import','n1','output'), ('p','import','n2','indicator');
      INSERT INTO ontology_note_reviews VALUES ('r1','p','import','n1','확정','판단','판단','미확인','','','평가자','2026-01-01'), ('r2','p','import','n1','보완 필요','판단','판단','미확인','','','평가자','2026-01-02');
      INSERT INTO indicators (id, project_id, level, name, ovi, created_at) VALUES ('i','p','산출물','가상','수치','2026-01-01');
      INSERT INTO suggestions (id, indicator_id, verdict_status, proposal_text, created_at) VALUES ('s','i','미확인','제안','2026-01-01');
      INSERT INTO confirmations (id, indicator_id, suggestion_id, confirmation_type, confirmer_name, created_at) VALUES ('c','i','s','보완 필요','평가자','2026-01-01');`);
    expect(listProjectsWithCount(db)[0]).toMatchObject({ needs_revision_count: 2, review_total: 3, reviewed_count: 2 });
    db.close();
  });
  it('사업 목록 집계는 전체 노트 구성의 최신 이력과 일치한다', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    db.exec(`
      INSERT INTO projects (id, name, created_at) VALUES ('p', '가상 사업', '2026'), ('empty', '빈 사업', '2025');
      INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
      VALUES ('old', 'p', '가상', '2025', 0, 0, 0, 0, 0, 0, 'test'), ('new', 'p', '가상', '2026', 0, 0, 0, 0, 0, 0, 'test');
      INSERT INTO ontology_nodes VALUES
        ('same','p','new','output','산출','{}'), ('newname','p','new','indicator','지표','{}'),
        ('split-a','p','new','outcome-mid','성과','{}'), ('split-b','p','new','outcome-mid','성과','{}'),
        ('unreviewed','p','new','constraint','제약','{}'), ('ignored','p','new','project','사업','{}');
      INSERT INTO ontology_review_node_keys VALUES
        ('p','old','same','output'), ('p','old','oldname','indicator'), ('p','old','split','outcome-mid'),
        ('p','new','same','output'), ('p','new','newname','indicator');
      INSERT INTO ontology_review_node_aliases VALUES ('p','old','oldname','newname'), ('p','old','split','split');
      INSERT INTO ontology_review_evidence_keys VALUES
        ('p','old','oldname','doc','1','가상 근거'), ('p','new','newname','doc','1','가상 근거');
      INSERT INTO ontology_note_reviews VALUES
        ('r1','p','old','same','보완 필요','판단','판단','미확인','','','담당','2026'),
        ('r2','p','new','same','확정','판단','판단','미확인','','','담당','2025'),
        ('r3','p','old','oldname','보완 필요','판단','판단','미확인','','','담당','2026'),
        ('r4','p','old','split','보완 필요','판단','판단','미확인','','','담당','2026');
      INSERT INTO indicators (id, project_id, level, name, ovi, created_at) VALUES ('i','p','산출물','가상','수치','2026');
      INSERT INTO suggestions (id, indicator_id, verdict_status, proposal_text, created_at) VALUES ('sold','i','미확인','이전 제안','2026'), ('s','i','미확인','제안','2026');
      INSERT INTO confirmations (id, indicator_id, suggestion_id, confirmation_type, confirmer_name, created_at) VALUES ('cold','i','s','확정','이전 담당','2026'), ('c','i','s','보완 필요','담당','2026');
    `);
    const result = listProjectsWithCount(db);
    for (const project of result) {
      const notes = getNoteReviewData(project.id, db).items;
      const history = notes.map((note) => note.history.at(-1));
      const indicatorTotal = project.id === 'p' ? 1 : 0;
      expect(project).toMatchObject({
        review_total: notes.length + indicatorTotal,
        reviewed_count: history.filter(Boolean).length + indicatorTotal,
        needs_revision_count: history.filter((review) => review?.status === '보완 필요').length + indicatorTotal,
        evaluator_name: project.id === 'p' ? '담당' : null,
        has_pdm: 0, has_pcp: 0,
      });
    }
    db.close();
  });

});

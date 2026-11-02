import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, listProjectsWithCount, openDatabase } from './db';
import { isProjectPdmRegistered } from '../project-pdm';

afterEach(() => closeDatabase());

describe('PDM 사전 등록 gate', () => {
  it('성과관리표가 포함 상태일 때만 등록된 것으로 본다', () => {
    const db = openDatabase(':memory:');
    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('p', '가상 사업', '2026-01-01');
      INSERT INTO documents (id, project_id, file_name, file_type, status, doc_type, is_included, created_at)
      VALUES ('pdm', 'p', 'plan.xlsx', 'xlsx', '추출 완료', '성과관리표', 0, '2026-01-01');`);
    expect(isProjectPdmRegistered('p')).toBe(false);
    db.prepare('UPDATE documents SET is_included = 1 WHERE id = ?').run('pdm');
    expect(isProjectPdmRegistered('p')).toBe(false);
    db.prepare('UPDATE documents SET is_past_final_report = 0 WHERE id = ?').run('pdm');
    expect(isProjectPdmRegistered('p')).toBe(true);
    db.prepare("UPDATE documents SET status = '읽지 못함' WHERE id = ?").run('pdm');
    expect(isProjectPdmRegistered('p')).toBe(false);
  });

  it('사업 카드에서 과거 PDM과 PCP를 건너뛰고 다음 최신 정상 자료를 고른다', () => {
    const db = openDatabase(':memory:');
    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('p', '가상 사업', '2026-01-01');
      INSERT INTO documents (id, project_id, file_name, file_type, status, doc_type, is_included, is_past_final_report, created_at) VALUES
      ('pdm-current', 'p', 'pdm.docx', 'docx', '추출 완료', '성과관리표', 1, 0, '2026-01-01'),
      ('pdm-past', 'p', 'past-pdm.docx', 'docx', '추출 완료', '성과관리표', 1, 1, '2026-01-02'),
      ('pcp-current', 'p', 'pcp.docx', 'docx', '추출 완료', '국문 PCP', 1, 0, '2026-01-01'),
      ('pcp-past', 'p', 'past-pcp.docx', 'docx', '추출 완료', '국문 PCP', 1, 1, '2026-01-02');`);
    const card = listProjectsWithCount(db)[0];
    expect(card.pdm_document?.id).toBe('pdm-current');
    expect(card.pcp_document?.id).toBe('pcp-current');
    db.prepare('UPDATE documents SET is_past_final_report = 1 WHERE id = ?').run('pdm-current');
    expect(isProjectPdmRegistered('p')).toBe(false);
    expect(listProjectsWithCount(db)[0].pdm_document).toBeNull();
  });

});

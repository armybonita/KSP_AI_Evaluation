import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, createDocument, createProject, openDatabase } from './index';
import { exclusionReasonForDocument } from '../documents/exclusion-reason';
import { projectPdmExclusionReason } from '../project-pdm';

describe('PDM exclusion reason', () => {
  afterEach(() => closeDatabase());

  it('retains the missing, unconfirmed, and past-report explanations', () => {
    const db = openDatabase(':memory:');
    createProject({ id: 'p', name: '가상 사업', created_at: '2026-01-01' }, db);
    expect(exclusionReasonForDocument({ kind: 'pdm' })).toContain('성과관리표가 없습니다');
    expect(exclusionReasonForDocument({ kind: 'pdm', document: { file_name: '가상.docx', is_past_final_report: null } })).toContain('과거 보고서 여부가 미확인');
    expect(exclusionReasonForDocument({ kind: 'pdm', document: { file_name: '가상.docx', is_past_final_report: true } })).toContain('과거 종료평가보고서로 표시되어');
  });

  it('masks a PDM filename using a forbidden sentence from another eligible document', () => {
    const db = openDatabase(':memory:');
    createProject({ id: 'p', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument({ id: 'pdm', project_id: 'p', file_name: '공통 금지 이름.xlsx', file_type: 'xlsx', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: null, created_at: '2026-01-01' }, db);
    createDocument({ id: 'current', project_id: 'p', file_name: '현재 문서.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-02' }, db);
    db.prepare('INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES (?, ?, 1, ?, ?)').run('para', 'current', '1쪽', '공통 금지 이름');
    db.prepare('INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned) VALUES (?, ?, ?, 1, ?, ?, 1)').run('banned', 'current', 'para', '1쪽', '공통 금지 이름');
    expect(projectPdmExclusionReason('p')).toContain('과거 보고서 여부가 미확인');
    expect(projectPdmExclusionReason('p')).not.toContain('공통 금지 이름.xlsx');
    expect(projectPdmExclusionReason('p')).toContain('[인용 금지 문장]');
  });
});

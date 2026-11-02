import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { closeDatabase, createDocument, createProject, getDocument, getTocData, insertParagraphs, openDatabase, updateDocumentAiMetadata } from '../store';
import { createReportDraft, isDraftValid } from '../report/service';
import { getOrSyncTocForProject } from '../toc';
import { updateDocumentAiMetadataAction } from '../../app/projects/[projectId]/documents/actions';

vi.mock('../project-visibility', () => ({ assertProjectVisibleToCurrentViewer: vi.fn() }));
const viewer = vi.hoisted(() => ({ guest: false }));
vi.mock('../viewer', () => ({ currentViewer: vi.fn(async () => viewer.guest ? { kind: 'guest' } : { kind: 'member', role: '평가팀' }), viewerCan: () => !viewer.guest, isGuestViewer: () => viewer.guest, GUEST_WRITE_BLOCKED_MESSAGE: '손님은 저장할 수 없습니다.' }));

describe('기존 문서 AI 입력 정보 확인', () => {
  beforeEach(() => {
    openDatabase(':memory:');
    createProject({ id: 'a', name: '가상 사업', created_at: '2026-01-01' });
    createProject({ id: 'b', name: '다른 가상 사업', created_at: '2026-01-01' });
    createDocument({ id: 'doc', project_id: 'a', file_name: '가상.docx', file_type: 'docx', status: '추출 완료', doc_type: '종료평가보고서', is_included: 1, excluded_reason: null, masked: null, approved_ai: 'solar', is_past_final_report: null, created_at: '2026-01-01' });
    viewer.guest = false;
  });
  afterEach(() => closeDatabase());

  it('미선택은 값을 유지하고 이번 사업을 명시해야 최종보고서의 미확인을 푼다', async () => {
    const unknown = { masked: 'unknown', approved_ai: 'unknown', is_past_final_report: 'unknown' };
    expect((await updateDocumentAiMetadataAction('a', 'doc', unknown)).success).toBe(true);
    expect(getDocument('doc')).toMatchObject({ masked: null, approved_ai: 'solar', is_past_final_report: null });
    expect((await updateDocumentAiMetadataAction('a', 'doc', { ...unknown, masked: 'true', approved_ai: 'none' })).success).toBe(true);
    expect(getDocument('doc')).toMatchObject({ masked: true, approved_ai: 'none', is_past_final_report: null });
    expect((await updateDocumentAiMetadataAction('a', 'doc', { ...unknown, is_past_final_report: 'false', approved_ai: 'solar' })).success).toBe(true);
    expect(getDocument('doc')).toMatchObject({ masked: true, approved_ai: 'solar', is_past_final_report: false });
    expect((await updateDocumentAiMetadataAction('a', 'doc', { ...unknown, is_past_final_report: 'true', masked: 'false' })).success).toBe(true);
    expect(getDocument('doc')).toMatchObject({ masked: false, is_past_final_report: true });
  });

  it('사업 소속과 입력 및 손님 쓰기 권한을 확인하고 잘못된 요청은 저장하지 않는다', async () => {
    const input = { masked: 'true', approved_ai: 'solar', is_past_final_report: 'false' };
    expect((await updateDocumentAiMetadataAction('b', 'doc', input)).success).toBe(false);
    expect((await updateDocumentAiMetadataAction('a', 'doc', { ...input, masked: 'invalid' })).success).toBe(false);
    expect((await updateDocumentAiMetadataAction('a', 'doc', { ...input, is_past_final_report: 'invalid' })).success).toBe(false);
    expect((await updateDocumentAiMetadataAction('a', 'doc', { ...input, approved_ai: ' ' })).success).toBe(false);
    expect((await updateDocumentAiMetadataAction('a', 'doc', { ...input, approved_ai: 'xyz' })).success).toBe(false);
    expect(getDocument('doc')).toMatchObject({ approved_ai: 'solar' });
    viewer.guest = true;
    expect((await updateDocumentAiMetadataAction('a', 'doc', input)).success).toBe(false);
    expect(getDocument('doc')).toMatchObject({ masked: null, approved_ai: 'solar', is_past_final_report: null });
  });

  it('자격을 변경하면 해당 문서에 연결된 지표가 없어도 기존 초안이 오래된다', async () => {
    for (const input of [
      { masked: 'false', approved_ai: 'unknown', is_past_final_report: 'unknown' },
      { masked: 'unknown', approved_ai: 'none', is_past_final_report: 'unknown' },
      { masked: 'unknown', approved_ai: 'unknown', is_past_final_report: 'false' },
    ]) {
      const draft = await createReportDraft('a');
      expect(isDraftValid(draft, 'a')).toBe(true);
      expect((await updateDocumentAiMetadataAction('a', 'doc', input)).success).toBe(true);
      expect(isDraftValid(draft, 'a')).toBe(false);
    }
  });

  it('이전 지문 방식으로 만든 같은 판의 초안도 오래된 초안으로 판정한다', async () => {
    const draft = await createReportDraft('a');
    const oldFingerprint = createHash('sha256').update(`report-fingerprint-v${draft.fingerprint_version}|`).digest('hex');
    expect(isDraftValid({ ...draft, fingerprint: oldFingerprint, judgment_fingerprint: oldFingerprint }, 'a')).toBe(false);
  });

  it('과거 여부 변경은 저장된 ToC를 다시 선택하고 지문도 변경을 감지한다', async () => {
    for (const [id, date] of [['first', '2026-01-02'], ['second', '2026-01-03']]) {
      createDocument({ id, project_id: 'a', file_name: `${id}.docx`, file_type: 'docx', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: date });
      const cells = [['단계', '지표명', '성과지표'], ['산출물', `${id} 지표`, '가상 성과']];
      insertParagraphs(cells.flatMap((row, rowIndex) => row.map((content, colIndex) => ({
        id: `${id}-${rowIndex}-${colIndex}`, document_id: id, sequence_no: rowIndex * 3 + colIndex + 1,
        location: `${rowIndex + 1}-${colIndex + 1}`, content, table_index: 1, table_cols: 3,
        table_row: rowIndex + 1, table_col: colIndex + 1,
      }))));
    }
    expect(getOrSyncTocForProject('a')?.items[0]?.indicator.source_doc_id).toBe('first');
    expect((await updateDocumentAiMetadataAction('a', 'first', {
      masked: 'unknown', approved_ai: 'unknown', is_past_final_report: 'true',
    })).success).toBe(true);
    // getTocData only reads the stored results, proving the action performed the sync.
    expect(getTocData('a')?.items[0]?.indicator.source_doc_id).toBe('second');
    expect(updateDocumentAiMetadata('a', 'second', { is_past_final_report: true })).toBe(true);
    expect(getOrSyncTocForProject('a')?.items).toHaveLength(0);
  });
});

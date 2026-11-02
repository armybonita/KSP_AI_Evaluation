import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CREATE_TABLES_SQL } from '@/server/store/schema';
import {
  closeDatabase,
  createDocument,
  createIndicator,
  createProject,
  getReviewData,
  insertParagraphs,
  insertSentences,
  openDatabase,
  saveSuggestion,
} from '@/server/store/db';
import { getAutoOpenSnippetId } from '@/app/projects/[projectId]/review/review-page-state';
import { confirmVerdictAction, resuggestIndicatorAction, saveAttributionAction } from '@/app/projects/[projectId]/review/actions';

describe('review server safety', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    closeDatabase();
  });

  it('serializes no project banned sentence and gives every evidence an explicit safe status', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    createProject({ id: 'p', name: '가상 사업', created_at: '2026-10-31' }, db);
    createDocument({ id: 'd', project_id: 'p', file_name: '가상 문서.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-10-31' }, db);
    createIndicator({ id: 'i', project_id: 'p', name: '가상 지표', level: '활동', ovi: '가상 지표', mov: null, target_value: null, source_doc_id: 'd', is_baseline: 0, created_at: '2026-10-31' }, db);
    insertParagraphs([{ id: 'para', document_id: 'd', sequence_no: 1, location: '¶1', content: '사업에서만 금지하는 가상 원문 문장입니다.' }], db);
    insertSentences([{ id: 'ban', document_id: 'd', paragraph_id: 'para', sequence_no: 1, location: '¶1', content: '사업에서만 금지하는 가상 원문 문장입니다.', is_citation_banned: 1 }], db);
    saveSuggestion({ id: 's', indicator_id: 'i', verdict_status: '실현', error_reason: null, proposal_text: '사업에서만 금지하는 가상 원문 문장입니다.', created_at: '2026-10-31' }, [
      { id: 'ev-banned', suggestion_id: 's', document_id: 'd', location: '¶1', quote: '사업에서만 금지하는 가상 원문 문장입니다.', speaker: '수행기관' },
      { id: 'ev-safe', suggestion_id: 's', document_id: 'd', location: '¶1', quote: '무관한 가상 근거입니다.', speaker: '협력국' },
    ], db);

    const data = getReviewData('p', db)!;
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('사업에서만 금지하는 가상 원문 문장입니다.');
    expect(data.indicators[0]?.suggestion?.evidences.map((e) => e.is_citation_banned)).toEqual([1, 0]);
  });

  it('opens only a verified safe source and fails closed for unknown or banned evidence', () => {
    const data = {
      project: { id: 'p', name: '가상', created_at: '2026-10-31' },
      indicators: [{
        indicator: { id: 'i' },
        suggestion: { evidences: [
          { id: 'safe', is_citation_banned: 0 },
          { id: 'banned', is_citation_banned: 1 },
          { id: 'unknown' },
        ] },
      }],
      unreadableDocuments: [],
    } as never;
    expect(getAutoOpenSnippetId('?indicatorId=i&open=source&snippet=safe', data, 'i')).toBe('safe');
    expect(getAutoOpenSnippetId('?indicatorId=i&open=source&snippet=banned', data, 'i')).toBeNull();
    expect(getAutoOpenSnippetId('?indicatorId=i&open=source&snippet=unknown', data, 'i')).toBeNull();
    expect(getAutoOpenSnippetId('?indicatorId=i&open=source&snippet=safe', data, undefined)).toBeNull();
  });

  it('keeps banned text out of every review action response', async () => {
    db = openDatabase(':memory:');
    createProject({ id: 'p', name: '가상 사업', created_at: '2026-10-31' }, db);
    createDocument({ id: 'd', project_id: 'p', file_name: '가상 문서.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-10-31' }, db);
    createIndicator({ id: 'i', project_id: 'p', name: '가상 지표', level: '활동', ovi: '가상 지표', mov: null, target_value: null, source_doc_id: 'd', is_baseline: 0, created_at: '2026-10-31' }, db);
    insertParagraphs([{ id: 'para', document_id: 'd', sequence_no: 1, location: '¶1', content: '사업에서만 금지하는 가상 원문 문장입니다.' }], db);
    insertSentences([{ id: 'ban', document_id: 'd', paragraph_id: 'para', sequence_no: 1, location: '¶1', content: '사업에서만 금지하는 가상 원문 문장입니다.', is_citation_banned: 1 }], db);
    saveSuggestion({ id: 's', indicator_id: 'i', verdict_status: '실현', error_reason: null, proposal_text: '사업에서만 금지하는 가상 원문 문장입니다.', created_at: '2026-10-31' }, [
      { id: 'ev', suggestion_id: 's', document_id: 'd', location: '¶1', quote: '사업에서만 금지하는 가상 원문 문장입니다.', speaker: '수행기관' },
    ], db);

    const responses = await Promise.all([
      confirmVerdictAction({ projectId: 'p', indicatorId: 'i', confirmationType: '확정', confirmerName: '평가자' }),
      saveAttributionAction({ projectId: 'p', indicatorId: 'i', attributionText: '가상 귀속' }),
      resuggestIndicatorAction('p', 'i'),
    ]);
    for (const response of responses) {
      expect(JSON.stringify(response)).not.toContain('사업에서만 금지하는 가상 원문 문장입니다.');
    }
  });
});

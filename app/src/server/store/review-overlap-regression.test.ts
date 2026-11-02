import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generationError: '', saveError: '' }));
vi.mock('@/server/suggest', () => ({
  buildSuggestInput: () => [],
  suggestVerdictForIndicator: async () => ({
    saved: false,
    suggestion: { id: 'generated', indicator_id: 'i', verdict_status: '미확인', proposal_text: `제안 ${mocks.generationError}`, error_reason: mocks.generationError, created_at: '2026-10-31' },
    evidences: [],
  }),
}));
vi.mock('@/server/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/store')>();
  return {
    ...actual,
    saveIndicatorAttribution: (...args: Parameters<typeof actual.saveIndicatorAttribution>) => {
      if (mocks.saveError) throw new Error(mocks.saveError);
      return actual.saveIndicatorAttribution(...args);
    },
  };
});

import {
  closeDatabase, createDocument, createIndicator, createProject, getReviewData, getProjectCitationContext, getReportTargets, insertParagraphs,
  insertSentences, openDatabase, saveSuggestion, getHistoryPageData, getLatestSuggestion, listConfirmations, getParagraphWithSurroundings,
} from '@/server/store/db';
import { maskEvidenceIfCitationBanned } from '@/server/store/citation-ban';
import ReviewPage from '@/app/projects/[projectId]/review/page';
import { confirmVerdictAction, resuggestIndicatorAction, saveAttributionAction } from '@/app/projects/[projectId]/review/actions';

const ban = 'AlphaBravoCharlie Delta Echo';
const otherBan = '다른 사업에서만 가리는 가상 원문입니다';
const editedError = '수정본에 인용 금지 문장과 8자 이상 겹치는 내용이 포함되어 있어 저장할 수 없습니다.';
const reasonError = '사유에 인용 금지 문장과 8자 이상 겹치는 내용이 포함되어 있어 저장할 수 없습니다.';

function setup(fragment: string) {
  const db = openDatabase(':memory:');
  for (const [projectId, docId, sentence] of [['p', 'd', ban], ['other', 'other-doc', otherBan]]) {
    createProject({ id: projectId, name: '가상 사업', created_at: '2026-10-31' }, db);
    createDocument({ id: docId, project_id: projectId, file_name: '가상 문서.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-10-31' }, db);
    insertParagraphs([{ id: `${docId}-para`, document_id: docId, sequence_no: 1, location: '¶1', content: sentence }], db);
    insertSentences([{ id: `${docId}-ban`, document_id: docId, paragraph_id: `${docId}-para`, sequence_no: 1, location: '¶1', content: sentence, is_citation_banned: 1 }], db);
  }
  createDocument({ id: 'pdm', project_id: 'p', file_name: 'plan.xlsx', file_type: 'xlsx', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-10-31' }, db);
  createIndicator({ id: 'i', project_id: 'p', name: '무관한 지표', level: '활동', ovi: otherBan, mov: null, target_value: '정상 목표', source_doc_id: 'd', is_baseline: 0, created_at: '2026-10-31' }, db);
  saveSuggestion({ id: 's', indicator_id: 'i', verdict_status: '실현', error_reason: `오류 ${fragment} 끝`, proposal_text: `제안 ${fragment} 끝`, created_at: '2026-10-31' }, [], db);
  return db;
}

function assertSafe(payload: unknown, fragment: string) {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain(fragment);
  expect(serialized).toContain('[인용 금지 문장]');
  expect(serialized).toContain(otherBan);
  expect(serialized).toContain('정상 목표');
}

describe('review overlap redaction', () => {
  afterEach(() => {
    mocks.generationError = '';
    mocks.saveError = '';
    closeDatabase();
  });

  it.each([
    ['8자 조각', 'BravoCha'],
    ['공백 제거 변형', 'AlphaBravoCharlieDeltaEcho'],
    ['대소문자 변형', 'bravochA'],
  ])('%s: 초기 props와 세 응답의 제안·오류에 남지 않는다', async (_label, fragment) => {
    setup(fragment);
    const page = await ReviewPage({ params: Promise.resolve({ projectId: 'p' }) });
    assertSafe(page.props, fragment);

    const confirmed = await confirmVerdictAction({ projectId: 'p', indicatorId: 'i', confirmationType: '확정', confirmerName: '평가자' });
    expect(confirmed.success).toBe(true);
    assertSafe(confirmed, fragment);
    const saved = await saveAttributionAction({ projectId: 'p', indicatorId: 'i', attributionText: '무관한 귀속' });
    expect(saved.success).toBe(true);
    assertSafe(saved, fragment);
    mocks.generationError = `오류 ${fragment} 끝`;
    const resuggested = await resuggestIndicatorAction('p', 'i');
    expect(resuggested.success).toBe(false);
    expect(resuggested.error).toBeDefined();
    assertSafe(resuggested, fragment);
    expect(JSON.stringify(resuggested.error)).not.toContain(fragment);
  });

  it.each([
    ['8자 조각', 'BravoCha'],
    ['공백 제거 변형', 'AlphaBravoCharlieDeltaEcho'],
    ['대소문자 변형', 'bravochA'],
  ])('재제안 오류에 섞인 %s 가림', async (_label, fragment) => {
    setup('안전한 문장');
    mocks.generationError = `오류 ${fragment} 끝`;
    const response = await resuggestIndicatorAction('p', 'i');
    expect(response.success).toBe(false);
    expect(response.error).toBeDefined();
    expect(JSON.stringify(response)).not.toContain(fragment);
    expect(response.error).toContain('[인용 금지 문장]');
  });

  it('수정본과 사유의 저장 거부 안내를 그대로 돌려준다', async () => {
    setup('안전한 문장');
    const base = { projectId: 'p', indicatorId: 'i', confirmationType: '수정 후 확정' as const, confirmerName: '평가자' };
    const edited = await confirmVerdictAction({ ...base, editedText: 'BravoCha', reason: '안전한 사유' });
    const reason = await confirmVerdictAction({ ...base, editedText: '안전한 수정', reason: 'BravoCha' });
    expect(edited).toEqual({ success: false, error: editedError });
    expect(reason).toEqual({ success: false, error: reasonError });
  });

  it('알 수 없는 확정 오류는 고정 안내를 돌려준다', async () => {
    setup('안전한 문장');
    const response = await confirmVerdictAction({ projectId: 'p', indicatorId: 'i', confirmationType: '알 수 없는 종류' as never, confirmerName: '평가자' });
    expect(response).toEqual({ success: false, error: '검토 내용을 처리하지 못했습니다. 다시 시도해 주십시오.' });
  });

  it('귀속 저장에서 알려진 오류를 돌리고 알 수 없는 오류는 고정 문구로 처리한다', async () => {
    setup('안전한 문장');
    mocks.saveError = '해당 사업에 속한 지표가 아닙니다.';
    const known = await saveAttributionAction({ projectId: 'p', indicatorId: 'i', attributionText: '안전한 귀속' });
    expect(known).toEqual({ success: false, error: mocks.saveError });
    mocks.saveError = '알 수 없는 내부 오류 BravoCha';
    const unknown = await saveAttributionAction({ projectId: 'p', indicatorId: 'i', attributionText: '안전한 귀속' });
    expect(unknown).toEqual({ success: false, error: '귀속 내용을 저장하지 못했습니다. 다시 시도해 주십시오.' });
  });

  it('허용된 안내도 현재 사업 금지문과 겹치면 가린다', async () => {
    const db = setup('안전한 문장');
    db.prepare('UPDATE sentences SET content = ? WHERE id = ?').run('수정본에 인용 금지 문장과 8자 이상 겹치는 내용', 'd-ban');
    const response = await confirmVerdictAction({ projectId: 'p', indicatorId: 'i', confirmationType: '수정 후 확정', confirmerName: '평가자', editedText: '수정본에 인용 금지 문장과 8자 이상 겹치는 내용', reason: '안전한 사유' });
    expect(response.success).toBe(false);
    expect(JSON.stringify(response)).not.toContain('수정본에 인용 금지 문장과 8자 이상 겹치는 내용');
    expect(response.error).toContain('[인용 금지 문장]');
  });

  it('세 동작의 조기 반환 안내도 사업 금지문과 겹치면 가린다', async () => {
    const db = setup('안전한 문장');
    const message = '해당 사업에 속한 지표가 아닙니다.';
    db.prepare('UPDATE sentences SET content = ? WHERE id = ?').run(message, 'd-ban');
    const responses = await Promise.all([
      confirmVerdictAction({ projectId: 'p', indicatorId: 'missing', confirmationType: '확정', confirmerName: '평가자' }),
      saveAttributionAction({ projectId: 'p', indicatorId: 'missing', attributionText: '안전한 귀속' }),
      resuggestIndicatorAction('p', 'missing'),
    ]);
    for (const response of responses) {
      expect(response.success).toBe(false);
      expect(JSON.stringify(response)).not.toContain(message);
      expect(response.error).toContain('[인용 금지 문장]');
    }
  });

  it('요청의 금지문 목록을 공유하고 다른 사업에 재사용하지 않는다', () => {
    const db = setup('BravoCha');
    const context = getProjectCitationContext('p', db);
    const prepare = vi.spyOn(db, 'prepare');
    expect(JSON.stringify(getReviewData('p', db, context))).not.toContain('BravoCha');
    expect(getReportTargets('p', db, context)).toEqual([]);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('s.is_citation_banned = 1'))).toHaveLength(0);
    expect(getReviewData('other', db, context)).toBeNull();
    expect(() => getReportTargets('other', db, context)).toThrow();
    prepare.mockRestore();
  });

  it('이력 일괄 조회는 원래 최신 제안·확정 순서·근거 및 주변 가림과 같다', () => {
    const db = setup('안전한 문장');
    const insertEvidence = db.prepare(`INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker) VALUES (?, ?, ?, ?, ?, ?)`);
    insertEvidence.run('old-history-evidence', 's', '이전 근거', 'd', '¶1', '평가자');
    for (let i = 0; i < 30; i++) {
      saveSuggestion({ id: `past-${i}`, indicator_id: 'i', verdict_status: '기대', error_reason: null, proposal_text: '이전 제안', created_at: '2026-10-31' }, [], db);
      insertEvidence.run(`past-evidence-${i}`, `past-${i}`, '이전 인용', 'd', '¶1', '평가자');
    }
    saveSuggestion({ id: 'latest-history', indicator_id: 'i', verdict_status: '추진 중', error_reason: null, proposal_text: '최신 제안', created_at: '2026-10-30' }, [], db);
    insertEvidence.run('history-first', 'latest-history', 'BravoCha', 'd', '¶1', '평가자');
    insertEvidence.run('history-second', 'latest-history', '안전한 인용', 'd', '¶1', '평가자');
    const insertConfirmation = db.prepare(`INSERT INTO confirmations (id, indicator_id, suggestion_id, confirmation_type, confirmer_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
    insertConfirmation.run('c-first', 'i', 's', '확정', '평가자', '2026-11-01');
    insertConfirmation.run('c-second', 'i', 's', '보완 필요', '평가자', '2026-11-01');
    const oldSuggestion = getLatestSuggestion('i', db)!;
    const expectedEvidence = oldSuggestion.evidences.map(evidence => ({
      ...maskEvidenceIfCitationBanned(evidence, [ban]),
      document_name: '가상 문서.docx',
      paragraph_context: getParagraphWithSurroundings(evidence.document_id, evidence.location, db, [ban]) ?? undefined,
    }));
    const history = getHistoryPageData('p', db)!.indicators[0];
    expect(history.latestSuggestion).toEqual({ ...oldSuggestion, evidences: expectedEvidence });
    expect(history.latestSuggestion?.id).toBe('latest-history');
    expect(history.latestSuggestion?.evidences.map(e => e.id)).toEqual(['history-first', 'history-second']);
    expect(history.confirmations).toEqual(listConfirmations('i', db));
    expect(history.confirmations.map(c => c.id)).toEqual(['c-first', 'c-second']);
    expect(history.latestConfirmation).toEqual(history.confirmations[1]);
  });

  it('이력 일괄 조회에서 오염된 타 사업 근거의 문단을 노출하지 않는다', () => {
    const db = setup('안전한 문장');
    db.prepare(`INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker)
      VALUES (?, ?, ?, ?, ?, ?)`).run('foreign-history', 's', '안전한 인용', 'other-doc', '¶1', '평가자');
    const evidence = getHistoryPageData('p', db)?.indicators[0]?.latestSuggestion?.evidences[0];
    expect(evidence?.paragraph_context).toBeUndefined();
  });

  it('오염된 근거의 타 사업 문단은 일괄 문맥에 포함하지 않는다', () => {
    const db = setup('안전한 문장');
    db.prepare(`INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker)
      VALUES (?, ?, ?, ?, ?, ?)`).run('foreign-evidence', 's', '안전한 인용', 'other-doc', '¶1', '평가자');
    const evidence = getReviewData('p', db)?.indicators[0]?.suggestion?.evidences[0];
    expect(evidence?.paragraph_context).toBeUndefined();
  });

  it('금지 목록을 읽지 못하면 화면 데이터와 오류 문자열을 보내지 않는다', async () => {
    const db = setup('안전한 문장');
    db.exec('DROP TABLE sentences');
    expect(getReviewData('p', db)).toBeNull();
    const responses = await Promise.all([
      confirmVerdictAction({ projectId: 'p', indicatorId: 'missing', confirmationType: '확정', confirmerName: '평가자' }),
      saveAttributionAction({ projectId: 'p', indicatorId: 'missing', attributionText: '안전한 귀속' }),
      resuggestIndicatorAction('p', 'missing'),
    ]);
    for (const response of responses) expect(response).toEqual({ success: false });
  });

  it('선택 지표 ID가 금지문과 겹쳐도 초기 props에 남지 않는다', async () => {
    const db = setup('안전한 문장');
    createIndicator({ id: 'BravoCha', project_id: 'p', name: '다른 지표', level: '활동', ovi: '다른 값', mov: null, target_value: null, source_doc_id: 'd', is_baseline: 0, created_at: '2026-10-31' }, db);
    const page = await ReviewPage({ params: Promise.resolve({ projectId: 'p' }), searchParams: Promise.resolve({ indicatorId: 'BravoCha' }) });
    expect(JSON.stringify(page.props)).not.toContain('BravoCha');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiClient as RealAiClient, setAiClient, type AiClient } from '../ai';
import { closeDatabase, createDocument, createIndicator, createProject, getLatestSuggestion, insertParagraphs, openDatabase, saveSuggestion, updateDocumentAiMetadata } from '../store';
import type { ChatMessage } from '../ai/types';
import type { DocumentRecord, IndicatorRecord, ParagraphRecord } from '../store';
import { buildSuggestInput, suggestVerdictForIndicator } from './index';

const paragraph = (document_id: string): ParagraphRecord => ({ id: `${document_id}-p`, document_id, sequence_no: 1, location: '¶1', content: `${document_id} 완료했다` });
const indicator: IndicatorRecord = { id: 'indicator', project_id: 'project', source_doc_id: 'ok', level: '활동', name: '가상 지표', ovi: '가상 내용', mov: null, target_value: null, is_baseline: 0, created_at: '2026-01-01' };

describe('suggest AI input eligibility', () => {
  afterEach(() => { closeDatabase(); setAiClient(null); vi.unstubAllEnvs(); });

  it('uses the current provider for the omitted-provider re-suggestion input', () => {
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
    for (const [id, approved_ai] of [['solar-doc', 'solar'], ['local-doc', 'local-only']]) {
      createDocument({ id, project_id: 'project', file_name: `${id}.docx`, file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai, is_past_final_report: false, created_at: id }, db);
      insertParagraphs([paragraph(id)], db);
    }
    setAiClient({ provider: 'solar' } as AiClient);
    expect(buildSuggestInput('project', db).map((p) => p.document_id)).toEqual(['solar-doc']);
    setAiClient({ provider: 'local-only' } as AiClient);
    expect(buildSuggestInput('project', db).map((p) => p.document_id)).toEqual(['local-doc']);
    setAiClient({ provider: null } as AiClient);
    expect(buildSuggestInput('project', db)).toEqual([]);
  });

  it('filters ineligible and other-project paragraphs and baseline even for direct calls', async () => {
    const db = openDatabase(':memory:');
    for (const id of ['project', 'other']) createProject({ id, name: '가상 사업', created_at: '2026-01-01' }, db);
    const docs: Array<[string, string, Partial<DocumentRecord>]> = [
      ['ok', 'project', {}], ['unmasked', 'project', { masked: false }],
      ['unapproved', 'project', { approved_ai: 'none' }], ['past', 'project', { is_past_final_report: true }],
      ['excluded', 'project', { is_included: 0 }], ['other', 'other', {}],
    ];
    for (const [id, project_id, overrides] of docs) {
      createDocument({ id, project_id, file_name: `${id}.docx`, file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: id, ...overrides }, db);
      insertParagraphs([paragraph(id)], db);
    }
    expect(buildSuggestInput('project', db, 'solar').map((p) => p.document_id)).toEqual(['ok']);
    const generateSuggestion = vi.fn(async (_messages: ChatMessage[]) => ({ suggestion: { verdict_status: '실현' as const, sentence: '완료했다', evidences: [{ document_id: 'ok', location: '¶1', quote: '완료했다', speaker: '수행기관' as const }] }, meta: { duration_ms: 1 } }));
    await suggestVerdictForIndicator(indicator, docs.map(([id]) => paragraph(id)), { db, saveToStore: false, aiClient: { generateSuggestion, provider: 'solar' } as unknown as AiClient, baseline: { id: 'b', indicator_id: indicator.id, project_id: 'project', document_id: 'unapproved', document_name: '비승인', target_value: '비승인 값', selected_at: '2026-01-01' } });
    const body = JSON.parse(generateSuggestion.mock.calls[0][0][1].content);
    expect(body.paragraphs.map((p: { document_id: string }) => p.document_id)).toEqual(['ok']);
    expect(body.indicator.baseline).toBeUndefined();
  });

  it('대조와 의미 재시도는 실제로 전송한 문단 및 잘린 내용만 사용한다', async () => {
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument({ id: 'ok', project_id: 'project', file_name: '가상.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-01' }, db);
    const input = [
      { ...paragraph('ok'), content: `가상 지표 ${'가'.repeat(4000)} 숨겨진 원문` },
      { ...paragraph('ok'), id: 'gap', location: '¶2', sequence_no: 2, content: '문맥' },
      { ...paragraph('ok'), id: 'second', location: '¶3', sequence_no: 3, content: '전송되지 않은 원문' },
    ];
    const generateSuggestion = vi.fn(async (messages: ChatMessage[]) => {
      vi.stubEnv('AIEAS_SUGGEST_MAX_INPUT_CHARS', '60');
      return {
      suggestion: { verdict_status: '실현' as const, sentence: messages.length === 2 ? '' : '정성적 제안', evidences: [
        { document_id: 'ok', location: '¶1', quote: '숨겨진 원문', speaker: '수행기관' as const },
        { document_id: 'ok', location: '¶3', quote: '전송되지 않은 원문', speaker: '수행기관' as const },
      ] }, meta: { duration_ms: 1 },
    }; });
    const result = await suggestVerdictForIndicator(indicator, input, { db, saveToStore: false, aiClient: { generateSuggestion, provider: 'solar' } as unknown as AiClient });
    expect(generateSuggestion).toHaveBeenCalledTimes(2);
    const bodies = generateSuggestion.mock.calls.map(([messages]) => JSON.parse(messages[1].content));
    expect(bodies[0].paragraphs).toEqual(bodies[1].paragraphs);
    expect(bodies[0].paragraphs).toHaveLength(2);
    expect(bodies[0].paragraphs[0].content).toHaveLength(4000);
    expect(result.evidences).toEqual([]);
    expect(result.suggestion.verdict_status).toBe('미확인');
    expect([result.sentParagraphCount, result.totalParagraphCount, result.sentCharacterCount]).toEqual([2, 3, 4002]);
  });

  it('숫자 검증 실패 후 의미 재시도 응답 대기 중 자격이 바뀌면 저장된 최신 제안을 보존한다', async () => {
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument({ id: 'ok', project_id: 'project', file_name: '가상.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-01' }, db);
    createIndicator({ ...indicator, name: '가상 지표' }, db);
    saveSuggestion({ id: 'previous-latest', indicator_id: indicator.id, verdict_status: '실현', error_reason: null, proposal_text: '기존 최신 제안', created_at: '2026-01-01' }, [], db);
    let resolveRetry!: (value: Awaited<ReturnType<AiClient['generateSuggestion']>>) => void;
    const generateSuggestion = vi.fn((_messages: ChatMessage[]): ReturnType<AiClient['generateSuggestion']> => {
      if (generateSuggestion.mock.calls.length === 1) return Promise.resolve({ suggestion: { verdict_status: '실현', sentence: '완료 99건', evidences: [] }, meta: { duration_ms: 1 } });
      return new Promise(resolve => { resolveRetry = resolve; });
    });
    const pending = suggestVerdictForIndicator(indicator, [paragraph('ok')], {
      db, saveToStore: true, aiClient: { generateSuggestion, provider: 'solar' } as unknown as AiClient,
    });
    await vi.waitFor(() => expect(generateSuggestion).toHaveBeenCalledTimes(2));
    updateDocumentAiMetadata('project', 'ok', { is_past_final_report: null }, db);
    resolveRetry({ suggestion: { verdict_status: '실현', sentence: '정성적 제안', evidences: [] }, meta: { duration_ms: 1 } });
    const result = await pending;
    expect(result.saved).toBe(false);
    expect(result.suggestion.error_reason).toBe('자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요');
    expect(result.diagnostics).toEqual(['자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요']);
    expect(getLatestSuggestion(indicator.id, db)?.id).toBe('previous-latest');
  });

  it('첫 응답 대기 중 자격이 null로 바뀌면 제안 전체를 실패시키고 재시도하지 않는다', async () => {
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
    for (const id of ['ok', 'changes']) createDocument({ id, project_id: 'project', file_name: `${id}.docx`, file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: id }, db);
    let resolveFirst!: (value: { suggestion: { verdict_status: '실현'; sentence: string; evidences: Array<{ document_id: string; location: string; quote: string; speaker: '수행기관' }> }; meta: { duration_ms: number } }) => void;
    const generateSuggestion = vi.fn((_messages: ChatMessage[]): ReturnType<AiClient['generateSuggestion']> => {
      if (generateSuggestion.mock.calls.length === 1) return new Promise<typeof firstResponse>(resolve => { resolveFirst = resolve; });
      return Promise.resolve({ suggestion: { verdict_status: '실현' as const, sentence: '정성적 결과', evidences: [{ document_id: 'ok', location: '¶1', quote: '완료했다', speaker: '수행기관' as const }] }, meta: { duration_ms: 1 } });
    });
    const firstResponse = { suggestion: { verdict_status: '실현' as const, sentence: '완료 99건', evidences: [{ document_id: 'ok', location: '¶1', quote: '완료했다', speaker: '수행기관' as const }] }, meta: { duration_ms: 1 } };
    const changesParagraphs = [paragraph('changes'), { ...paragraph('changes'), id: 'changes-p2', sequence_no: 2, location: '¶2', content: 'changes 문단 둘도 제외된다' }];
    const pending = suggestVerdictForIndicator(indicator, [paragraph('ok'), ...changesParagraphs], { db, saveToStore: false, aiClient: { generateSuggestion, provider: 'solar' } as unknown as AiClient });
    await vi.waitFor(() => expect(generateSuggestion).toHaveBeenCalledTimes(1));
    updateDocumentAiMetadata('project', 'changes', { is_past_final_report: null }, db);
    resolveFirst(firstResponse);
    const result = await pending;
    expect(generateSuggestion).toHaveBeenCalledTimes(1);
    expect(result.saved).toBe(false);
    expect(result.suggestion.error_reason).toBe('자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요');
    expect(result.diagnostics).toEqual(['자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요']);
    expect(result.evidences).toEqual([]);
  });

  it('실제 AI 클라이언트 내부 잘못된 응답 재시도에서도 부적격 원문을 다시 보내지 않는다', async () => {
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument({ id: 'ok', project_id: 'project', file_name: '가상.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-01' }, db);
    const ineligibleText = '가상 적격 상태에서만 허용되는 내부 재시도 원문';
    const sourceParagraph = { ...paragraph('ok'), content: ineligibleText };
    const fetchFn = vi.fn<typeof fetch>(async () => {
      updateDocumentAiMetadata('project', 'ok', { is_past_final_report: null }, db);
      return Response.json({ choices: [{ message: { content: '{' } }] });
    });
    const aiClient = new RealAiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'solar-pro2', reasoningEffort: 'low', fetchFn });
    const result = await suggestVerdictForIndicator(indicator, [sourceParagraph], { db, saveToStore: false, aiClient });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchFn.mock.calls[0][1]?.body)).toContain(ineligibleText);
    expect(result.saved).toBe(false);
    expect(result.suggestion.error_reason).toBe('자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요');
    expect(result.evidences).toEqual([]);
  });

  it('자격이 그대로인 의미 재시도는 기존 문단 선택을 보존한다', async () => {
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument({ id: 'ok', project_id: 'project', file_name: 'ok.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-01' }, db);
    const generateSuggestion = vi.fn(async (_messages: ChatMessage[]) => ({ suggestion: { verdict_status: '실현' as const, sentence: generateSuggestion.mock.calls.length === 1 ? '99건' : '정성적 결과', evidences: [{ document_id: 'ok', location: '¶1', quote: 'ok 완료했다', speaker: '수행기관' as const }] }, meta: { duration_ms: 1 } }));
    const input = [paragraph('ok'), { ...paragraph('ok'), id: 'ok-p2', sequence_no: 2, location: '¶2', content: 'ok 이어서 완료했다' }];
    await suggestVerdictForIndicator(indicator, input, { db, saveToStore: false, aiClient: { generateSuggestion, provider: 'solar' } as unknown as AiClient });
    const bodies = generateSuggestion.mock.calls.map(call => JSON.parse(call[0][1].content).paragraphs);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it('JSON 예산에 맞춰 잘린 뒤 숨겨진 인용을 거부한다', async () => {
    vi.stubEnv('AIEAS_SUGGEST_MAX_INPUT_CHARS', '100');
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument({ id: 'ok', project_id: 'project', file_name: '가상.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-01' }, db);
    const generateSuggestion = vi.fn(async () => ({ suggestion: { verdict_status: '실현' as const, sentence: '정성적 결과', evidences: [{ document_id: 'ok', location: '¶1', quote: '숨겨진 인용문', speaker: '수행기관' as const }] }, meta: { duration_ms: 1 } }));
    const result = await suggestVerdictForIndicator(indicator, [{ ...paragraph('ok'), content: `가상 지표 ${'가'.repeat(100)} 숨겨진 인용문` }], { db, saveToStore: false, aiClient: { generateSuggestion, provider: 'solar' } as unknown as AiClient });
    expect(result.sentCharacterCount).toBeLessThan(100);
    expect(result.evidences).toEqual([]);
  });

  it('blocks unknown and mismatched destinations for the indicator source', async () => {
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument({ id: 'ok', project_id: 'project', file_name: '가상.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'local-only', is_past_final_report: false, created_at: '2026-01-01' }, db);
    const generateSuggestion = vi.fn();
    for (const [provider, reason] of [['solar', '제외: approved_ai=local-only ≠ solar'], [null, '제외: AI 제공자 확인 불가']] as const) {
      const result = await suggestVerdictForIndicator(indicator, [], { db, aiClient: { generateSuggestion, provider } as unknown as AiClient });
      expect(result.suggestion.error_reason).toContain(reason);
    }
    expect(generateSuggestion).not.toHaveBeenCalled();
  });

  it('blocks AI when the indicator source is missing or ineligible', async () => {
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument({ id: 'ok', project_id: 'project', file_name: '가상.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'none', is_past_final_report: false, created_at: '2026-01-01' }, db);
    const generateSuggestion = vi.fn();
    for (const source_doc_id of [undefined, 'missing', 'ok']) {
      const result = await suggestVerdictForIndicator({ ...indicator, source_doc_id }, [], { db, aiClient: { generateSuggestion, provider: 'solar' } as unknown as AiClient });
      expect(result.saved).toBe(false);
      expect(result.suggestion.error_reason).toContain('AI 입력 자격');
    }
    expect(generateSuggestion).not.toHaveBeenCalled();
  });
});

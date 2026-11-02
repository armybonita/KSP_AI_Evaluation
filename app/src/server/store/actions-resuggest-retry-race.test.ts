import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAiClient, type AiClient } from '@/server/ai';
import { closeDatabase, createDocument, createIndicator, createProject, getLatestSuggestion, openDatabase, saveSuggestion, updateDocumentAiMetadata } from '@/server/store';
import type { ChatMessage } from '@/server/ai/types';

vi.mock('@/server/viewer', () => ({
  currentViewer: vi.fn(async () => ({ kind: 'member', role: '평가팀' })),
  viewerCan: vi.fn(() => true),
  GUEST_AI_BLOCKED_MESSAGE: '게스트 제한',
  ROLE_BLOCKED_MESSAGE: '권한 제한',
}));
vi.mock('@/server/project-visibility', () => ({ assertProjectVisibleToCurrentViewer: vi.fn() }));

import { resuggestIndicatorAction } from '@/app/projects/[projectId]/review/actions';

describe('resuggest semantic retry eligibility race', () => {
  afterEach(() => { closeDatabase(); setAiClient(null); });

  it('keeps the persisted latest proposal when eligibility changes during the semantic retry', async () => {
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
    for (const [id, docType] of [['pdm', '성과관리표'], ['source', '사업계획서']] as const) {
      createDocument({ id, project_id: 'project', file_name: `${id}.docx`, file_type: 'docx', status: '추출 완료', doc_type: docType, is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: id }, db);
    }
    db.prepare('INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES (?, ?, 1, ?, ?)').run('source-p', 'source', '¶1', '사업 활동을 완료했다');
    createIndicator({ id: 'indicator', project_id: 'project', source_doc_id: 'source', level: '활동', name: '가상 지표', ovi: '가상 결과', mov: null, target_value: null, is_baseline: 0, created_at: '2026-01-01' }, db);
    saveSuggestion({ id: 'previous-latest', indicator_id: 'indicator', verdict_status: '실현', error_reason: null, proposal_text: '기존 최신 제안', created_at: '2026-01-01' }, [], db);

    let resolveRetry!: (value: Awaited<ReturnType<AiClient['generateSuggestion']>>) => void;
    const generateSuggestion = vi.fn((_messages: ChatMessage[]): ReturnType<AiClient['generateSuggestion']> => {
      if (generateSuggestion.mock.calls.length === 1) {
        return Promise.resolve({ suggestion: { verdict_status: '실현', sentence: '완료 99건', evidences: [] }, meta: { duration_ms: 1 } });
      }
      return new Promise(resolve => { resolveRetry = resolve; });
    });
    setAiClient({ provider: 'solar', generateSuggestion } as unknown as AiClient);

    const pending = resuggestIndicatorAction('project', 'indicator');
    await vi.waitFor(() => expect(generateSuggestion).toHaveBeenCalledTimes(2));
    updateDocumentAiMetadata('project', 'source', { is_past_final_report: null }, db);
    resolveRetry({ suggestion: { verdict_status: '실현', sentence: '정성적 재시도 제안', evidences: [] }, meta: { duration_ms: 1 } });
    const result = await pending;

    expect(result).toMatchObject({ success: false, error: '자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요' });
    expect(getLatestSuggestion('indicator', db)?.id).toBe('previous-latest');
    expect(db.prepare('SELECT COUNT(*) AS count FROM suggestions').get()).toEqual({ count: 1 });
  });
});

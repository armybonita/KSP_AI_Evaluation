import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveSuggestion: vi.fn(), getBannedSentencesByProject: vi.fn(() => []), getIndicator: vi.fn(() => ({ id: 'indicator', project_id: 'project', source_doc_id: 'doc' })),
  getReviewData: vi.fn(() => ({ indicators: [{ id: 'indicator', latest_suggestion: { id: 'previous' } }] })),
  maskTextIfForbiddenSentenceOverlap: vi.fn((text: string) => text),
  isIndicatorInProject: vi.fn(() => true), buildSuggestInput: vi.fn(() => []), suggestVerdictForIndicator: vi.fn(),
}));

vi.mock('@/server/store', () => ({ ...mocks }));
vi.mock('@/server/suggest', () => ({ ...mocks }));
vi.mock('@/server/viewer', () => ({ currentViewer: vi.fn(async () => ({ kind: 'member', role: '평가팀' })), viewerCan: vi.fn(() => true), GUEST_AI_BLOCKED_MESSAGE: 'guest', ROLE_BLOCKED_MESSAGE: 'role' }));
vi.mock('@/server/project-visibility', () => ({ assertProjectVisibleToCurrentViewer: vi.fn() }));
vi.mock('@/server/project-pdm', () => ({ isProjectPdmRegistered: vi.fn(() => true), projectPdmExclusionReason: vi.fn() }));

import { resuggestIndicatorAction } from './actions';

describe('resuggest eligibility stop', () => {
  afterEach(() => vi.clearAllMocks());

  it('does not save an eligibility-aborted suggestion and preserves the existing latest result', async () => {
    mocks.suggestVerdictForIndicator.mockResolvedValue({
      saved: false,
      suggestion: { id: 'aborted', indicator_id: 'indicator', verdict_status: '미확인', error_reason: '자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요' },
      evidences: [],
      diagnostics: ['자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요'],
    });

    const result = await resuggestIndicatorAction('project', 'indicator');

    expect(mocks.saveSuggestion).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: '자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요' });
    expect(result.data?.indicators[0]).toMatchObject({ latest_suggestion: { id: 'previous' } });
    expect(result.diagnostics).toEqual(['자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요']);
  });
});

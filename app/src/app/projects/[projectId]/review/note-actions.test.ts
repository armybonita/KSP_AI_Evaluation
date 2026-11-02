import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/project-visibility', () => ({ assertProjectVisibleToCurrentViewer: vi.fn() }));
vi.mock('@/server/viewer', async (original) => ({ ...await original<typeof import('@/server/viewer')>(), currentViewer: vi.fn() }));
vi.mock('@/server/project-pdm', () => ({ isProjectPdmRegistered: vi.fn(() => true), projectPdmExclusionReason: vi.fn(() => '성과관리표가 없습니다. PDM 자료를 등록해 주세요.') }));
vi.mock('@/server/store/note-review', () => ({
  getNoteReviewData: vi.fn(),
  saveNoteReview: vi.fn(),
  confirmNoteLink: vi.fn(),
  rejectNoteLink: vi.fn(),
}));
import { isProjectPdmRegistered } from '@/server/project-pdm';
import { currentViewer } from '@/server/viewer';
import { confirmNoteLink, rejectNoteLink, saveNoteReview } from '@/server/store/note-review';
import { confirmNoteLinkAction, rejectNoteLinkAction, saveNoteReviewAction } from './note-actions';

describe('note review action authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentViewer).mockResolvedValue({ kind: 'guest', label: '손님 평가자' });
  });
  it('rejects guest review saves and link confirmations on the server', async () => {
    expect((await saveNoteReviewAction('p', 'i', 'n', {
      status: '확정', text: '가상', outcomeState: '미확인', reason: '', errorType: '',
    })).success).toBe(false);
    expect((await confirmNoteLinkAction('p', 'i', 's', 't')).success).toBe(false);
    expect((await rejectNoteLinkAction('p','i','s','t','extends_to','이유','기타')).success).toBe(false);
    expect(rejectNoteLink).not.toHaveBeenCalled();
    expect(saveNoteReview).not.toHaveBeenCalled();
    expect(confirmNoteLink).not.toHaveBeenCalled();
  });
  it('PDM 없으면 평가팀의 연결 기각을 거부한다', async () => {
    vi.mocked(currentViewer).mockResolvedValue({ kind: 'member', login: 'tester', role: '평가팀' });
    vi.mocked(isProjectPdmRegistered).mockReturnValueOnce(false);
    expect(await rejectNoteLinkAction('p','i','s','t','extends_to','이유','기타')).toMatchObject({ success: false, error: expect.stringContaining('PDM') });
    expect(rejectNoteLink).not.toHaveBeenCalled();
  });
  it('preserves known confirmation errors and masks unexpected failures', async () => {
    vi.mocked(currentViewer).mockResolvedValue({ kind: 'member', login: 'tester', role: '평가팀' });
    for (const message of ['현재 사업의 연결 후보를 찾을 수 없습니다.', '사유와 오류 유형을 입력해 주십시오.', '인용 금지 문장이 포함되어 저장할 수 없습니다.']) {
      vi.mocked(confirmNoteLink).mockImplementationOnce(() => { throw new Error(message); });
      expect(await confirmNoteLinkAction('p', 'i', 's', 't')).toEqual({ success: false, error: message });
    }
    vi.mocked(confirmNoteLink).mockImplementationOnce(() => { throw new Error('database locked'); });
    expect(await confirmNoteLinkAction('p', 'i', 's', 't')).toEqual({ success: false, error: '연결 후보를 확정하지 못했습니다.' });
  });

});

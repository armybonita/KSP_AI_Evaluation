import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  role: '기획팀' as '평가팀' | '기획팀' | 'PO',
  visible: true,
  finalized: false,
  valid: true,
  docxCalls: 0,
  savedCalls: 0,
}));

vi.mock('@/server/project-visibility', () => ({ assertProjectVisibleToCurrentViewer: vi.fn(async () => { if (!state.visible) throw new Error('사업 접근 불가'); }), isProjectHiddenFromViewer: vi.fn(async () => !state.visible) }));
vi.mock('@/server/project-pdm', () => ({ isProjectPdmRegistered: vi.fn(() => true) }));
vi.mock('@/server/store', () => ({
  getProject: vi.fn(() => ({ id: 'project' })),
  getReportDraftById: vi.fn((_projectId: string, id: string) => ({ id, project_id: 'project' })),
  getLatestReportDraft: vi.fn(() => ({ id: 'report-current' })),
  listReportDrafts: vi.fn(() => []),
  getDatabase: vi.fn(),
  saveReportDraft: vi.fn(),
}));
vi.mock('@/server/report', () => ({
  computeJudgmentFingerprint: vi.fn(),
  createReportDraft: vi.fn(),
  generateReportDocx: vi.fn(async () => { state.docxCalls += 1; return Buffer.from('virtual docx'); }),
  getSavedReportDraft: vi.fn(() => ({ confirmed_count: 1, report_finalization: state.finalized ? { role: '평가팀', confirmed_at: '2026-11-02' } : undefined })),
  getSavedReportDraftWithStatus: vi.fn(() => { state.savedCalls += 1; return { draft: { confirmed_count: 1, report_finalization: state.finalized ? { role: '평가팀', confirmed_at: '2026-11-02' } : undefined }, isOutdated: !state.valid }; }),
  listReportDrafts: vi.fn(() => []),
}));
vi.mock('@/server/viewer', () => ({
  currentViewer: vi.fn(async () => ({ kind: 'member', role: state.role })),
  viewerFromHeaders: vi.fn(() => ({ kind: 'member', role: state.role })),
  viewerCan: vi.fn(() => state.role === '평가팀'),
  GUEST_AI_BLOCKED_MESSAGE: '로그인 필요',
}));

import { finalizeReportAction, generateReportDownloadAction } from './actions';
import { GET } from './download/route';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/server/store';

beforeEach(() => {
  state.role = '기획팀';
  state.visible = true;
  state.finalized = false;
  state.valid = true;
  state.docxCalls = 0;
  state.savedCalls = 0;
});

describe('보고서 Word 접근', () => {
  it('기획팀은 미확정 판의 액션과 직접 URL을 모두 거부한다', async () => {
    expect(await generateReportDownloadAction('project', 'report-draft')).toEqual({ success: false, error: '기획팀은 평가팀 최종 확정본만 내려받을 수 있습니다.' });
    const response = await GET(new NextRequest('http://localhost/projects/project/report/download?reportId=report-draft'), { params: Promise.resolve({ projectId: 'project' }) });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('기획팀은 평가팀 최종 확정본만 내려받을 수 있습니다.');
    expect(state.docxCalls).toBe(0);
  });

  it('기획팀은 선택한 평가팀 확정 판만 내려받는다', async () => {
    state.finalized = true;
    const action = await generateReportDownloadAction('project', 'report-final');
    expect(action.success).toBe(true);
    expect(action.fileName).toBe('report_project.docx');
    const response = await GET(new NextRequest('http://localhost/projects/project/report/download?reportId=report-final'), { params: Promise.resolve({ projectId: 'project' }) });
    expect(response.status).toBe(200);
    expect(state.docxCalls).toBe(2);
  });

  it('오래된 판은 평가팀 액션과 직접 URL 모두 다운로드하지 않는다', async () => {
    state.role = '평가팀';
    state.valid = false;
    const action = await generateReportDownloadAction('project', 'report-old');
    expect(action.success).toBe(false);
    expect(action.error).toBe('확정 내용이 바뀌었습니다. 초안을 다시 만드세요.');
    const response = await GET(new NextRequest('http://localhost/projects/project/report/download?reportId=report-old'), { params: Promise.resolve({ projectId: 'project' }) });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('확정 내용이 바뀌었습니다. 초안을 다시 만드세요.');
    expect(state.docxCalls).toBe(0);
  });

  it('숨겨진 사업은 문안 확정 전에 접근 검사를 통과하지 못한다', async () => {
    state.role = '평가팀';
    state.visible = false;
    await expect(finalizeReportAction('project', '2026-11-02', true)).rejects.toThrow('사업 접근 불가');
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it('다운로드 권한이 없는 역할은 저장 판을 읽기 전에 거부한다', async () => {
    state.role = 'PO';
    const action = await generateReportDownloadAction('project', 'report-id');
    expect(action).toEqual({ success: false, error: '이 역할에는 접근 권한이 없습니다.' });
    const response = await GET(new NextRequest('http://localhost/projects/project/report/download?reportId=report-id'), { params: Promise.resolve({ projectId: 'project' }) });
    expect(response.status).toBe(403);
    expect(state.savedCalls).toBe(0);
  });
});

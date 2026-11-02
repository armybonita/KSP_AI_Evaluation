import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import DocumentsPage from './page';
import { DocumentEvidenceWarning } from './documents-client-view';

const settings = vi.hoisted(() => ({ provider: 'solar' as string | null, past: null as boolean | null }));
vi.mock('@/server/ai', () => ({ getAiGatewayProvider: () => settings.provider }));
vi.mock('@/server/project-visibility', () => ({ assertProjectVisibleToCurrentViewer: vi.fn() }));
vi.mock('@/server/viewer', () => ({ currentViewer: async () => ({ kind: 'member', role: '평가팀' }), viewerCan: () => true, isGuestViewer: () => false }));
vi.mock('@/app/workflow-next-action', () => ({ WorkflowNextAction: ({ hasPdm }: { hasPdm: boolean }) => <span data-testid="next-state">{hasPdm ? '준비' : '잠김'}</span> }));
vi.mock('../project-tabs', () => ({ ProjectTabs: () => null }));
vi.mock('./actions', () => ({
  getDocumentsPageData: async () => ({
    project: { id: 'project', name: '가상 사업' },
    documents: [
      { id: 'local', file_name: 'local.docx', status: '추출 완료', doc_type: '기타', is_included: 1, masked: true, approved_ai: 'local-only', is_past_final_report: false },
      { id: 'solar', file_name: 'solar.docx', status: '추출 완료', doc_type: '기타', is_included: 1, masked: true, approved_ai: 'solar', is_past_final_report: false },
      { id: 'unknown', file_name: 'unknown.docx', status: '추출 완료', doc_type: '성과관리표', is_included: 1, masked: null, approved_ai: 'solar', is_past_final_report: settings.past },
    ],
  }),
  getDocumentParagraphsAction: vi.fn(),
  updateDocumentInclusionAction: vi.fn(),
  updateDocumentTypeAction: vi.fn(),
  uploadDocumentsAction: vi.fn(),
}));

describe('document list AI provider eligibility', () => {
  it('shows provider mismatch and unknown provider exclusions using the server configuration', async () => {
    settings.provider = 'solar';
    const page = await DocumentsPage({ params: Promise.resolve({ projectId: 'project' }) });
    const markup = renderToStaticMarkup(page);
    expect(markup).toContain('제외: approved_ai=local-only ≠ solar');
    expect(markup).toContain('data-testid="ai-exclusion-local"');
    expect(markup).not.toContain('data-testid="ai-exclusion-solar"');

    settings.provider = null;
    const unknownPage = await DocumentsPage({ params: Promise.resolve({ projectId: 'project' }) });
    const unknownMarkup = renderToStaticMarkup(unknownPage);
    expect(unknownMarkup).toContain('제외: AI 제공자 확인 불가');
    expect(unknownMarkup).toContain('data-testid="ai-exclusion-solar"');
  });
});

describe('document AI metadata controls', () => {
  it('renders the existing evidence warning only when the action reports it', () => {
    expect(renderToStaticMarkup(<DocumentEvidenceWarning visible={false} />)).toBe('');
    const warning = renderToStaticMarkup(<DocumentEvidenceWarning visible />);
    expect(warning).toContain('기존 지식 지도 점 또는 근거');
    expect(warning).toContain('지식 지도를 재생성');
  });

  it('shows each current value and explicit choices for each document', async () => {
    const page = await DocumentsPage({ params: Promise.resolve({ projectId: 'project' }) });
    const markup = renderToStaticMarkup(page);
    expect(markup).toContain('data-testid="ai-metadata-local"');
    expect(markup).toContain('data-testid="ai-metadata-unknown"');
    expect(markup).toContain('가명화: 미확인');
    expect(markup).toContain('종료평가보고서: 미확인');
    expect(markup).toContain('과거 보고서 여부 미확인 — 확인 전에는 분석에 쓰지 않음');
    expect(markup).toContain('미확인으로 변경');
    expect(markup).toContain('개인정보 마스킹 완료');
    expect(markup).toContain('local-only');
    expect(markup).toContain('이번 사업의 자료다');
    expect(markup).toContain('AI 입력 정보 저장');
  });
});

it('PDM 필요 경로에서 미확인 사유를 보여주고 준비된 것으로 취급하지 않는다', async () => {
  const page = await DocumentsPage({ params: Promise.resolve({ projectId: 'project' }), searchParams: Promise.resolve({ pdm: 'required' }) });
  const markup = renderToStaticMarkup(page);
  expect(markup).toContain('성과관리표 unknown.docx의 과거 보고서 여부가 미확인이라 분석에서 뺐습니다');
});

it.each([[null, '잠김'], [true, '잠김'], [false, '준비']] as const)('PDM 과거 여부 %s일 때 다음 단계는 %s', async (past, state) => {
  settings.past = past;
  const page = await DocumentsPage({ params: Promise.resolve({ projectId: 'project' }) });
  expect(renderToStaticMarkup(page)).toContain(`data-testid="next-state">${state}`);
  settings.past = null;
});

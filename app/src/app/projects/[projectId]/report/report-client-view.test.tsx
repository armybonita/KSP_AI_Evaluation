import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@/server/store/types';
import type { ReportDraftData } from '@/server/report/types';
import { EvidencePanel, ReportClientView } from './report-client-view';

vi.mock('./actions', () => ({
  generateReportDraftAction: vi.fn(),
  generateReportDownloadAction: vi.fn(),
  getReportVersionAction: vi.fn(),
  getReportVersionsAction: vi.fn(),
}));
vi.mock('../project-tabs', () => ({ ProjectTabs: () => null }));

import { TemplateSections } from './template-sections';

function savedDraft(overrides: Partial<ReportDraftData> = {}): ReportDraftData {
  return {
    project_id: 'project', project_name: '가상 사업', created_at: '2026-11-02', draft_number: 1, confirmed_count: 1,
    version: 3, template: 'eipp', template_source: '서식 출처: 가상 EIPP 종료평가 형식',
    report_sections: [{
      id: 'overview', title: '사업 개요', level: 2,
      table: { columns: ['항목', '내용'], rows: [[
        { text: '협력국', source: 'document', is_label: true },
        { text: '가상국', source: 'document' },
      ]] },
      content: '가상 저장 문장',
    }],
    footnotes: [{ number: 1, evidence_id: 'internal-evidence-key', document_name: '가상 문서.docx', location: '3쪽' }],
    sections: {} as ReportDraftData['sections'],
    ...overrides,
  };
}

describe('report AI exclusions notice', () => {
  it('shows each excluded subject and reason, including for an empty report', () => {
    const draft = {
      confirmed_count: 0,
      ai_exclusions: [
        { subject: '자료.docx', reasons: ['마스킹 미확인', '제공자 불일치'] },
        { subject: '가상 지표', reasons: ['검증 통과 근거 없음'] },
      ],
    } as ReportDraftData;
    const markup = renderToStaticMarkup(
      <ReportClientView project={{ id: 'project', name: '가상 사업' } as ProjectRecord} initialTargets={[]} initialDraft={draft} />
    );
    expect(markup).toContain('AI 입력 제외');
    expect(markup).toContain('자료.docx');
    expect(markup).toContain('마스킹 미확인');
    expect(markup).toContain('제공자 불일치');
    expect(markup).toContain('가상 지표');
    expect(markup).toContain('검증 통과 근거 없음');
  });
});

it('기획팀은 미확정 판을 선택한 동안 다운로드가 막히고 안내를 본다', () => {
  const markup = renderToStaticMarkup(<ReportClientView project={{ id: 'project', name: '가상 사업' } as ProjectRecord} initialTargets={[{} as never]} initialDraft={null} canGenerate={false} reportFinalizationRequired />);
  expect(markup).toContain('기획팀은 평가팀 최종 확정본을 선택해야 내려받을 수 있습니다.');
  expect(markup).toContain('data-testid="download-docx-button"');
  expect(markup).toContain('data-testid="download-docx-button" disabled=""');
});

it('기획팀이 새 초안과 함께 남은 확정본을 선택하면 화면과 Word를 사용할 수 있다', () => {
  const draft = savedDraft({ report_finalization: { role: '평가팀', confirmed_at: '2026-11-01' } });
  const markup = renderToStaticMarkup(<ReportClientView
    project={{ id: 'project', name: '가상 사업', project_type: 'EIPP' } as ProjectRecord}
    initialTargets={[]}
    initialDraft={draft}
    initialReportId="report-final"
    initialLatestReportId="report-new"
    initialVersions={[
      { id: 'report-new', draft_number: 2, created_at: '2026-11-02', isFinalized: false },
      { id: 'report-final', draft_number: 1, created_at: '2026-11-01', isFinalized: true, finalizedAt: '2026-11-01', finalizedRole: '평가팀' },
    ]}
    initialConfirmedCount={1}
    canGenerate={false}
    reportFinalizationRequired
  />);
  expect(markup).toContain('v1 · 최종 확정 (2026-11-01)');
  expect(markup).toContain('가상 저장 문장');
  expect(markup).toContain('data-testid="report-template-source"');
  expect(markup).toContain('서식 출처: 가상 EIPP 종료평가 형식');
  expect(markup).toContain('data-testid="download-docx-button"');
  expect(markup).not.toContain('data-testid="download-docx-button" disabled=""');
  expect(markup).not.toContain('planner-final-report-required');
});

it('오래된 판은 알림만 표시하고 보고서 본문과 근거 패널을 숨긴다', () => {
  const markup = renderToStaticMarkup(<ReportClientView
    project={{ id: 'project', name: '가상 사업' } as ProjectRecord}
    initialTargets={[]}
    initialDraft={savedDraft()}
    initialReportId="report-old"
    initialOutdated
    initialConfirmedCount={1}
  />);
  expect(markup).toContain('data-testid="outdated-draft-notice"');
  expect(markup).not.toContain('data-testid="report-content"');
  expect(markup).not.toContain('가상 저장 문장');
  expect(markup).not.toContain('report-evidence-sidebar');
});

it('서식 출처·문서 원문 배지·표제 셀·사람이 읽을 수 있는 각주를 표시한다', () => {
  const markup = renderToStaticMarkup(<TemplateSections draft={savedDraft()} onSelect={() => undefined} />);
  expect(markup).toContain('report-source-document');
  expect(markup).toContain('>협력국</td>');
  expect(markup).toContain('[1] 가상 문서.docx · 3쪽');
  expect(markup).not.toContain('internal-evidence-key');
});

it('새 초안의 기본 서식은 화면과 서버가 project_type을 기준으로 정한다', () => {
  const markup = renderToStaticMarkup(<ReportClientView
    project={{ id: 'project', name: '가상 사업 이름', project_type: 'EIPP' } as ProjectRecord}
    initialTargets={[]}
    initialDraft={null}
    initialConfirmedCount={1}
  />);
  expect(markup).toContain('<option value="eipp" selected="">EIPP</option>');
});

it('근거 패널에 저장된 신뢰도·검토자·확정일을 표시한다', () => {
  const markup = renderToStaticMarkup(<EvidencePanel
    projectId="project"
    allowSnapshot
    sentence={{
      indicator_id: 'node-a', indicator_name: '가상 성과', sentence: '가상 판단 문장', evidence_id: 'evidence-a', evidence_ids: ['evidence-a'],
      evidences: [{
        id: 'evidence-a', quote: '가상 근거 문장', location: '3쪽', speaker: '가상 참여자', document_name: '가상 문서.docx',
        review_status: '확정', confirmer_role: '평가자 A', confirmed_at: '2026-11-02', evidence_level: '입증', confidence: '높음',
      }],
    }}
  />);
  expect(markup).toContain('입증 · 신뢰도 높음');
  expect(markup).toContain('>확정</dd>');
  expect(markup).toContain('>평가자 A</dd>');
  expect(markup).toContain('>2026-11-02</dd>');
});

it('보고서 화면에서 제외 문서 수와 자료 링크를 표시한다', () => {
  const props = { project: { id: 'project', name: '가상 사업' } as ProjectRecord, initialTargets: [], initialDraft: null };
  const markup = renderToStaticMarkup(<ReportClientView {...props} exclusionSummary={{ unconfirmed: 1, past: 1 }} />);
  expect(markup).toContain('과거 종료평가보고서 1개·과거 여부 미확인 1개 문서는 분석과 근거에서 빠집니다');
  expect(markup).not.toContain('.docx');
  expect(markup).toContain('/projects/project/documents');
  expect(renderToStaticMarkup(<ReportClientView {...props} exclusionSummary={{ unconfirmed: 0, past: 0 }} />)).not.toContain('분석과 근거에서 빠집니다');
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { summarizePortfolioProject, type PortfolioOutcome } from '@/lib/portfolio';
import { PortfolioClientView } from './portfolio-client-view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => '' }));
vi.mock('./actions', () => ({ savePortfolioLevelAction: vi.fn() }));

describe('포트폴리오 제외 사유', () => {
  it('축에 유효 값이 있어도 제외 성과와 이유를 축 요약과 성과 행에 표시한다', () => {
    const base: PortfolioOutcome = {
      id: 'included', type: 'outcome-mid', title: '가상 포함 성과', text: '', outcomeFamily: '협력국 정책 반영',
      aiLevel: '', reviewStatus: '확정', outcomeState: '관측됨', evidenceEligible: true, evidenceObserved: true,
      teamLevel: 'K3', teamLevelSource: 'imported', history: [],
    };
    const outcomes: PortfolioOutcome[] = [base,
      { ...base, id: 'ineligible', title: '가상 자격 제외 성과', teamLevel: 'K6', evidenceEligible: false, evidenceObserved: false },
      { ...base, id: 'forecast', title: '가상 예견 성과', teamLevel: 'K5', evidenceObserved: false },
    ];
    const summary = summarizePortfolioProject('p', '가상 사업', outcomes);
    expect(summary.knowledge.level).toBe('K3');
    const html = renderToStaticMarkup(<PortfolioClientView initialData={{ projectId: 'p', projectName: '가상 사업', importId: 'i', outcomes, summary }} canEdit={false} />);
    expect(html).toContain('가상 자격 제외 성과: 근거 자격 없음');
    expect(html).toContain('가상 예견 성과: 관측·입증 근거 없음');
    expect(html).toContain('계산 제외: 근거 자격 없음');
    expect(html).toContain('계산 제외: 관측·입증 근거 없음');
  });
});

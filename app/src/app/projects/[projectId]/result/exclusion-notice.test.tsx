import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ResultTocPageClientView } from './result-client-view';
import type { ResultTocPageData } from '@/server/store/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../project-tabs', () => ({ ProjectTabs: () => null }));
vi.mock('./actions', () => ({ loadResultTocPageAction: vi.fn() }));

it('결과 화면과 로딩 실패 화면은 문서명 없이 제외 수와 자료 링크를 표시한다', () => {
  const summary = { unconfirmed: 1, past: 1 };
  const data = { project: { id: 'project', name: '가상 사업' }, activeItems: [], orphanedItems: [], items: [], hasAnyConfirmation: false, hasPdm: false } as unknown as ResultTocPageData;
  for (const initialData of [data, null]) {
    const markup = renderToStaticMarkup(<ResultTocPageClientView projectId="project" initialData={initialData} exclusionSummary={summary} />);
    expect(markup).toContain('과거 종료평가보고서 1개·과거 여부 미확인 1개 문서는 분석과 근거에서 빠집니다');
    expect(markup).toContain('/projects/project/documents');
    expect(markup).not.toContain('.docx');
  }
});

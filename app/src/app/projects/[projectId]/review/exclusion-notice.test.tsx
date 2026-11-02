import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ReviewClientView } from './review-client-view';
import type { ReviewPageData } from '@/server/store/types';

vi.mock('../project-tabs', () => ({ ProjectTabs: () => null }));

it('검토 화면에서 제외 문서 수와 자료 링크를 표시한다', () => {
  const data = { project: { id: 'project', name: '가상 사업' }, indicators: [], unreadableDocuments: [], latestConfirmerName: null } as unknown as ReviewPageData;
  const summary = { unconfirmed: 1, past: 1 };
  const markup = renderToStaticMarkup(<ReviewClientView initialData={data} exclusionSummary={summary} />);
  expect(markup).toContain('과거 종료평가보고서 1개·과거 여부 미확인 1개 문서는 분석과 근거에서 빠집니다');
  expect(markup).not.toContain('.docx');
  expect(markup).toContain('/projects/project/documents');
  expect(renderToStaticMarkup(<ReviewClientView initialData={data} exclusionSummary={{ unconfirmed: 0, past: 0 }} />)).not.toContain('분석과 근거에서 빠집니다');
});

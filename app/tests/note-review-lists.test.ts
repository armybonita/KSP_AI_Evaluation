import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FactorLists, inStage, NoteReviewView } from '@/app/projects/[projectId]/review/note-review-view';
import type { NoteItem } from '@/server/store/note-review';

const item = (id: string, type: string, title: string): NoteItem => ({
  id, type, title, text: title, fields: {}, sections: {}, evidence: [], contradictions: [], relations: [], candidates: [], history: [],
});

it('⑦은 근거 없는 가상 기여요인과 제약요인을 각각 표시한다', () => {
  const items = [item('one', 'enabler', '가상 기여'), item('two', 'constraint', '가상 제약')];
  expect(items.every(i => inStage(i, 3))).toBe(true);
  const html = renderToStaticMarkup(createElement(FactorLists, {
    items,
    renderRow: (node: NoteItem) => createElement('p', { key: node.id }, node.title),
  }));
  const [enabler, constraint] = html.split('</section>');
  expect(enabler).toContain('가상 기여');
  expect(enabler).not.toContain('가상 제약');
  expect(constraint).toContain('가상 제약');
  expect(constraint).not.toContain('가상 기여');
  expect(html).toContain('외부 상황만으로 사업의 제약요인으로 확정하지 않음');
});

it('근거 없는 노트와 인용 금지 근거도 단계 목록에 남고 안전한 위치만 표시한다', () => {
  const noEvidence = item('output', 'output', '가상 산출물');
  const banned = item('short', 'outcome-short', '가상 단기');
  banned.evidence = [{ id: 'snippet', quote: '[인용 금지 문장]', sourceId: 'source', sourceTitle: '가상 문서', location: '3쪽', date: '', level: '', speaker: '', verified: false, match: null }];
  expect(inStage(noEvidence, 0)).toBe(true);
  expect(inStage(banned, 1)).toBe(true);
  const html = renderToStaticMarkup(createElement(NoteReviewView, {
    projectId: 'project', initialData: { importId: 'import', items: [noEvidence, banned], missingReviewedCount: 2 },
  }));
  expect(html).toContain('④ 산출물 0/1');
  expect(html).toContain('⑤ 단기성과 0/1');
  expect(html).toContain('근거 자료 미확보');
  expect(html).toContain('이전 생성에서 검토했으나 이번 생성에 없는 노트 2건');
  const bannedHtml = renderToStaticMarkup(createElement(NoteReviewView, {
    projectId: 'project', initialData: { importId: 'import', items: [{ ...banned, type: 'output' }] },
  }));
  expect(bannedHtml).toContain('인용 금지 문장 있음');
  expect(bannedHtml).toContain('3쪽');
  expect(bannedHtml).not.toContain('[인용 금지 문장]');
});

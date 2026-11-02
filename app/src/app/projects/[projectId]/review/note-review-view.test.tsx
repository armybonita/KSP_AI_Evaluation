import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { NoteItem, NoteReview } from '@/server/store/note-review';
import { NoteReviewView, noteReviewStageForNode, noteReviewStageForScope } from './note-review-view';

vi.mock('./note-actions', () => ({ getNoteSourceAction: vi.fn(), saveNoteReviewAction: vi.fn(), confirmNoteLinkAction: vi.fn(), rejectNoteLinkAction: vi.fn() }));

const old = { id: 'old', status: '확정', reviewer: '가상 검토자', created_at: '2026-01-01', text: '옛 문안' } as NoteReview;
const item: NoteItem = { id: 'n', type: 'output', title: '가상 노트', text: '문안', fields: { merged_same_document: true }, sections: {}, evidence: [], contradictions: [], relations: [], candidates: [], history: [], splitHistory: [old], splitPending: true };
const render = (note: NoteItem) => renderToStaticMarkup(<NoteReviewView projectId="p" initialData={{ importId: 'i', items: [note] }} />);

describe('노트 분할 표시', () => {
  it('미해소 때만 경고하고 해소 뒤에는 접힌 이전 이력을 남긴다', () => {
    expect(render(item)).toContain('둘 이상으로 나뉨, 다시 확인 필요');
    const resolved = render({ ...item, splitPending: false });
    expect(resolved).not.toContain('둘 이상으로 나뉨, 다시 확인 필요');
    expect(resolved).toContain('<details><summary>이전 이력 보기</summary>');
    expect(resolved).toContain('옛 문안');
  });
  it('합침 표시의 근거가 비면 건수 문구를 숨긴다', () => {
    const markup = render(item);
    expect(markup).not.toContain('한 문서의 같은 이름 근거');
    expect(markup).not.toContain('-Infinity');
  });
});

describe('검토 다음 단계 동기화', () => {
  it('선택한 노트의 ④~⑦ 단계를 상위 동작 줄에 전달하고 데이터가 없으면 ④에서 시작한다', () => {
    const mid: NoteItem = { ...item, id: 'mid', type: 'outcome-mid', title: '가상 중장기성과' };
    expect(noteReviewStageForNode([item, mid], 'mid')).toBe(2);
    expect(noteReviewStageForNode([], undefined)).toBe(0);
  });

  it('사업이나 가져오기가 바뀌면 이전 단계 대신 새 선택 노드의 단계를 쓴다', () => {
    expect(noteReviewStageForScope({ scope: '["project-a","import-a"]', stage: 3 }, '["project-a","import-a"]', 0)).toBe(3);
    expect(noteReviewStageForScope({ scope: '["project-a","import-a"]', stage: 3 }, '["project-b","import-a"]', 0)).toBe(0);
  });
});

describe('초기 ToC 그래프에서 검토 항목 열기', () => {
  it('같은 노드 ID의 중장기성과 항목을 선택하고 해당 단계로 연다', () => {
    const mid: NoteItem = { ...item, id: 'OUT-M-01', type: 'outcome-mid', title: '가상 중장기성과' };
    const markup = renderToStaticMarkup(
      <NoteReviewView projectId="p" initialData={{ importId: 'i', items: [item, mid] }} initialSelectedNodeId="OUT-M-01" />,
    );
    expect(markup).toContain('aria-pressed="true" data-testid="note-stage-2"');
    expect(markup).toContain('aria-pressed="true" class="block w-full border-b p-2 text-left text-sm bg-blue-50 ring-1 ring-blue-300"');
    expect(markup).toContain('판단 문안 · 가상 중장기성과');
  });
});

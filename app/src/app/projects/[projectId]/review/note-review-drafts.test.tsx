import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteItem, NoteReview } from '@/server/store/note-review';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], index: 0, pending: undefined as Promise<void> | undefined }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.index++;
      if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [hooks.states[index], (update: unknown) => {
        hooks.states[index] = typeof update === 'function' ? (update as (previous: unknown) => unknown)(hooks.states[index]) : update;
      }];
    },
    useTransition: () => [false, (callback: () => Promise<void>) => { hooks.pending = callback(); }],
  };
});
vi.mock('./note-actions', () => ({ getNoteSourceAction: vi.fn(), saveNoteReviewAction: vi.fn(), confirmNoteLinkAction: vi.fn(), rejectNoteLinkAction: vi.fn() }));

import { NoteReviewView } from './note-review-view';
import { getNoteSourceAction, saveNoteReviewAction } from './note-actions';

const item = (id: string, text: string): NoteItem => ({
  id, type: 'output', title: id, text, fields: {}, sections: {}, evidence: [], contradictions: [], relations: [], candidates: [], history: [],
});
const data = (importId: string, text: string) => ({
  importId, items: [item('first', text), item('shared', text)], missingReviewedCount: 0, unknownReviewedCount: 0,
  missingLinkCount: 0, unknownLinkCount: 0, unknownRelationLinks: [], splitReviewedCount: 0, splitLinkCount: 0,
});

// Walk the rendered element tree so the tests exercise the same handlers and values as the screen.
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = find(child, predicate);
    if (found) return found;
  }
}
function renderedText(value: any): string {
  if (Array.isArray(value)) return value.map(renderedText).join('');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value?.props ? renderedText(value.props.children) : '';
}
function render(projectId: string, initialData: ReturnType<typeof data>) {
  hooks.index = 0;
  return NoteReviewView({ projectId, initialData });
}
const textarea = (tree: any) => find(tree, node => node.type === 'textarea');
const reason = (tree: any) => find(tree, node => node.type === 'input');
const button = (tree: any, label: string) => find(tree, node => node.type === 'button' && node.props.children === label);
const row = (tree: any, title: string) => find(tree, node => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes(title));
const stage = (tree: any, index: number) => find(tree, node => node.props?.['data-testid'] === `note-stage-${index}`);

beforeEach(() => { hooks.states.length = 0; hooks.index = 0; hooks.pending = undefined; vi.clearAllMocks(); });

describe('노트 초안 범위', () => {
  it('같은 노드 번호라도 다른 사업과 가져오기에 입력 및 선택이 새지 않는다', () => {
    const a = data('import-a', '사업 A 문안');
    let tree = render('project-a', a);
    row(tree, 'shared').props.onClick();
    tree = render('project-a', a);
    textarea(tree).props.onChange({ target: { value: '사업 A 초안' } });
    tree = render('project-a', a);
    reason(tree).props.onChange({ target: { value: '사업 A 사유' } });

    const b = data('import-a', '사업 B 문안');
    tree = render('project-b', b);
    expect(textarea(tree).props.value).toBe('사업 B 문안');
    expect(reason(tree).props.value).toBe('');
    expect(row(tree, 'first').props['aria-pressed']).toBe(true);
    row(tree, 'shared').props.onClick();
    tree = render('project-b', b);
    expect(textarea(tree).props.value).toBe('사업 B 문안');
    expect(reason(tree).props.value).toBe('');

    const anotherImport = data('import-b', '새 가져오기 문안');
    tree = render('project-a', anotherImport);
    expect(row(tree, 'first').props['aria-pressed']).toBe(true);
    row(tree, 'shared').props.onClick();
    tree = render('project-a', anotherImport);
    expect(textarea(tree).props.value).toBe('새 가져오기 문안');
    expect(reason(tree).props.value).toBe('');

    tree = render('project-a', a);
    expect(textarea(tree).props.value).toBe('사업 A 초안');
    expect(reason(tree).props.value).toBe('사업 A 사유');
  });

  it('같은 마운트에서 사업을 바꾸면 단계·성공 메시지·원문 모달이 이전 사업 값을 쓰지 않는다', async () => {
    const evidence: NoteItem['evidence'][number] = {
      id: 'evidence-a', sourceId: 'source-a', sourceTitle: '가상 자료', quote: '가상 근거', location: '1쪽',
      date: '2026-01-01', level: '관측', speaker: '가상 참여자', verified: true, match: 1,
    };
    const a = data('import-a', '사업 A 문안');
    a.items[0].evidence = [evidence];
    const saved = data('import-a', '사업 A 문안');
    saved.items[0].evidence = [evidence];
    vi.mocked(saveNoteReviewAction).mockResolvedValue({ success: true, data: saved });
    vi.mocked(getNoteSourceAction).mockResolvedValue({
      success: true,
      source: { sourceTitle: '사업 A 원문', paragraphs: [{ position: 'selected', location: '1쪽', content: '사업 A 원문 내용' }] },
    });

    let tree = render('project-a', a);
    button(tree, '확정').props.onClick();
    await hooks.pending;
    tree = render('project-a', a);
    expect(find(tree, node => node.type === 'p' && node.props.role === 'status')?.props.children).toBe('저장했습니다.');
    await find(tree, node => node.type === 'button' && node.props.children === '원문 보기').props.onClick();
    expect(getNoteSourceAction).toHaveBeenCalledWith('project-a', 'evidence-a');
    tree = render('project-a', a);
    expect(find(tree, node => node.type === 'h3' && renderedText(node.props.children) === '원문 보기 · 사업 A 원문')).toBeTruthy();

    stage(tree, 3).props.onClick();
    tree = render('project-a', a);
    expect(stage(tree, 3).props['aria-pressed']).toBe(true);

    const b = data('import-a', '사업 B 문안');
    tree = render('project-b', b);
    expect(stage(tree, 0).props['aria-pressed']).toBe(true);
    expect(stage(tree, 3).props['aria-pressed']).toBe(false);
    expect(find(tree, node => node.type === 'p' && node.props.role === 'status')).toBeUndefined();
    expect(find(tree, node => node.type === 'h3' && renderedText(node.props.children) === '원문 보기 · 사업 A 원문')).toBeUndefined();
    expect(find(tree, node => node.type === 'textarea')?.props.value).toBe('사업 B 문안');
  });

  it('저장 성공 후 초안을 지우고 서버가 돌려준 문안을 표시한다', async () => {
    const original = data('import-a', '서버 원문');
    const serverData = data('import-a', '서버 원문');
    serverData.items[0].history = [{ id: 'saved', status: '수정 중', text: '정규화된 서버 문안', outcome_state: '관측됨' } as NoteReview];
    vi.mocked(saveNoteReviewAction).mockResolvedValue({ success: true, data: serverData });
    let tree = render('project-a', original);
    textarea(tree).props.onChange({ target: { value: '저장 전 문안' } });
    tree = render('project-a', original);
    reason(tree).props.onChange({ target: { value: '저장 사유' } });
    tree = render('project-a', original);
    button(tree, '수정 중').props.onClick();
    await hooks.pending;
    tree = render('project-a', original);
    expect(textarea(tree).props.value).toBe('정규화된 서버 문안');
    expect(reason(tree).props.value).toBe('');
  });
});

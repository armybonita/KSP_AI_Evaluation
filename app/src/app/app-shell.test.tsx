import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';

const shellHooks = vi.hoisted(() => ({ pathname: '/projects', states: [] as unknown[], index: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = shellHooks.index++;
      if (!(index in shellHooks.states)) shellHooks.states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [shellHooks.states[index], (value: unknown) => { shellHooks.states[index] = value; }];
    },
    useEffect: () => undefined,
  };
});
vi.mock('next/navigation', () => ({ usePathname: () => shellHooks.pathname }));
vi.mock('./projects/actions', () => ({ getProjectsAction: vi.fn() }));
vi.mock('./projects/[projectId]/navigation-actions', () => ({ getProjectNavigationAction: vi.fn() }));

describe('사업 선택 복원 전 단계 줄', () => {
  beforeEach(() => { shellHooks.pathname = '/projects'; shellHooks.states.length = 0; shellHooks.index = 0; });

  it('기억된 사업의 확인 전에는 잠금 대신 자리를 표시한다', () => {
    const markup = renderToStaticMarkup(<AppShell role="평가팀" login="tester"><main>본문</main></AppShell>);
    for (const id of ['path', 'documents', 'review', 'report']) {
      expect(markup).toContain(`data-testid="main-menu-placeholder-${id}"`);
      expect(markup).not.toContain(`data-testid="main-menu-${id}"`);
    }
    expect(markup).not.toContain('PDM 필요');
  });

  it('같은 마운트에서 사업 경로가 바뀌면 이전 사업명을 표시하지 않는다', () => {
    shellHooks.pathname = '/projects/project-a/review';
    shellHooks.index = 0;
    AppShell({ role: '평가팀', login: 'tester', children: <main /> });
    shellHooks.states[2] = { projectId: 'project-a', name: '가상 사업 A' };

    shellHooks.pathname = '/projects/project-b/review';
    shellHooks.index = 0;
    const tree = AppShell({ role: '평가팀', login: 'tester', children: <main /> });
    const selectedProject = find(tree, node => node.props?.['data-testid'] === 'selected-project');
    expect(selectedProject?.props.children).toBe('사업');
    expect(selectedProject?.props.children).not.toContain('가상 사업 A');
  });
});

function find(node: any, predicate: (node: any) => boolean): any {
  if (node == null || typeof node !== 'object') return undefined;
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

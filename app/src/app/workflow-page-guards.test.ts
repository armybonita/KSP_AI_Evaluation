import { afterEach, describe, expect, it, vi } from 'vitest';
import * as access from '@/lib/workflow-access';

vi.mock('@/server/project-visibility', () => ({ assertProjectVisibleToCurrentViewer: vi.fn() }));
vi.mock('@/server/project-pdm', () => ({ isProjectPdmRegistered: vi.fn(() => true) }));
vi.mock('@/server/viewer', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/viewer')>(),
  currentViewer: vi.fn(async () => ({ kind: 'member', login: 'test', role: '평가팀' })),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...await importOriginal<typeof import('next/navigation')>(),
  notFound: () => { throw new Error('not found'); },
  redirect: (href: string) => { throw new Error(`redirect:${href}`); },
}));

afterEach(() => vi.restoreAllMocks());

describe('실제 단계 페이지의 공용 접근 가드', () => {
  it('각 페이지가 자신의 화면 이름으로 가드를 호출한다', async () => {
    const pages = [
      ['toc', (await import('./projects/[projectId]/toc/page')).default],
      ['documents', (await import('./projects/[projectId]/documents/page')).default],
      ['review', (await import('./projects/[projectId]/review/page')).default],
      ['report', (await import('./projects/[projectId]/report/page')).default],
      ['result', (await import('./projects/[projectId]/result/page')).default],
    ] as const;
    const guardReached = new Error('page guard reached');
    const guard = vi.spyOn(access, 'canAccessWorkflowScreen').mockImplementation(() => { throw guardReached; });
    for (const [screen, page] of pages) {
      guard.mockClear();
      await expect(page({ params: Promise.resolve({ projectId: 'p1' }) })).rejects.toBe(guardReached);
      expect(guard).toHaveBeenCalledExactlyOnceWith({ kind: 'member', login: 'test', role: '평가팀' }, screen);
    }
  });

  it('가드가 거부하면 각 페이지에서 접근을 실제로 차단한다', async () => {
    const pages = [
      ['toc', (await import('./projects/[projectId]/toc/page')).default],
      ['documents', (await import('./projects/[projectId]/documents/page')).default],
      ['review', (await import('./projects/[projectId]/review/page')).default],
      ['report', (await import('./projects/[projectId]/report/page')).default],
      ['result', (await import('./projects/[projectId]/result/page')).default],
    ] as const;
    const guard = vi.spyOn(access, 'canAccessWorkflowScreen').mockReturnValue(false);
    for (const [screen, page] of pages) {
      guard.mockClear();
      const result = page({ params: Promise.resolve({ projectId: 'p1' }) });
      if (screen === 'documents') {
        const denied = await result;
        expect(denied?.type).toBe('main');
        expect(denied?.props.role).toBe('status');
        expect(denied?.props.children).toBe('자료 등록 권한이 없습니다.');
      } else {
        await expect(result).rejects.toThrow('not found');
      }
      expect(guard).toHaveBeenCalledExactlyOnceWith({ kind: 'member', login: 'test', role: '평가팀' }, screen);
    }
  });

  it('옛 온톨로지 주소는 ToC 가드에 따라 그래프 또는 결과로 보낸다', async () => {
    const page = (await import('./projects/[projectId]/ontology/page')).default;
    const guard = vi.spyOn(access, 'canAccessWorkflowScreen');
    for (const [allowed, destination] of [[true, '/projects/p1/toc?view=graph'], [false, '/projects/p1/result']] as const) {
      guard.mockReturnValue(allowed);
      guard.mockClear();
      await expect(page({ params: Promise.resolve({ projectId: 'p1' }) })).rejects.toThrow(`redirect:${destination}`);
      expect(guard).toHaveBeenCalledExactlyOnceWith({ kind: 'member', login: 'test', role: '평가팀' }, 'toc');
    }
  });
});

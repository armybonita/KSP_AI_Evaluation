import { canAccessWorkflowScreen, roleCanAccessWorkflowScreen } from '@/lib/workflow-access';
import { describe, expect, it } from 'vitest';
import {
  activeWorkflowMenu,
  projectCardHref,
  projectTabIdsForRole,
  visibleWorkflowMenus,
  workflowNextAction,
} from './workflow-navigation';

describe('사업 다섯 단계 탐색', () => {
  it('주 메뉴와 성과 경로 하위 탭을 기존 역할 규칙대로 보여 준다', () => {
    expect(visibleWorkflowMenus('기획팀').map((menu) => menu.id)).toEqual(['projects', 'path', 'report']);
    for (const role of ['Admin', '평가팀', 'PO'] as const) {
      expect(visibleWorkflowMenus(role).map((menu) => menu.id)).toEqual([
        'projects', 'path', 'documents', 'review', 'report',
      ]);
    }

    expect(projectTabIdsForRole('기획팀')).toEqual(['report', 'result']);
    expect(projectTabIdsForRole('PO')).toEqual(['toc', 'ontology', 'report', 'portfolio', 'result']);
    expect(projectTabIdsForRole('평가팀')).toEqual(['toc', 'ontology', 'report', 'portfolio', 'result']);
    expect(projectTabIdsForRole('Admin')).toEqual(['toc', 'ontology', 'report', 'portfolio', 'result']);

    const tabScreens = { toc: 'toc', ontology: 'toc', report: 'report', result: 'result' } as const;
    for (const role of ['Admin', '평가팀', 'PO', '기획팀'] as const) {
      for (const tab of ['toc', 'ontology', 'report', 'result'] as const) {
        expect(projectTabIdsForRole(role).includes(tab), `${role} ${tab} tab`).toBe(roleCanAccessWorkflowScreen(role, tabScreens[tab]));
      }
      expect(projectTabIdsForRole(role).includes('portfolio'), `${role} portfolio tab`).toBe(['Admin', '평가팀', 'PO'].includes(role));
    }
  });

  it('사업 페이지 주소를 주 메뉴의 활성 단계에 맞춘다', () => {
    expect(activeWorkflowMenu('/projects')).toBe('projects');
    expect(activeWorkflowMenu('/projects/p1/toc?view=graph')).toBe('path');
    expect(activeWorkflowMenu('/projects/p1/portfolio')).toBe('path');
    expect(activeWorkflowMenu('/projects/p1/result')).toBe('path');
    expect(activeWorkflowMenu('/projects/p1/documents')).toBe('documents');
    expect(activeWorkflowMenu('/projects/p1/review')).toBe('review');
    expect(activeWorkflowMenu('/projects/p1/history')).toBe('review');
    expect(activeWorkflowMenu('/projects/p1/report')).toBe('report');
  });

  it('카드 본문은 PDM과 역할에 맞는 첫 화면을 연다', () => {
    expect(projectCardHref({ projectId: 'p1', hasPdm: false, role: '평가팀' })).toBe('/projects/p1/documents');
    expect(projectCardHref({ projectId: 'p1', hasPdm: true, role: '평가팀' })).toBe('/projects/p1/toc');
    expect(projectCardHref({ projectId: 'p1', hasPdm: true, role: '기획팀' })).toBe('/projects/p1/result');
    expect(projectCardHref({ projectId: 'p1', hasPdm: false, role: '기획팀' })).toBeNull();
    for (const role of ['PO', 'Admin'] as const) {
      expect(projectCardHref({ projectId: 'p1', hasPdm: false, role })).toBe('/projects/p1/documents');
      expect(projectCardHref({ projectId: 'p1', hasPdm: true, role })).toBe('/projects/p1/toc');
    }
  });

  it('다음 동작은 초기 ToC부터 보고서, 결과 ToC까지 정해진 순서를 따른다', () => {
    const common = { projectId: 'p1', role: '평가팀' as const, hasPdm: true };
    expect(workflowNextAction({ ...common, screen: 'toc' })).toEqual({
      label: '자료 등록', href: '/projects/p1/documents',
    });
    expect(workflowNextAction({ ...common, screen: 'documents' })).toEqual({
      label: '평가 검토(④ 산출물)', href: '/projects/p1/review',
    });
    expect(workflowNextAction({ ...common, screen: 'review', reviewStage: 0 })).toEqual({
      label: '⑤ 단기성과', reviewStage: 1,
    });
    expect(workflowNextAction({ ...common, screen: 'review', reviewStage: 1 })).toEqual({
      label: '⑥ 중·장기성과', reviewStage: 2,
    });
    expect(workflowNextAction({ ...common, screen: 'review', reviewStage: 2 })).toEqual({
      label: '⑦ 기여·제약요인', reviewStage: 3,
    });
    expect(workflowNextAction({ ...common, screen: 'review', reviewStage: 3 })).toEqual({
      label: '종료평가보고서 작성', href: '/projects/p1/report', prefixWithNext: false,
    });
    expect(workflowNextAction({ ...common, screen: 'report' })).toEqual({
      label: '결과 ToC', href: '/projects/p1/result', prefixWithNext: true,
    });
  });

  it('역할과 PDM별 다음 대상은 실제 화면 가드를 통과한다', () => {
    const screens = ['toc', 'documents', 'review', 'report', 'result'] as const;
    // Independent expected page role matrix: do not derive it from the navigation guard.
    const expectedAccess = {
      Admin: [true, true, true, true, true],
      '평가팀': [true, true, true, true, true],
      PO: [true, true, true, true, true],
      '기획팀': [false, false, false, true, true],
    } as const;
    for (const role of ['Admin', '평가팀', 'PO', '기획팀'] as const) {
      for (const [index, screen] of screens.entries()) {
        expect(canAccessWorkflowScreen({ kind: 'member', login: 'test', role }, screen)).toBe(expectedAccess[role][index]);
      }
      for (const hasPdm of [false, true]) {
        for (const screen of screens) {
          for (const reviewStage of [0, 1, 2, 3]) {
            const action = workflowNextAction({ projectId: 'p1', screen, role, hasPdm, reviewStage });
            if (!action) continue;
            const destination = action.reviewStage !== undefined ? 'review' : action.href?.split('/').at(-1);
            if (destination === 'portfolio') {
              expect(['Admin', '평가팀']).toContain(role);
            } else {
              expect(screens).toContain(destination);
              expect(expectedAccess[role][screens.indexOf(destination as typeof screens[number])], `${role} ${hasPdm} ${screen} → ${destination}`).toBe(true);
            }
            expect(hasPdm).toBe(true);
          }
        }
      }
    }
    for (const screen of ['documents', 'review', 'report'] as const) {
      expect(workflowNextAction({ projectId: 'p1', screen, role: 'PO', hasPdm: true, reviewStage: 3 })).not.toBeNull();
    }
  });

  it('PO의 보고서 다음 동작과 성과 경로 결과 탭이 같은 허용 화면을 가리킨다', () => {
    expect(projectTabIdsForRole('PO')).toContain('result');
    expect(workflowNextAction({ projectId: 'p1', screen: 'report', role: 'PO', hasPdm: true })).toEqual({
      label: '결과 ToC', href: '/projects/p1/result', prefixWithNext: true,
    });
  });
});

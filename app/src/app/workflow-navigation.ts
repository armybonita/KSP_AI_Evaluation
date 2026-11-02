import { roleCanAccessWorkflowScreen } from '@/lib/workflow-access';
import type { UserRole } from '@/server/viewer';

export const WORKFLOW_MENUS = [
  { id: 'projects', label: '사업 목록' },
  { id: 'path', label: '성과 경로' },
  { id: 'documents', label: '자료 등록' },
  { id: 'review', label: '평가 검토' },
  { id: 'report', label: '보고서·종합' },
] as const;

export type WorkflowMenuId = (typeof WORKFLOW_MENUS)[number]['id'];
export type WorkflowScreen = 'toc' | 'documents' | 'review' | 'report' | 'result';
export type ProjectTabId = 'toc' | 'ontology' | 'report' | 'portfolio' | 'result';

export function projectTabIdsForRole(role: UserRole): ProjectTabId[] {
  const tabs: ProjectTabId[] = ['toc', 'ontology', 'report', 'result'];
  if (roleCanAccessWorkflowScreen(role, 'review')) tabs.splice(3, 0, 'portfolio');
  return tabs.filter((tab) =>
    tab === 'portfolio'
      ? roleCanAccessWorkflowScreen(role, 'review')
      : roleCanAccessWorkflowScreen(role, tab === 'ontology' ? 'toc' : tab),
  );
}

export function visibleWorkflowMenus(role: UserRole) {
  if (role === '기획팀') return WORKFLOW_MENUS.filter((menu) => ['projects', 'path', 'report'].includes(menu.id));
  return WORKFLOW_MENUS;
}

export function activeWorkflowMenu(pathname: string): WorkflowMenuId {
  const path = pathname.split(/[?#]/, 1)[0];
  if (!path.startsWith('/projects/')) return 'projects';
  if (/\/(toc|result|ontology|portfolio)(\/|$)/.test(path)) return 'path';
  if (/\/documents(\/|$)/.test(path)) return 'documents';
  if (/\/(review|history)(\/|$)/.test(path)) return 'review';
  if (/\/report(\/|$)/.test(path)) return 'report';
  return 'projects';
}

export function workflowMenuHref(id: WorkflowMenuId, projectId: string, role: UserRole): string {
  if (id === 'projects') return '/projects';
  if (id === 'path') return `/projects/${projectId}/${role === '기획팀' ? 'result' : 'toc'}`;
  return `/projects/${projectId}/${id}`;
}

export function projectCardHref({ projectId, hasPdm, role }: {
  projectId: string;
  hasPdm: boolean;
  role: UserRole;
}): string | null {
  if (hasPdm && roleCanAccessWorkflowScreen(role, 'toc')) return `/projects/${projectId}/toc`;
  if (hasPdm && roleCanAccessWorkflowScreen(role, 'result')) return `/projects/${projectId}/result`;
  if (roleCanAccessWorkflowScreen(role, 'documents')) return `/projects/${projectId}/documents`;
  return null;
}

export interface WorkflowNextAction {
  label: string;
  href?: string;
  reviewStage?: number;
  prefixWithNext?: boolean;
}

const REVIEW_STAGE_LABELS = ['④ 산출물', '⑤ 단기성과', '⑥ 중·장기성과', '⑦ 기여·제약요인'] as const;

export function workflowNextAction({
  projectId,
  screen,
  role,
  hasPdm,
  reviewStage = 0,
}: {
  projectId: string;
  screen: WorkflowScreen;
  role: UserRole;
  hasPdm: boolean;
  reviewStage?: number;
}): WorkflowNextAction | null {
  if (!hasPdm) return null;

  if (screen === 'toc' && roleCanAccessWorkflowScreen(role, 'documents')) return { label: '자료 등록', href: `/projects/${projectId}/documents` };
  if (screen === 'documents') {
    if (roleCanAccessWorkflowScreen(role, 'review')) {
      return { label: '평가 검토(④ 산출물)', href: `/projects/${projectId}/review` };
    }
    return null;
  }
  if (screen === 'review' && roleCanAccessWorkflowScreen(role, 'review')) {
    const stage = Math.max(0, Math.min(3, Math.trunc(reviewStage)));
    if (stage < 3) return { label: REVIEW_STAGE_LABELS[stage + 1], reviewStage: stage + 1 };
    if (roleCanAccessWorkflowScreen(role, 'report')) {
      return { label: '종료평가보고서 작성', href: `/projects/${projectId}/report`, prefixWithNext: false };
    }
    return null;
  }
  if (screen === 'report' && roleCanAccessWorkflowScreen(role, 'result')) {
    return { label: '결과 ToC', href: `/projects/${projectId}/result`, prefixWithNext: true };
  }
  return null;
}

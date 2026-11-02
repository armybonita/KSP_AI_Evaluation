import type { UserRole, RoleCapability, Viewer } from '@/server/viewer';

export const ROLE_CAPABILITIES: Record<UserRole, readonly RoleCapability[]> = {
  Admin: ['upload', 'review', 'confirm', 'final', 'portfolio', 'admin', 'read'],
  '평가팀': ['upload', 'review', 'confirm', 'final', 'portfolio', 'read'],
  PO: ['upload', 'opinion', 'read'],
  '기획팀': ['read'],
};


export type GuardedScreen = 'toc' | 'documents' | 'review' | 'report' | 'result';

/** The role portion of each page's access guard. Project visibility is checked separately. */
export function canAccessWorkflowScreen(viewer: Viewer, screen: GuardedScreen): boolean {
  if (screen === 'report' || screen === 'result') return true;
  if (viewer.kind !== 'member') return false;
  const capabilities = ROLE_CAPABILITIES[viewer.role];
  return screen === 'documents' ? capabilities.includes('upload') : capabilities.includes('review') || capabilities.includes('opinion');
}

export function roleCanAccessWorkflowScreen(role: UserRole, screen: GuardedScreen): boolean {
  return canAccessWorkflowScreen({ kind: 'member', login: '', role }, screen);
}

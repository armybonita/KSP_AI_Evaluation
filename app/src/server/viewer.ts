import { ROLE_CAPABILITIES } from '@/lib/workflow-access';
import { headers } from 'next/headers';
import { getUserRoleAssignment } from '@/server/role-assignments';

export const USER_ROLES = ['Admin', '평가팀', 'PO', '기획팀'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export type RoleCapability = 'upload' | 'opinion' | 'review' | 'confirm' | 'final' | 'portfolio' | 'admin' | 'read';

export type Viewer =
  | { kind: 'member'; login: string; role: UserRole }
  | { kind: 'guest'; label: '손님 평가자' };


function roleMapFromEnvironment(raw: string | undefined): Record<string, UserRole> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, UserRole] =>
        typeof entry[0] === 'string' && USER_ROLES.includes(entry[1] as UserRole)
      )
    );
  } catch {
    return {};
  }
}

export function viewerFromHeaders(
  h: { get(name: string): string | null },
  env: { AIEAS_AUTH_MODE?: string; AIEAS_ROLE_MAP?: string } = process.env as {
    AIEAS_AUTH_MODE?: string;
    AIEAS_ROLE_MAP?: string;
  }
): Viewer {
  if (env.AIEAS_AUTH_MODE === 'proxy') {
    const login = h.get('x-auth-request-user')?.trim();
    if (!login) return { kind: 'guest', label: '손님 평가자' };
    // Role claims come only from server runtime configuration. Request parameters
    // and client supplied headers never select a role. Unmapped members use the
    // PoC's default evaluation-team assignment.
    // Database assignments persist across sessions and take precedence over
    // the runtime map, which only bootstraps identities not yet administered.
    const role = getUserRoleAssignment(login) ?? roleMapFromEnvironment(env.AIEAS_ROLE_MAP)[login] ?? '평가팀';
    return { kind: 'member', login, role };
  }

  // Local bypass is an explicit development/test mode. An absent or unknown
  // mode fails closed, including when the app is accidentally started without
  // its production proxy configuration.
  if (env.AIEAS_AUTH_MODE === 'local') return { kind: 'member', login: 'local', role: '평가팀' };
  return { kind: 'guest', label: '손님 평가자' };
}

export async function currentViewer(): Promise<Viewer> {
  try {
    return viewerFromHeaders(await headers());
  } catch {
    // Server actions can be called outside a Next request context in local tests.
    return viewerFromHeaders({ get: () => null });
  }
}

export function isGuestViewer(viewer: Viewer): boolean {
  return viewer.kind === 'guest';
}

export function viewerCan(viewer: Viewer, capability: RoleCapability): boolean {
  return viewer.kind === 'member' && ROLE_CAPABILITIES[viewer.role].includes(capability);
}

export function roleLabel(viewer: Viewer): string {
  return viewer.kind === 'member' ? viewer.role : viewer.label;
}

export const ROLE_BLOCKED_MESSAGE = '이 역할에는 이 작업 권한이 없습니다.';
export const GUEST_WRITE_BLOCKED_MESSAGE =
  '손님은 화면에 접근할 수 없습니다. 깃허브로 로그인해 주세요.';
export const GUEST_AI_BLOCKED_MESSAGE = GUEST_WRITE_BLOCKED_MESSAGE;

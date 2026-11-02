'use server';

import { currentViewer, ROLE_BLOCKED_MESSAGE, USER_ROLES, type UserRole } from '@/server/viewer';
import { listUserRoleAssignments, setUserRoleAssignment } from '@/server/role-assignments';

export async function listUserRolesAction() {
  const viewer = await currentViewer();
  if (viewer.kind !== 'member' || viewer.role !== 'Admin') return { success: false as const, error: ROLE_BLOCKED_MESSAGE, assignments: [] };
  return { success: true as const, assignments: listUserRoleAssignments() };
}

export async function setUserRoleAction(login: string, role: string) {
  const viewer = await currentViewer();
  if (viewer.kind !== 'member' || viewer.role !== 'Admin') return { success: false as const, error: ROLE_BLOCKED_MESSAGE };
  if (!USER_ROLES.includes(role as UserRole)) return { success: false as const, error: '역할을 확인해 주세요.' };
  try {
    setUserRoleAssignment(login, role as UserRole, viewer.login);
    return { success: true as const };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

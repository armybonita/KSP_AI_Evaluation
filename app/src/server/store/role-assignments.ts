import { getDatabase } from '@/server/store';
import type { UserRole } from '@/server/viewer';

export interface UserRoleAssignment {
  login: string;
  role: UserRole;
  assigned_by: string;
  updated_at: string;
}

export function getUserRoleAssignment(login: string): UserRole | undefined {
  const row = getDatabase().prepare('SELECT role FROM user_role_assignments WHERE login = ?').get(login) as { role: UserRole } | undefined;
  return row?.role;
}

export function listUserRoleAssignments(): UserRoleAssignment[] {
  return getDatabase().prepare('SELECT login, role, assigned_by, updated_at FROM user_role_assignments ORDER BY login COLLATE NOCASE').all() as UserRoleAssignment[];
}

export function setUserRoleAssignment(login: string, role: UserRole, assignedBy: string): void {
  const normalizedLogin = login.trim();
  if (!normalizedLogin || normalizedLogin.length > 160 || /[\u0000-\u001f\u007f]/.test(normalizedLogin)) {
    throw new Error('로그인 계정을 확인해 주세요.');
  }
  if (role !== 'Admin' && normalizedLogin.toLowerCase() === assignedBy.trim().toLowerCase()) throw new Error('자신의 Admin 권한은 제거할 수 없습니다.');
  const db = getDatabase();
  const current = getUserRoleAssignment(normalizedLogin);
  const admins = db.prepare("SELECT COUNT(*) AS count FROM user_role_assignments WHERE role = 'Admin'").get() as { count: number };
  if (role !== 'Admin' && current === 'Admin' && admins.count <= 1) throw new Error('마지막 Admin 권한은 제거할 수 없습니다.');
  db.prepare(`
    INSERT INTO user_role_assignments (login, role, assigned_by, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(login) DO UPDATE SET role = excluded.role, assigned_by = excluded.assigned_by, updated_at = excluded.updated_at
  `).run(normalizedLogin, role, assignedBy, new Date().toISOString());
}

import { notFound } from 'next/navigation';
import { currentViewer } from '@/server/viewer';
import { listUserRoleAssignments } from '@/server/role-assignments';
import { AdminUsersClient } from './users-client';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const viewer = await currentViewer();
  if (viewer.kind !== 'member' || viewer.role !== 'Admin') notFound();
  return <main className="mx-auto max-w-5xl p-6">
    <h1 className="text-2xl font-bold">사용자 역할 관리</h1>
    <p className="mt-2 text-sm text-gray-600">등록되지 않은 로그인 계정은 기본 평가팀으로 접근합니다. 저장한 역할은 모든 세션에 적용됩니다.</p>
    <AdminUsersClient initialAssignments={listUserRoleAssignments()} />
  </main>;
}

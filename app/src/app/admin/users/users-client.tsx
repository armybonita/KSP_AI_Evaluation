'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { UserRole } from '@/server/viewer';
import type { UserRoleAssignment } from '@/server/role-assignments';
import { setUserRoleAction } from './actions';

const ROLES: UserRole[] = ['Admin', '평가팀', 'PO', '기획팀'];

export function AdminUsersClient({ initialAssignments }: { initialAssignments: UserRoleAssignment[] }) {
  const router = useRouter();
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<UserRole>('평가팀');
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();

  function save(targetLogin: string, targetRole: UserRole) {
    startTransition(async () => {
      const result = await setUserRoleAction(targetLogin, targetRole);
      setMessage(result.success ? `${targetLogin} 계정 역할을 ${targetRole}(으)로 저장했습니다.` : result.error ?? '저장하지 못했습니다.');
      if (result.success) router.refresh();
    });
  }

  return <section className="mt-6 space-y-6">
    <form className="flex flex-wrap items-end gap-3 rounded border p-4" onSubmit={(event) => {
      event.preventDefault();
      save(login, role);
    }}>
      <label className="grid gap-1 text-sm">로그인 계정
        <input className="rounded border px-3 py-2" value={login} onChange={(event) => setLogin(event.target.value)} maxLength={160} required />
      </label>
      <label className="grid gap-1 text-sm">역할
        <select className="rounded border px-3 py-2" value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
          {ROLES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <button className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50" type="submit" disabled={pending}>계정 역할 저장</button>
    </form>
    <p role="status" aria-live="polite">{message}</p>
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead><tr><th className="border p-2">로그인 계정</th><th className="border p-2">역할</th><th className="border p-2">수정자</th><th className="border p-2">수정</th></tr></thead>
        <tbody>{initialAssignments.map((assignment) => <tr key={assignment.login}>
          <td className="border p-2">{assignment.login}</td>
          <td className="border p-2">{assignment.role}</td>
          <td className="border p-2">{assignment.assigned_by}</td>
          <td className="border p-2">
            {ROLES.map((value) => <button key={value} className="mr-1 rounded border px-2 py-1" type="button" disabled={pending || assignment.role === value} onClick={() => save(assignment.login, value)}>{value}</button>)}
          </td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

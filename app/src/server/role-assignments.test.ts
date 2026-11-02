import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { headers } from 'next/headers';
import { setUserRoleAction } from '@/app/admin/users/actions';
import { closeDatabase, openDatabase } from '@/server/store';
import { getUserRoleAssignment, setUserRoleAssignment } from './role-assignments';
import { viewerFromHeaders } from './viewer';

vi.mock('next/headers', () => ({ headers: vi.fn() }));

describe('지속 사용자 역할 지정', () => {
  beforeEach(() => {
    openDatabase(':memory:');
    vi.stubEnv('AIEAS_AUTH_MODE', 'proxy');
    vi.stubEnv('AIEAS_ROLE_MAP', JSON.stringify({ admin: 'Admin', account: '평가팀' }));
  });

  afterEach(() => {
    closeDatabase();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it('서버 설정의 기본 역할을 사용하고 저장된 계정 역할은 이후 세션에도 우선한다', () => {
    const roleForAccount = () => {
      const viewer = viewerFromHeaders(new Headers({ 'x-auth-request-user': 'account' }));
      return viewer.kind === 'member' ? viewer.role : undefined;
    };
    expect(roleForAccount()).toBe('평가팀');
    expect(getUserRoleAssignment('account')).toBeUndefined();
    setUserRoleAssignment('account', 'PO', 'admin');
    expect(roleForAccount()).toBe('PO');
  });

  it('자신과 마지막 저장 Admin의 권한 제거를 막는다', () => {
    expect(() => setUserRoleAssignment('admin', 'PO', 'admin')).toThrow();
    setUserRoleAssignment('other', 'Admin', 'admin');
    expect(() => setUserRoleAssignment('other', 'PO', 'admin')).toThrow();
    expect(getUserRoleAssignment('other')).toBe('Admin');
  });

  it('역할 저장 서버 액션은 Admin만 허용하고 허용 역할만 저장한다', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ 'x-auth-request-user': 'account' }) as never);
    expect(await setUserRoleAction('new-account', 'PO')).toMatchObject({ success: false });
    expect(getUserRoleAssignment('new-account')).toBeUndefined();

    vi.mocked(headers).mockResolvedValue(new Headers({ 'x-auth-request-user': 'admin' }) as never);
    expect(await setUserRoleAction('new-account', '기획팀')).toEqual({ success: true });
    expect(getUserRoleAssignment('new-account')).toBe('기획팀');
    expect(await setUserRoleAction('new-account', 'root')).toMatchObject({ success: false });
    expect(getUserRoleAssignment('new-account')).toBe('기획팀');
  });
});

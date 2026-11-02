import { expect, test } from './isolated-test';

test('Admin이 사용자의 역할을 저장하면 해당 사용자의 세션에 반영된다', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'admin' });
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: '사용자 역할 관리' })).toBeVisible();
  await page.getByLabel('로그인 계정').fill('role-e2e-user');
  await page.getByRole('combobox', { name: '역할', exact: true }).selectOption('기획팀');
  await page.getByRole('button', { name: '계정 역할 저장' }).click();
  await expect(page.getByRole('status')).toContainText('role-e2e-user 계정 역할을 기획팀');
  await expect(page.getByRole('row').filter({ hasText: 'role-e2e-user' })).toContainText('기획팀');
  await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'role-e2e-user' });
  await page.goto('/projects');
  await expect(page.locator('.app-role')).toHaveText('기획팀');
  await expect(page.getByTestId('main-menu-documents')).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: '사용자 역할 관리' })).toHaveCount(0);
});

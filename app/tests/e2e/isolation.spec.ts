import Database from 'better-sqlite3';
import { expect, test } from './isolated-test';

test('격리 확인용 사업은 이 시험의 서버에서 보인다', async ({ page }) => {
  const db = new Database(process.env.AIEAS_DB_PATH!, { fileMustExist: true });
  try {
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('e2e-isolation-proof', '격리 확인 가상 사업', '2026-01-01');
  } finally { db.close(); }
  await page.goto('/projects');
  await expect(page.getByTestId('project-card-e2e-isolation-proof')).toBeVisible();
});

test('다음 시험은 원래 시드로 시작하고 앞 시험 사업을 보지 못한다', async ({ page }) => {
  const db = new Database(process.env.AIEAS_DB_PATH!, { fileMustExist: true });
  try {
    expect(db.prepare('SELECT id FROM projects WHERE id = ?').get('e2e-isolation-proof')).toBeUndefined();
    expect(db.prepare('SELECT id FROM projects WHERE id = ?').get('proj-dev-seed')).toBeTruthy();
  } finally { db.close(); }
  await page.goto('/projects');
  await expect(page.getByTestId('project-card-e2e-isolation-proof')).toHaveCount(0);
  await expect(page.getByTestId('project-card-proj-dev-seed')).toBeVisible();
});

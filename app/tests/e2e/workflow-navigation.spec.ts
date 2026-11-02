import { expect, test } from './isolated-test';
import fs from 'node:fs/promises';
import path from 'node:path';

async function expectNextAtBottomRight(page: import('@playwright/test').Page) {
  const position = await page.getByTestId('workflow-action-row').evaluate((row) => {
    const button = row.querySelector('[data-testid="workflow-next"]');
    const previous = row.previousElementSibling;
    if (!button || !previous || row.parentElement?.lastElementChild !== row) return false;
    const r = row.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    return previous.getBoundingClientRect().bottom <= r.top + 1 && Math.abs(r.right - b.right) <= 2;
  });
  expect(position).toBe(true);
}

test('가상 사업에서 카드 진입부터 ⑩ 결과 ToC까지 단계별 다음 동작을 따른다', async ({ page }, testInfo) => {
  test.setTimeout(150000);
  const fixturesDir = path.resolve(__dirname, '../../fixtures');
  const shotsDir = process.env.AIEAS_WORKFLOW_SHOTS_DIR;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/projects');
  await page.getByTestId('project-name-input').fill('가상 단계 탐색 사업');
  await page.getByTestId('project-create-button').click();
  await expect(page.getByRole('heading', { name: '자료 등록' })).toBeVisible({ timeout: 15000 });

  const projectId = page.url().match(/\/projects\/([^/]+)\/documents/)?.[1];
  expect(projectId).toBeTruthy();
  const documentsUrl = `/projects/${projectId}/documents`;

  await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'planner' });
  await page.goto('/projects');
  const planningCard = page.getByTestId(`project-card-${projectId}`);
  await expect(planningCard.getByTestId(`project-card-open-${projectId}`)).toHaveAttribute('aria-disabled', 'true');
  await expect(planningCard).toContainText('PDM 필요');
  await planningCard.getByText('사업 유형 미등록', { exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.goto(documentsUrl);
  await expect(page.getByRole('status')).toContainText('자료 등록 권한이 없습니다');
  await expect(page.getByTestId('file-upload-input')).toHaveCount(0);
  await page.goto(`/projects/${projectId}/result`);
  await expect(page.getByRole('status')).toContainText('성과관리표가 없습니다');
  await expect(page).not.toHaveURL(/\/documents/);
  await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'evaluator' });

  // PDM 없는 카드 본문은 자료 등록으로 이어진다.
  await page.goto('/projects');
  const projectCard = page.getByTestId(`project-card-${projectId}`);
  await expect(projectCard.getByTestId(`project-card-open-${projectId}`)).toHaveAttribute('href', documentsUrl);
  await projectCard.getByText('사업 유형 미등록', { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${projectId}/documents$`));

  // 가상 PDM만 등록해 데이터가 비어 있는 검토 흐름도 만든다.
  await page.getByLabel('종료평가보고서 여부').selectOption('false');
  await page.getByTestId('file-upload-input').setInputFiles(path.join(fixturesDir, '02_pdm.docx'));
  const pdmRow = page.locator('tbody tr').filter({ hasText: '02_pdm.docx' });
  await expect(pdmRow).toBeVisible({ timeout: 30000 });
  const documentType = pdmRow.locator('[data-testid^="doc-type-select-"]');
  if (await documentType.inputValue() !== '성과관리표') await documentType.selectOption('성과관리표');
  const inclusion = pdmRow.locator('[data-testid^="doc-inclusion-select-"]');
  if (await inclusion.inputValue() !== '포함') await inclusion.selectOption('포함');
  await expect(page.getByTestId('workflow-next')).toHaveText('다음: 평가 검토(④ 산출물)→');

  // 기획팀은 PDM이 있으면 카드에서 결과로 들어가며 검토 직접 주소는 차단된다.
  await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'planner' });
  await page.goto('/projects');
  const planningPopulatedCard = page.getByTestId(`project-card-${projectId}`);
  await expect(planningPopulatedCard.getByTestId(`project-card-open-${projectId}`)).toHaveAttribute('href', `/projects/${projectId}/result`);
  await planningPopulatedCard.getByTestId(`project-card-open-${projectId}`).click();
  await expect(page).toHaveURL(new RegExp(`${projectId}/result$`));
  await expect(page.getByRole('heading', { name: '결과 ToC' })).toBeVisible();
  const reviewResponse = await page.goto(`/projects/${projectId}/review`);
  expect(reviewResponse?.status()).toBe(404);
  await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'evaluator' });

  // PDM이 생긴 뒤 카드 본문은 초기 ToC로 열린다.
  await page.goto('/projects');
  const populatedCard = page.getByTestId(`project-card-${projectId}`);
  await expect(populatedCard.getByTestId(`project-card-open-${projectId}`)).toHaveAttribute('href', `/projects/${projectId}/toc`);
  await populatedCard.getByText('사업 유형 미등록', { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${projectId}/toc$`));
  await expect(page.getByRole('heading', { name: '초기 ToC' })).toBeVisible();

  const workflowNav = page.getByRole('navigation', { name: '주 메뉴' });
  await expect(workflowNav.locator('[data-testid^="main-menu-"]')).toHaveCount(5);
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const rowYs = await workflowNav.locator('[data-testid^="main-menu-"]').evaluateAll((items) =>
      items.map((item) => Math.round(item.getBoundingClientRect().top)),
    );
    expect(new Set(rowYs).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const screenshotPath = shotsDir
      ? path.join(shotsDir, `workflow-${width}.png`)
      : testInfo.outputPath(`workflow-${width}.png`);
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath });
    await page.getByTestId('workflow-next').scrollIntoViewIfNeeded();
    await page.screenshot({ path: shotsDir ? path.join(shotsDir, `workflow-${width}-bottom.png`) : testInfo.outputPath(`workflow-${width}-bottom.png`) });
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  await expect(page.getByTestId('workflow-next')).toHaveText('다음: 자료 등록→');
  await expectNextAtBottomRight(page);
  await page.getByTestId('workflow-next').click();
  await expect(page).toHaveURL(new RegExp(`${projectId}/documents$`));
  await expect(page.getByTestId('workflow-next')).toHaveText('다음: 평가 검토(④ 산출물)→');
  await expectNextAtBottomRight(page);
  await page.getByTestId('workflow-next').click();
  await expect(page).toHaveURL(new RegExp(`${projectId}/review$`));

  // 자료 등록 직후 노트가 비어 있어도 다음 동작 영역은 유지된다.
  await expect(page.getByRole('region', { name: '온톨로지 노트 검토' })).toHaveCount(0);
  const actionRow = page.getByTestId('workflow-action-row');
  await expect(actionRow).toBeVisible();
  await expect(page.getByTestId('workflow-next')).toHaveText('다음: ⑤ 단기성과→');
  const rowIsAfterReviewBody = await actionRow.evaluate((row) => {
    const reviewBody = row.parentElement?.querySelector('main');
    return Boolean(reviewBody && row.getBoundingClientRect().top >= reviewBody.getBoundingClientRect().bottom);
  });
  expect(rowIsAfterReviewBody).toBe(true);

  // 실제 자료 분석 경로로 가상 AI 응답을 저장하고 검토로 이동한다.
  await page.goto(`/projects/${projectId}/ontology`);
  await page.getByRole('button', { name: '올린 자료에서 만들기' }).click();
  await expect(page.getByText(/완료 · 점 .* 문서 성공/)).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('아직 가져온 온톨로지가 없습니다. 가상 사업을 선택해 가져오기를 실행하세요.')).toHaveCount(0);

  await page.goto(`/projects/${projectId}/review`);
  const noteReview = page.getByRole('region', { name: '온톨로지 노트 검토' });
  await expect(noteReview).toBeVisible();
  const stageTabs = [0, 1, 2, 3].map((stage) => noteReview.getByTestId(`note-stage-${stage}`));
  const next = page.getByTestId('workflow-next');

  await expect(stageTabs[0]).toHaveAttribute('aria-pressed', 'true');
  await expect(noteReview.getByRole('button', { name: /가상산출물A/ })).toBeVisible();
  await noteReview.getByRole('button', { name: /가상산출물A/ }).click();
  await expect(next).toHaveText('다음: ⑤ 단기성과→');
  await noteReview.getByLabel('판단 문안').fill('가상 ④ 고친 문안');
  await noteReview.getByLabel('사유').fill('가상 ④ 단계의 사유');
  await noteReview.getByLabel('오류 유형').selectOption('기타');
  await noteReview.getByRole('button', { name: /가상 다른 산출물 노트/ }).click();
  await expect(noteReview.getByLabel('판단 문안')).not.toHaveValue('가상 ④ 고친 문안');
  await expect(noteReview.getByLabel('사유')).toHaveValue('');
  await expect(noteReview.getByLabel('오류 유형')).toHaveValue('');
  await noteReview.getByRole('button', { name: /가상산출물A/ }).click();
  await expect(noteReview.getByLabel('판단 문안')).toHaveValue('가상 ④ 고친 문안');
  await next.click();
  await expect(stageTabs[1]).toHaveAttribute('aria-pressed', 'true');
  await expect(noteReview.getByRole('button', { name: /가상 단기 다음 노트/ })).toBeVisible();
  await expect(noteReview.getByLabel('사유')).toHaveValue('');
  await expect(noteReview.getByLabel('오류 유형')).toHaveValue('');
  await expect(noteReview.getByLabel('판단 문안')).not.toHaveValue('가상 ④ 고친 문안');
  await stageTabs[0].click();
  await expect(noteReview.getByLabel('판단 문안')).toHaveValue('가상 ④ 고친 문안');
  await expect(noteReview.getByLabel('사유')).toHaveValue('가상 ④ 단계의 사유');
  await expect(noteReview.getByLabel('오류 유형')).toHaveValue('기타');
  await stageTabs[1].click();
  await expect(next).toHaveText('다음: ⑥ 중·장기성과→');

  await next.click();
  await expect(stageTabs[2]).toHaveAttribute('aria-pressed', 'true');
  await expect(noteReview.getByRole('button', { name: /가상 중기 다음 노트/ })).toBeVisible();
  await expect(next).toHaveText('다음: ⑦ 기여·제약요인→');

  await next.click();
  await expect(stageTabs[3]).toHaveAttribute('aria-pressed', 'true');
  await expect(noteReview.getByRole('region', { name: '기여요인 목록' })).toContainText('가상 기여 다음 노트');
  await expect(noteReview.getByRole('region', { name: '제약요인 목록' })).toContainText('가상 제약 다음 노트');
  await expect(next).toHaveText('종료평가보고서 작성→');
  await next.click();

  await expect(page).toHaveURL(new RegExp(`${projectId}/report$`));
  await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'owner' });
  await page.goto(`/projects/${projectId}/report`);
  const resultNext = page.getByTestId('workflow-next');
  await expect(resultNext).toHaveText('다음: 결과 ToC→');
  await expectNextAtBottomRight(page);
  await resultNext.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shotsDir ? path.join(shotsDir, 'report-bottom.png') : testInfo.outputPath('report-bottom.png') });
  await resultNext.click();
  await expect(page).toHaveURL(new RegExp(`${projectId}/result$`));
  await expect(page.getByRole('heading', { name: '결과 ToC' })).toBeVisible();
  await expect(page.getByTestId('project-tab-result')).toHaveAttribute('aria-selected', 'true');

  await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'owner' });
  await page.goto('/projects');
  await page.getByTestId(`project-card-open-${projectId}`).click();
  await expect(page).toHaveURL(new RegExp(`${projectId}/toc$`));
  await page.getByTestId('workflow-next').click();
  await expect(page).toHaveURL(new RegExp(`${projectId}/documents$`));
  await page.getByTestId('workflow-next').click();
  await expect(page).toHaveURL(new RegExp(`${projectId}/review$`));
  for (const label of ['⑤ 단기성과', '⑥ 중·장기성과', '⑦ 기여·제약요인']) {
    await expect(page.getByTestId('workflow-next')).toContainText(label);
    await page.getByTestId('workflow-next').click();
  }
  await expect(page.getByTestId('workflow-next')).toContainText('종료평가보고서 작성');
  await page.getByTestId('workflow-next').click();
  await expect(page).toHaveURL(new RegExp(`${projectId}/report$`));
  await page.getByTestId('workflow-next').click();
  await expect(page).toHaveURL(new RegExp(`${projectId}/result$`));
  await expect(page.getByRole('heading', { name: '결과 ToC' })).toBeVisible();
});

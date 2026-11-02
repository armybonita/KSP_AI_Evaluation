import { expect, test } from './isolated-test';
import { openExistingDatabaseForWrite } from '../../src/server/store/db';
import { replaceProjectOntology } from '../../src/server/store/ontology';

test('TC-ODA-EV-PJ-002 사업 검색이 카드와 0건 안내를 바꾼다', async ({ page }) => {
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: '사업 목록' })).toBeVisible();
  await page.getByLabel('사업명·국가·부처 검색').fill('존재하지않는가상사업');
  await expect(page.getByTestId('empty-filtered-projects')).toBeVisible();
  await page.getByLabel('사업명·국가·부처 검색').clear();
  await expect(page.getByTestId('projects-cards')).toBeVisible();
});

test('TC-ODA-EV-PJ-005 초기 ToC 계획과 실제 다섯 칸이 보인다', async ({ page }) => {
  // Each test starts from the seed DB, which has no ontology import.
  const db = openExistingDatabaseForWrite(process.env.AIEAS_DB_PATH!);
  try {
    replaceProjectOntology('proj-dev-seed', {
      code: 'e2e-factors', projectName: '가상 사업', project: {}, sources: {}, snippets: {},
      nodes: { enabler: { type: 'enabler', title: '가상 기여요인' }, constraint: { type: 'constraint', title: '가상 제약요인' } },
      edges: [], reports: {}, report_status: {}, issues: [],
    }, '가상 시험', db);
  } finally { db.close(); }
  await page.goto('/projects/proj-dev-seed/toc');
  const table = page.getByRole('table', { name: '초기 목차 PDM 계획 기준선 5열' });
  await expect(table).toBeVisible();
  await expect(table.locator('thead th > div > span:first-child')).toHaveText(['활동', '산출물', '단기성과', '중/장기성과', '영향']);
  await expect(table.locator('thead th').getByText('→', { exact: true })).toHaveCount(4);
  await expect(table.getByText('실제', { exact: true })).toHaveCount(5);
  await expect(table.locator('tbody td').nth(4)).toContainText('대국민 행정 편의 증진');
  await expect(page.getByText('기여요인', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('제약요인', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('toc-factor-name')).toHaveCount(2);
  await expect(page.getByTestId('toc-factor-name').nth(0)).toHaveText(/\S+/);
  await expect(page.getByTestId('toc-factor-name').nth(1)).toHaveText(/\S+/);
  await expect(page.getByTestId('toc-factor-status')).toHaveText(['미검토', '미검토']);
  await page.getByRole('button', { name: '상세 그래프' }).click();
  await expect(page.getByRole('heading', { name: '상세 그래프' })).toBeVisible();
});

test('TC-ODA-EV-PJ-003 PDM 없는 새 사업은 초기 ToC 진입이 잠긴다', async ({ page }) => {
  await page.goto('/projects');
  await page.getByTestId('project-name-input').fill('가상 잠금 사업');
  await page.getByTestId('project-create-button').click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/documents/);
  const projectId = page.url().match(/\/projects\/([^/]+)\/documents/)?.[1];
  expect(projectId).toBeTruthy();
  await page.goto('/projects');
  await expect(page.getByTestId(`open-toc-locked-${projectId}`)).toBeDisabled();
  await page.goto(`/projects/${projectId}/toc`);
  await expect(page).toHaveURL(/\/documents\?pdm=required/);
});

test('TC-ODA-EV-PJ-006 사업 카드에서 등록된 PDM·국문 PCP 자료를 바로 열 수 있다', async ({ page }) => {
  await page.goto('/projects');
  const pdmDoc = page.getByTestId('project-doc-pdm-proj-dev-seed');
  await expect(pdmDoc).toBeVisible();
  await expect(pdmDoc).toContainText('02_pdm.docx');
  const pcpDoc = page.getByTestId('project-doc-pcp-proj-dev-seed');
  await expect(pcpDoc).toBeVisible();
  await expect(pcpDoc).toContainText('00_korean_pcp.pdf');

  // PDM 문서 열기
  await pdmDoc.getByRole('link', { name: '열기' }).click();
  await expect(page).toHaveURL(/\/projects\/proj-dev-seed\/documents\?docId=doc-02_pdm\.docx/);
  await expect(page.getByTestId('doc-row-doc-02_pdm.docx')).toBeVisible();

  // 목록으로 돌아와 국문 PCP 문서 열기
  await page.goto('/projects');
  const pcpDocAgain = page.getByTestId('project-doc-pcp-proj-dev-seed');
  await pcpDocAgain.getByRole('link', { name: '열기' }).click();
  await expect(page).toHaveURL(/\/projects\/proj-dev-seed\/documents\?docId=doc-korean-pcp/);
  await expect(page.getByTestId('doc-row-doc-korean-pcp')).toBeVisible();
});

test('TC-ODA-EV-PJ-007 초기 ToC 상단에 PDM 성과표와 성과관리 최종결과가 표시된다', async ({ page }) => {
  await page.goto('/projects/proj-dev-seed/toc');
  const outcomeSection = page.getByTestId('outcome-final-results-section');
  await expect(outcomeSection).toBeVisible();
  const table = outcomeSection.getByRole('table', { name: 'PDM 성과표 및 성과관리 최종결과 표' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader', { name: '단계' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: '지표명' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'PDM 성과표 (계획)' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: '성과관리 최종결과' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: '이동' })).toBeVisible();

  // 5개 단계 행 확인 (활동, 산출물, 단기, 중장기, 영향)
  const stages = ['활동', '산출물', '단기', '중장기', '영향'];
  for (const stage of stages) {
    await expect(table.getByRole('cell', { name: stage, exact: true })).toBeVisible();
  }

  // 바로가기 링크 (검토, 보고서) 확인
  const reviewLink = table.getByRole('link', { name: '검토' }).first();
  await expect(reviewLink).toBeVisible();
  await expect(reviewLink).toHaveAttribute('href', /\/projects\/proj-dev-seed\/review\?indicatorId=/);

  const reportLink = table.getByRole('link', { name: '보고서' }).first();
  await expect(reportLink).toBeVisible();
  await expect(reportLink).toHaveAttribute('href', /\/projects\/proj-dev-seed\/report#achievement-row-/);
});



test('TC-COM-001 메뉴 이동 후 선택 사업과 상태를 유지한다', async ({ page }) => {
  test.setTimeout(60000);
  const base = '/projects/proj-dev-seed';
  await page.goto(`${base}/ontology`);
  await page.getByLabel('가상 사업').selectOption('VA01');
  await page.getByRole('button', { name: '가져오기', exact: true }).click();
  await expect(page.getByRole('button', { name: '가져오기', exact: true })).toBeEnabled();
  await page.goto(`${base}/review`);
  const section = page.getByRole('region', { name: '온톨로지 노트 검토' });
  const item = section.getByRole('button', { name: /가상산출물A/ });
  await item.click();
  await section.getByLabel('사유').fill('가상 자료 보완');
  await section.getByLabel('오류 유형').selectOption('근거 부족');
  await section.getByRole('button', { name: '보완 필요', exact: true }).click();
  await expect(item).toContainText('보완 필요');

  const header = page.getByTestId('selected-project');
  await expect(header).not.toHaveText(/^(사업|사업 목록)$/);
  const projectName = await header.innerText();
  const menu = async (id: string, url: RegExp) => {
    await page.getByTestId(`main-menu-${id}`).click();
    await expect(page).toHaveURL(url);
    await expect(header).toHaveText(projectName);
    await expect(page.getByTestId(`main-menu-${id}`)).toHaveAttribute('aria-current', 'page');
  };
  const stage = async (index: number) => {
    const tab = section.getByTestId(`note-stage-${index}`);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-pressed', 'true');
    await expect(header).toHaveText(projectName);
  };
  await stage(2);
  await menu('documents', /proj-dev-seed\/documents/);
  await menu('report', /proj-dev-seed\/report/);
  await menu('review', /proj-dev-seed\/review/);
  await stage(3);
  await stage(1);
  await menu('projects', /\/projects$/);
  await menu('path', /proj-dev-seed\/toc/);
  await menu('review', /proj-dev-seed\/review/);
  await stage(0);
  await expect(item).toContainText('보완 필요');
  await page.reload();
  await expect(header).toHaveText(projectName);
  await expect(item).toContainText('보완 필요');
});

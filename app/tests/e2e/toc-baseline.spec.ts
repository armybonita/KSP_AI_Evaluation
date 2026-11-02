import { test, expect } from './isolated-test';

test.describe('S3 초기 ToC 및 기준 지표 선택 E2E 시험 (FE-05, FE-06, FE-17, RQ-07, RQ-08, D07, D09, D32, UC-03)', () => {
  const SEED_PROJECT_ID = 'proj-dev-seed';

  test('성과관리표가 없는 사업은 S3 에 안내 문구와 S2 링크가 보인다 (AC 4, SP §S3 line 125)', async ({
    page,
  }) => {
    // 1. S1 에서 성과관리표 없는 새 사업 생성
    await page.goto('/projects');
    const projectName = `E2E PDM없는사업 ${Date.now()}`;
    await page.getByTestId('project-name-input').fill(projectName);
    await page.getByTestId('project-create-button').click();

    // S2 로 이동 완료 대기
    await expect(page.getByRole('heading', { name: '자료 등록' })).toBeVisible({ timeout: 15000 });
    const currentUrl = page.url();
    const projectIdMatch = currentUrl.match(/\/projects\/([^/]+)\/documents/);
    expect(projectIdMatch).not.toBeNull();
    const newProjectId = projectIdMatch![1];

    // PDM이 없으면 초기 ToC 직접 주소도 등록 화면으로 되돌아간다.
    await page.goto(`/projects/${newProjectId}/toc`);
    await expect(page).toHaveURL(`/projects/${newProjectId}/documents?pdm=required`);
    await expect(page.getByRole('heading', { name: '자료 등록' })).toBeVisible();
    const pathMenu = page.getByTestId('main-menu-path');
    await expect(pathMenu).toHaveAttribute('aria-disabled', 'true');
    await expect(pathMenu).toHaveJSProperty('tagName', 'SPAN');
  });

  test('S3 성과 경로 계층 표시 및 항목마다 출처로 이동 (RQ-07, D07, AC 1)', async ({ page }) => {
    // 1. 시드 프로젝트의 초기 ToC (S3) 접속
    await page.goto(`/projects/${SEED_PROJECT_ID}/toc`);
    await expect(page.getByRole('heading', { name: '초기 ToC' })).toBeVisible();

    // 단순 ToC 계획은 저장된 단계별 계획으로 표시하고, 확정된 실제만 기등록한다.
    const simpleToc = page.getByRole('table', { name: '초기 목차 PDM 계획 기준선 5열' });
    await expect(simpleToc).toBeVisible();
    for (const level of ['활동', '산출물', '단기성과', '중/장기성과', '영향']) {
      await expect(simpleToc.getByRole('columnheader', { name: new RegExp(level) })).toBeVisible();
    }
    const actualState = simpleToc.locator('[data-testid^="actual-unreviewed-"], [data-testid^="actual-items-"]');
    expect(await actualState.count()).toBe(5);
    await expect(simpleToc.locator('[aria-hidden="true"]', { hasText: '→' })).toHaveCount(4);

    // 2. 성과 경로 계층 트리 및 5개 단계 존재 확인
    const tree = page.getByRole('tree');
    await expect(tree).toBeVisible();

    const expectedLevels = ['영향', '중/장기성과', '단기성과', '산출물', '활동'];
    for (const level of expectedLevels) {
      await expect(page.getByRole('treeitem', { name: new RegExp(`^${level}:`) }).first()).toBeVisible();
    }

    // 3. 영향 항목의 [출처 ▸] 클릭 시 S2 문서 미리보기 문단으로 이동
    const impactItem = page.getByRole('treeitem', { name: /^영향:/ });
    const sourceLink = impactItem.locator('[data-testid^="source-link-"]');
    await expect(sourceLink).toBeVisible();
    await expect(sourceLink).toContainText('출처 ▸');

    await sourceLink.click();

    // S2 로 이동하여 02_pdm.docx 선택 및 ¶3 문단이 강조 표시됨을 확인
    await expect(page).toHaveURL(new RegExp(`/projects/${SEED_PROJECT_ID}/documents\\?docId=.*&location=%C2%B63`));
    await expect(page.getByTestId('paragraph-preview-panel')).toBeVisible();

    // 강조 표시된 문단 확인
    const highlightedPara = page.locator('[data-highlighted="true"]').first();
    await expect(highlightedPara).toBeVisible();
    await expect(highlightedPara).toContainText('¶3');
    await expect(highlightedPara).toContainText('대국민 전자정부 서비스 체감 만족도');
  });

  test('충돌 경고 → 기준 미선택(S4) → 기준 선택(S3) → 새로 고침 유지 → S4 "기준" 표시 (RQ-08, D32, AC 2, AC 3)', async ({
    page,
  }) => {
    // -------------------------------------------------------------
    // 1. 기준 미선택 상태에서 S4 확인 (D32, AC 3)
    // -------------------------------------------------------------
    await page.goto(`/projects/${SEED_PROJECT_ID}/review`);
    await expect(page.getByRole('heading', { name: 'AI 제안 검토' })).toBeVisible();

    // 충돌이 있는 지표(대국민 행정 편의 증진 / ind-conflict) 선택
    const conflictIndicatorButton = page.locator('button', { hasText: '대국민 행정 편의 증진' });
    await expect(conflictIndicatorButton).toBeVisible();
    await conflictIndicatorButton.click();

    // S4 지표 머리에 "기준 미선택" 표시 (D32)
    const unselectedBadge = page.getByTestId('baseline-unselected-badge');
    await expect(unselectedBadge).toBeVisible();
    await expect(unselectedBadge).toHaveText('기준 미선택');

    // 판정 제안 전 안내 및 S3 링크 확인 (D32)
    const s3Notice = page.getByTestId('unselected-baseline-notice');
    await expect(s3Notice).toBeVisible();
    await expect(s3Notice).toContainText('지표 충돌이 있습니다. 초기 ToC에서 기준 지표를 먼저 선택하세요.');

    const linkToS3 = page.getByTestId('link-to-s3-from-notice');
    await expect(linkToS3).toBeVisible();

    // -------------------------------------------------------------
    // 2. S3 링크 클릭하여 초기 ToC 이동 (AC 3)
    // -------------------------------------------------------------
    await linkToS3.click();
    await expect(page).toHaveURL(`/projects/${SEED_PROJECT_ID}/toc`);
    await expect(page.getByRole('heading', { name: '초기 ToC' })).toBeVisible();

    // -------------------------------------------------------------
    // 3. 지표 충돌 함정 경고 확인 (AC 2: 80% 대 5점 척도 3.5점)
    // -------------------------------------------------------------
    const conflictWarning = page.locator('[data-testid^="conflict-warning-"]');
    await expect(conflictWarning).toBeVisible();
    await expect(conflictWarning).toContainText('지표 충돌: 사업계획서 "80%" ↔ 성과관리표 "5점 척도 3.5점"');

    // -------------------------------------------------------------
    // 4. 기준 지표 고르기 및 저장 (AC 2)
    // -------------------------------------------------------------
    const planRadio = page.getByTestId('baseline-radio-사업계획서');
    await expect(planRadio).toBeVisible();
    await planRadio.check();

    const saveBtn = page.locator('[data-testid^="save-baseline-button-"]');
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // 저장 뒤 "기준: 사업계획서" 확인
    const savedLabel = page.locator('[data-testid^="saved-baseline-label-"]');
    await expect(savedLabel).toBeVisible();
    await expect(savedLabel).toHaveText('기준: 사업계획서');

    // -------------------------------------------------------------
    // 5. 새로 고침 뒤에도 기준 선택 유지 확인 (AC 2)
    // -------------------------------------------------------------
    await page.reload();
    await expect(page.locator('[data-testid^="saved-baseline-label-"]')).toBeVisible();
    await expect(page.locator('[data-testid^="saved-baseline-label-"]')).toHaveText('기준: 사업계획서');

    // -------------------------------------------------------------
    // 6. S4 지표 머리에 "기준: (문서 이름)" 표시 확인 (AC 2)
    // -------------------------------------------------------------
    await page.goto(`/projects/${SEED_PROJECT_ID}/review`);
    await conflictIndicatorButton.click();

    // S4 지표 머리에 "기준: 사업계획서" 확인
    const baselineHeaderLabel = page.getByTestId('baseline-header-label');
    await expect(baselineHeaderLabel).toBeVisible();
    await expect(baselineHeaderLabel).toHaveText('기준: 사업계획서');

    // "기준 미선택" 배지와 안내는 더 이상 노출되지 않음
    await expect(page.getByTestId('baseline-unselected-badge')).not.toBeVisible();
    await expect(page.getByTestId('unselected-baseline-notice')).not.toBeVisible();
  });

  test('두 번째 충돌에서 다른 문서 저장 → 재동기화 → 라디오와 저장 표시 일치, 재선택 없이 저장해도 엉뚱한 값 안 됨 (#19 검수 4회차 2번)', async ({
    page,
  }) => {
    // 1. S3 초기 ToC (복수 충돌 사업) 이동
    await page.goto('/projects/proj-multi-conflict/toc');
    await expect(page.getByRole('heading', { name: '초기 ToC' })).toBeVisible();

    // 2. 두 충돌 컨테이너 확인
    const conflictContainers = page.locator('[data-testid^="conflict-container-"]');
    await expect(conflictContainers).toHaveCount(2);

    const secondContainer = conflictContainers.nth(1);
    await expect(secondContainer).toBeVisible();

    // 두 번째 충돌 내 라디오 확인: 사업계획서(05_other_project) vs 성과관리표
    const radios = secondContainer.locator('input[type="radio"]');
    await expect(radios).toHaveCount(2);
    const radioPlan2 = radios.nth(0);
    const radioPdm = radios.nth(1);

    // 두 번째 충돌에서 '다른 문서'(성과관리표) 라디오 선택
    await radioPdm.check();
    await expect(radioPdm).toBeChecked();
    await expect(radioPlan2).not.toBeChecked();

    // 두 번째 충돌의 저장 버튼 클릭
    const saveBtn2 = secondContainer.locator('button', { hasText: '저장' });
    await saveBtn2.click();

    // 3. 재동기화 후: 저장 표시 및 라디오 선택 상태 일치 확인
    const savedBadge2 = secondContainer.locator('[data-testid^="saved-baseline-label-"]');
    await expect(savedBadge2).toBeVisible();
    await expect(savedBadge2).toContainText('성과관리표');

    // 라디오 선택 상태가 성과관리표로 일치하게 유지됨 확인
    await expect(radioPdm).toBeChecked();
    await expect(radioPlan2).not.toBeChecked();

    // 4. 재선택 없이 저장 버튼 다시 클릭해도 엉뚱한 값(기본값인 첫 번째 문서)으로 바뀌지 않음
    await saveBtn2.click();
    await expect(savedBadge2).toBeVisible();
    await expect(savedBadge2).toContainText('성과관리표');
    await expect(radioPdm).toBeChecked();
    await expect(radioPlan2).not.toBeChecked();
  });
});

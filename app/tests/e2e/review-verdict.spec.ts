import { test, expect } from './isolated-test';

test.describe('S4 AI 제안 검토 화면 E2E 시험 (RQ-06, RQ-09, RQ-10, RQ-11, RQ-27, D28, D30)', () => {
  const PROJECT_ID = 'proj-dev-seed';
  const REVIEW_URL = `/projects/${PROJECT_ID}/review`;

  test.beforeEach(async ({ page }) => {
    await page.goto(REVIEW_URL);
    // 페이지 로드 완료 대기
    await expect(page.getByRole('heading', { name: 'AI 제안 검토' })).toBeVisible();
  });

  test('(d) 배지 글자가 다섯 상태 이름(실현, 추진 중, 기대, 미확인, 근거 충돌) 중 하나이다', async ({
    page,
  }) => {
    const validStatuses = ['실현', '추진 중', '기대', '미확인', '근거 충돌'];

    const badges = page.locator('[data-testid^="badge-"]');
    const count = await badges.count();
    expect(count).toBeGreaterThanOrEqual(5);

    const seenStatuses = new Set<string>();

    for (let i = 0; i < count; i++) {
      const badgeText = (await badges.nth(i).innerText()).trim();
      expect(validStatuses).toContain(badgeText);
      seenStatuses.add(badgeText);
    }

    // 다섯 가지 상태가 모두 존재하는지 확인
    for (const status of validStatuses) {
      expect(
        seenStatuses.has(status),
        `다섯 상태 중 '${status}' 상태 배지가 목록에 존재해야 함`
      ).toBe(true);
    }
  });

  test('(a) 근거 있는 지표를 고르면 근거 네 항목이 보이고 [원문 위치 열기]에 인용 문장이 든 문단이 보인다', async ({
    page,
  }) => {
    // 1. 근거 있는 지표(공무원 디지털 직무 교육, ind-activity) 선택
    await page.locator('[data-testid="indicator-item-ind-activity"]').click();

    // 선택된 지표 제목 확인
    await expect(page.locator('[data-testid="selected-indicator-name"]')).toHaveText(
      '공무원 디지털 직무 교육'
    );
    // 판정 배지 확인
    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('실현');

    // 2. 근거 카드 네 항목(인용, 문서 이름, 위치, 말한 사람) 확인 (RQ-10)
    const expectedQuote =
      '교육 훈련 실적: 핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.';

    await expect(page.locator('[data-testid="evidence-quote-0"]')).toContainText(
      expectedQuote
    );
    await expect(page.locator('[data-testid="evidence-doc-0"]')).toHaveText(
      '03_trip_report.pdf'
    );
    await expect(page.locator('[data-testid="evidence-loc-0"]')).toHaveText('2쪽 ¶2');
    await expect(page.locator('[data-testid="evidence-speaker-0"]')).toHaveText('수행기관');

    // 3. [원문 위치 열기] 버튼 클릭
    const toggleButton = page.locator('[data-testid="toggle-source-button-0"]');
    await expect(toggleButton).toHaveText('[원문 위치 열기]');
    await toggleButton.click();

    // 4. [원문 위치 열기] 패널에 인용 문장이 든 문단 및 앞·뒤 문단이 보이는지 확인
    await expect(page.locator('[data-testid="source-context-panel-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="target-paragraph-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="target-paragraph-0"]')).toContainText(
      expectedQuote
    );
    // 대상 문단의 앞 문단 및 뒤 문단도 보이는지 단언
    await expect(page.locator('[data-testid="prev-paragraph-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="next-paragraph-0"]')).toBeVisible();
  });

  test('(b) "근거 없는 판단" 지표는 "미확인"과 사유가 보인다', async ({ page }) => {
    // '근거 없는 판단' 함정 지표(디지털 법제 정비, ind-unsupported) 선택
    await page.locator('[data-testid="indicator-item-ind-unsupported"]').click();

    // 선택된 지표 제목 확인
    await expect(page.locator('[data-testid="selected-indicator-name"]')).toHaveText(
      '디지털 법제 정비'
    );

    // 판정 상태 확인: "미확인"
    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('미확인');

    // 사유 확인: "포함 문서에서 근거를 찾지 못함"
    const reasonBox = page.locator('[data-testid="unconfirmed-reason-box"]');
    await expect(reasonBox).toBeVisible();
    await expect(reasonBox).toContainText('포함 문서에서 근거를 찾지 못함');
  });

  test('(c) 스키마 위반 고정 응답 지표는 "미확인"+D47 한 줄 요약 및 [다시 시도]가 보이고 상세는 접힘 상태이다', async ({
    page,
  }) => {
    // 스키마 위반 고정 응답 지표(시스템 보안 체계 수립, ind-schema-violation) 선택
    await page.locator('[data-testid="indicator-item-ind-schema-violation"]').click();

    // 선택된 지표 제목 확인
    await expect(page.locator('[data-testid="selected-indicator-name"]')).toHaveText(
      '시스템 보안 체계 수립'
    );

    // 판정 상태 확인: "미확인"
    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('미확인');

    // D47: 오류 사유 한 줄 요약 및 [다시 시도] 버튼 확인 (원시 오류 여러 줄 출력 금지)
    const errorBox = page.locator('[data-testid="error-reason-box"]');
    await expect(errorBox).toBeVisible();

    const summaryText = page.locator('[data-testid="error-reason-summary"]');
    await expect(summaryText).toBeVisible();
    await expect(summaryText).toContainText('AI 출력 형식 오류');

    const retryButton = page.locator('[data-testid="retry-suggestion-button"]');
    await expect(retryButton).toBeVisible();
    await expect(retryButton).toHaveText('다시 시도');

    // 상세는 접힘 상태(details)
    const details = page.locator('[data-testid="error-reason-details"]');
    await expect(details).toBeVisible();

    // 접힌 상세를 클릭하여 펼치면 응답 본문 값 없이 안전한 스키마 오류가 표시된다
    await details.locator('summary').click();
    const errorText = page.locator('[data-testid="error-reason-text"]');
    await expect(errorText).toBeVisible();
    await expect(errorText).toContainText('AI 응답 스키마 검증 실패');
  });

  test('미확인이면서 근거가 있는 경우 근거 카드에 "판정 근거 아님 · 참고" 표시가 나타난다', async ({
    page,
  }) => {
    // 행정 효율성 증대(ind-midterm) 선택
    await page.locator('[data-testid="indicator-item-ind-midterm"]').click();

    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('미확인');

    // '판정 근거 아님 · 참고' 표시 확인
    const refTag = page.locator('[data-testid="unconfirmed-reference-tag"]');
    await expect(refTag).toBeVisible();
    await expect(refTag).toHaveText('판정 근거 아님 · 참고');
  });

  test('상단에 읽지 못한 파일 알림(⊘)이 표시된다 (RQ-06)', async ({ page }) => {
    const alert = page.locator('[data-testid="unreadable-docs-alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('⊘');
    await expect(alert).toContainText('07_empty.pdf');
  });

  test('[다시 제안 받기]를 누르면 가짜 AI 서버 액션(AIEAS_E2E_FAKE_AI=1)을 통해 화면이 갱신된다 (D30)', async ({
    page,
  }) => {
    // 1. 공무원 디지털 직무 교육(ind-activity) 선택
    await page.locator('[data-testid="indicator-item-ind-activity"]').click();

    // 2. 현재 제안 시각 기록
    const timestamp = page.locator('[data-testid="suggestion-created-at"]');
    await expect(timestamp).toBeVisible();
    const prevTimestamp = (await timestamp.innerText()).trim();

    // 3. [다시 제안 받기] 버튼 클릭
    const resuggestBtn = page.locator('[data-testid="resuggest-button"]');
    await expect(resuggestBtn).toBeVisible();
    await resuggestBtn.click();

    // 4. 진행 중 스피너가 나타났다가 비동기 완료 후 사라지는지 확인
    const pending = page.locator('[data-testid="pending-indicator"]');
    await expect(pending).not.toBeVisible({ timeout: 15000 });

    // 5. 화면이 갱신되어 새로운 제안 시각이 반영되었는지 단언
    await expect(timestamp).toBeVisible();
    const newTimestamp = (await timestamp.innerText()).trim();
    expect(newTimestamp).not.toBe(prevTimestamp);

    // 판정 배지 및 제안 문장이 정상 표시되는지 단언
    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('실현');
    await expect(page.locator('[data-testid="proposal-text"]')).toBeVisible();
  });
});

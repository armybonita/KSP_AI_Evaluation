import { test, expect } from './isolated-test';

test.describe('결과 ToC (S7) E2E 여정 시험 (#23, RQ-23, D05, D26, D28, UC-07, UC-14, UC-17)', () => {
  const SEED_PROJECT_ID = 'proj-dev-seed';
  const EMPTY_PROJECT_ID = 'proj-multi-conflict';

  test('1. 확정 0건 상태: 모든 항목 미확정 표시 및 안내와 S4 링크 검증 (UC-17, RQ-23, SP §S7)', async ({
    page,
  }) => {
    // ------------------------------------------------------------------------
    // 확정 이력이 전혀 없는 사업(proj-multi-conflict)으로 S7 결과 ToC 접속
    // ------------------------------------------------------------------------
    await page.goto(`/projects/${EMPTY_PROJECT_ID}/result`);
    await expect(page.getByRole('heading', { name: '결과 ToC' })).toBeVisible();

    // 범례 표시 확인
    const legend = page.locator('[data-testid="result-toc-legend"]');
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('실현');
    await expect(legend).toContainText('추진 중');
    await expect(legend).toContainText('기대');
    await expect(legend).toContainText('미확인');
    await expect(legend).toContainText('근거 충돌');
    await expect(legend).toContainText('보완 필요');
    await expect(legend).toContainText('채택 제외');
    await expect(legend).toContainText('미확정');

    // "확정한 판단이 없습니다" 안내 배너 표시 확인 (UC-17)
    const emptyNotice = page.locator('[data-testid="empty-confirmations-notice"]');
    await expect(emptyNotice).toBeVisible();
    await expect(emptyNotice).toContainText('확정한 판단이 없습니다');

    // S4 링크 확인 및 클릭 시 이동
    const linkToS4 = page.locator('[data-testid="link-to-s4"]');
    await expect(linkToS4).toBeVisible();

    // 모든 항목이 "미확정" 표시 (색 없음 + 실선 테두리 + "미확정" 글자, D26)
    const statusBadges = page.locator('[data-testid^="result-status-badge-"]');
    await expect(statusBadges.first()).toBeVisible();
    const count = await statusBadges.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(statusBadges.nth(i)).toHaveText('미확정');
      await expect(statusBadges.nth(i)).toHaveClass(/border-solid/);
    }

    // S4 링크 클릭 시 AI 제안 검토 화면으로 이동
    await linkToS4.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${EMPTY_PROJECT_ID}/review`));
    await expect(page.getByRole('heading', { name: 'AI 제안 검토' })).toBeVisible();
  });

  test('2. 확정·수정후확정·보완필요·채택제외·미확정 표시 → 재확정 반영 → S5 이력 이동 (RQ-23, D05, D28, UC-07, UC-14)', async ({
    page,
  }) => {
    const REVIEW_URL = `/projects/${SEED_PROJECT_ID}/review`;
    const RESULT_URL = `/projects/${SEED_PROJECT_ID}/result`;
    const HISTORY_URL = `/projects/${SEED_PROJECT_ID}/history`;

    // ------------------------------------------------------------------------
    // S4에서 각 지표별 4종 확정 수행 (확정자 이름: 평가자A)
    // ------------------------------------------------------------------------
    await page.goto(REVIEW_URL);
    await expect(page.getByRole('heading', { name: 'AI 제안 검토' })).toBeVisible();

    const confirmerInput = page.locator('[data-testid="confirmer-name-input"]');
    await expect(confirmerInput).toBeVisible();
    await confirmerInput.fill('평가자A');

    // (1) 이 사례 안에서 활동 지표 이력을 만들고 재확정해 최신 '확정'으로 갱신한다.
    await page.locator('[data-testid="indicator-item-ind-activity"]').click();
    await page.locator('[data-testid="confirm-btn-보완필요"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toContainText("'보완 필요' 상태로 확정되었습니다");
    await page.locator('[data-testid="confirm-btn-확정"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toContainText("'확정' 상태로 확정되었습니다");

    // (2) ind-shortterm (추진 중) -> [수정 후 확정]
    await page.locator('[data-testid="indicator-item-ind-shortterm"]').click();
    await page.locator('[data-testid="confirm-btn-수정후확정"]').click();
    await page.locator('[data-testid="edited-text-input"]').fill('포털 가입자 수 100만명 확보 추진 중');
    await page.locator('[data-testid="reason-input"]').fill('추진 현황 검토에 따른 내용 보완');
    await page.locator('[data-testid="save-edit-confirm-button"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toBeVisible();

    // (3) ind-output (기대) -> [보완 필요]
    await page.locator('[data-testid="indicator-item-ind-output"]').click();
    await page.locator('[data-testid="confirm-btn-보완필요"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toBeVisible();

    // (4) ind-conflict (근거 충돌) -> [채택 제외]
    await page.locator('[data-testid="indicator-item-ind-conflict"]').click();
    await page.locator('[data-testid="confirm-btn-채택제외"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toBeVisible();

    // (5) ind-unsupported 는 확정하지 않고 미확정 상태 유지

    // ------------------------------------------------------------------------
    // S7 결과 ToC 접속하여 각 상태별 색상 및 표시 단언
    // ------------------------------------------------------------------------
    await page.getByTestId('main-menu-path').click();
    const resultTab = page.locator('nav[aria-label="성과 경로 단계"]').getByRole('tab', { name: '⑩ 결과 ToC' });
    await resultTab.click();
    await expect(page).toHaveURL(new RegExp(RESULT_URL));

    // 확정 항목이 존재하므로 빈 상태 배너는 미노출
    await expect(page.locator('[data-testid="empty-confirmations-notice"]')).not.toBeVisible();

    // (1) ind-activity: '실현' (초록 색상 + 글자 병기, D28)
    const badgeActivity = page.locator('[data-testid="result-status-badge-ind-activity"]');
    await expect(badgeActivity).toBeVisible();
    await expect(badgeActivity).toContainText('실현');
    await expect(badgeActivity).toHaveClass(/bg-emerald-100|text-emerald-800/);

    // (2) ind-shortterm: '추진 중' (수정 후 확정, 파랑 색상 + 글자 병기, D28)
    const badgeShortterm = page.locator('[data-testid="result-status-badge-ind-shortterm"]');
    await expect(badgeShortterm).toBeVisible();
    await expect(badgeShortterm).toContainText('추진 중');
    await expect(badgeShortterm).toHaveClass(/bg-blue-100|text-blue-800/);

    // (3) ind-output: '보완 필요' (회색 점선 테두리 + 글자 병기, D05)
    const badgeOutput = page.locator('[data-testid="result-status-badge-ind-output"]');
    await expect(badgeOutput).toBeVisible();
    await expect(badgeOutput).toContainText('보완 필요');
    await expect(badgeOutput).toHaveClass(/border-dashed/);

    // (4) ind-conflict: '채택 제외' (색 없이 취소선 + 글자 병기, D05)
    const badgeConflict = page.locator('[data-testid="result-status-badge-ind-conflict"]');
    await expect(badgeConflict).toBeVisible();
    await expect(badgeConflict).toContainText('채택 제외');
    await expect(badgeConflict).toHaveClass(/line-through/);

    // (5) ind-unsupported: '미확정' (색 없음 + 실선 테두리 + "미확정" 글자, D26)
    const badgeUnsupported = page.locator('[data-testid="result-status-badge-ind-unsupported"]');
    await expect(badgeUnsupported).toBeVisible();
    await expect(badgeUnsupported).toContainText('미확정');
    await expect(badgeUnsupported).toHaveClass(/border-solid/);

    // ------------------------------------------------------------------------
    // 재확정 반영 검증 (UC-14, RQ-23)
    // ------------------------------------------------------------------------
    // S4로 이동하여 '보완 필요'였던 ind-output 을 [확정] (AI 판정: '기대')으로 재확정
    await page.goto(REVIEW_URL);
    await page.locator('[data-testid="indicator-item-ind-output"]').click();
    await page.locator('[data-testid="confirm-btn-확정"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toBeVisible();

    // S7 결과 ToC 로 돌아와 최신 상태('기대' 노랑 색상)로 바뀐 것을 확인
    await page.goto(RESULT_URL);
    const badgeOutputReconfirmed = page.locator('[data-testid="result-status-badge-ind-output"]');
    await expect(badgeOutputReconfirmed).toBeVisible();
    await expect(badgeOutputReconfirmed).toContainText('기대');
    await expect(badgeOutputReconfirmed).toHaveClass(/bg-amber-100|text-amber-800/);

    // ------------------------------------------------------------------------
    // 항목 누르면 S5 확정 이력의 해당 지표로 이동 (RQ-23, SP §S7)
    // ------------------------------------------------------------------------
    // 평가팀에는 Admin 이력 이동이 보이지 않고 클릭해도 결과 화면에 남는다.
    const nonAdminItem = page.locator('[data-testid="result-toc-item-ind-activity"]');
    await expect(nonAdminItem.getByText('이력', { exact: true })).toHaveCount(0);
    await nonAdminItem.click();
    await expect(page).toHaveURL(new RegExp(RESULT_URL));
    await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'admin' });
    await page.reload();
    const itemActivityLink = page.locator('[data-testid="result-toc-item-ind-activity"]');
    await expect(itemActivityLink).toBeVisible();
    await itemActivityLink.click();

    // S5 로 이동 및 쿼리 파라미터 확인
    await expect(page).toHaveURL(new RegExp(`${HISTORY_URL}\\?indicatorId=ind-activity`));
    await expect(page.getByRole('heading', { name: '확정 이력' })).toBeVisible();

    // 선택 지표 셀렉트 및 이력 확인
    const select = page.locator('[data-testid="indicator-select"]');
    await expect(select).toHaveValue('ind-activity');
    await expect(page.locator('[data-testid="history-row-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="history-row-1"]')).toBeVisible();
  });
});

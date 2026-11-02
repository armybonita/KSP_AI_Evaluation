import { test, expect } from './isolated-test';

test.describe('확정 및 추가만 되는 이력 E2E 시험 (#21, RQ-17, RQ-18, RQ-19, UC-05, UC-14, UC-16, D13, D16, D44)', () => {
  const PROJECT_ID = 'proj-dev-seed';
  const REVIEW_URL = `/projects/${PROJECT_ID}/review`;
  const HISTORY_URL = `/projects/${PROJECT_ID}/history`;

  test('확정 → 수정 후 확정 빈 칸 거부 → 채워 저장 → 재확정 → S5 세 줄, 새로 고침 유지', async ({
    page,
  }) => {
    // ------------------------------------------------------------------------
    // 1. S4 AI 제안 검토 화면 접속 및 대상 지표 선택
    // ------------------------------------------------------------------------
    await page.goto(REVIEW_URL);
    await expect(page.getByRole('heading', { name: 'AI 제안 검토' })).toBeVisible();

    // 활동 지표(공무원 디지털 직무 교육, ind-activity) 선택
    await page.locator('[data-testid="indicator-item-ind-activity"]').click();
    await expect(page.locator('[data-testid="selected-indicator-name"]')).toHaveText(
      '공무원 디지털 직무 교육'
    );

    // AI 제안 문장 확인
    const proposalTextElement = page.locator('[data-testid="proposal-text"]');
    await expect(proposalTextElement).toBeVisible();
    const rawAiProposal = (await proposalTextElement.innerText()).trim().replace(/^["“]|["”]$/g, '');

    // ------------------------------------------------------------------------
    // 2. 1회차 확정: 확정자 이름 필수 검증(D16, D44) 후 '확정' 수행
    // ------------------------------------------------------------------------
    const confirmSection = page.locator('[data-testid="confirmation-section"]');
    await expect(confirmSection).toBeVisible();

    // 확정자 이름 입력칸 확인 (비어 있음)
    const nameInput = page.locator('[data-testid="confirmer-name-input"]');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('');

    // 확정자 없이 [확정] 클릭 -> 에러 발생
    await page.locator('[data-testid="confirm-btn-확정"]').click();
    const nameError = page.locator('[data-testid="confirmer-name-error"]');
    await expect(nameError).toBeVisible();
    await expect(nameError).toContainText('확정자 이름을 입력해 주십시오');

    // 확정자 이름 입력 ("평가자A")
    await nameInput.fill('평가자A');

    // [확정] 클릭 -> 성공
    await page.locator('[data-testid="confirm-btn-확정"]').click();
    const successMsg = page.locator('[data-testid="confirm-success-message"]');
    await expect(successMsg).toBeVisible();
    await expect(successMsg).toContainText("'확정' 상태로 확정되었습니다");

    // 최신 확정 상태 배너 확인
    const latestSummary = page.locator('[data-testid="latest-confirmation-summary"]');
    await expect(latestSummary).toBeVisible();
    await expect(latestSummary).toContainText('확정');
    await expect(latestSummary).toContainText('평가자A');

    // ------------------------------------------------------------------------
    // 3. 2회차 확정: [수정 후 확정] 빈 칸 거부(UC-16) 후 채워 저장
    // ------------------------------------------------------------------------
    // [수정 후 확정] 버튼 클릭 -> 입력 패널 열림
    await page.locator('[data-testid="confirm-btn-수정후확정"]').click();
    const editPanel = page.locator('[data-testid="edit-confirm-panel"]');
    await expect(editPanel).toBeVisible();

    const editedTextInput = page.locator('[data-testid="edited-text-input"]');
    const reasonInput = page.locator('[data-testid="reason-input"]');

    // 빈 칸 상태에서 [저장] 클릭
    await editedTextInput.fill('');
    await reasonInput.fill('');
    await page.locator('[data-testid="save-edit-confirm-button"]').click();

    // 저장 거부 및 에러 안내 표시 단언 (UC-16)
    const validationError = page.locator('[data-testid="edit-validation-error"]');
    await expect(validationError).toBeVisible();
    await expect(validationError).toContainText('수정본과 수정 사유를 모두 입력해야 합니다');

    // 수정본만 입력하고 사유를 비운 경우도 거부 단언
    await editedTextInput.fill('공무원 500명 이수 달성을 현장에서 최종 검증 완료함.');
    await page.locator('[data-testid="save-edit-confirm-button"]').click();
    await expect(validationError).toBeVisible();

    // 사유까지 모두 채운 뒤 저장
    const editReasonText = '현장 실적 증빙 문서 확인에 따른 수치 정정';
    await reasonInput.fill(editReasonText);
    await page.locator('[data-testid="save-edit-confirm-button"]').click();

    // 성공 메시지 및 최신 확정 상태 확인
    await expect(successMsg).toBeVisible();
    await expect(successMsg).toContainText("'수정 후 확정' 상태로 확정되었습니다");
    await expect(latestSummary).toContainText('수정 후 확정');

    // ------------------------------------------------------------------------
    // 4. 3회차 확정: D13 재확정 ('보완 필요')
    // ------------------------------------------------------------------------
    await page.locator('[data-testid="confirm-btn-보완필요"]').click();
    await expect(successMsg).toBeVisible();
    await expect(successMsg).toContainText("'보완 필요' 상태로 확정되었습니다");
    await expect(latestSummary).toContainText('보완 필요');

    // ------------------------------------------------------------------------
    // 5. S5 확정 이력 화면 이동 및 세 줄 확인
    // ------------------------------------------------------------------------
    // 확정 이력은 Admin 메뉴에 있으므로 Admin으로 전환한다.
    await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'admin' });
    await page.reload();
    await page.getByRole('link', { name: 'Admin', exact: true }).click();
    await expect(page.getByRole('heading', { name: '확정 이력' })).toBeVisible();

    // 지표 선택기에서 '공무원 디지털 직무 교육' 선택 상태 확인
    const indicatorSelect = page.locator('[data-testid="indicator-select"]');
    await expect(indicatorSelect).toBeVisible();
    await indicatorSelect.selectOption({ label: '[활동] 공무원 디지털 직무 교육' });

    // 3개의 이력 행이 순서대로 존재하는지 단언 (RQ-18, UC-14)
    const row0 = page.locator('[data-testid="history-row-0"]');
    const row1 = page.locator('[data-testid="history-row-1"]');
    const row2 = page.locator('[data-testid="history-row-2"]');

    await expect(row0).toBeVisible();
    await expect(row1).toBeVisible();
    await expect(row2).toBeVisible();

    // 1회차: 확정 / 평가자A / KST 시각
    await expect(page.locator('[data-testid="history-type-0"]')).toHaveText('확정');
    await expect(page.locator('[data-testid="history-confirmer-0"]')).toHaveText('평가자A');
    await expect(page.locator('[data-testid="history-time-0"]')).toHaveText(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(KST\)$/
    );

    // 2회차: 수정 후 확정 / 평가자A / 사유
    await expect(page.locator('[data-testid="history-type-1"]')).toHaveText('수정 후 확정');
    await expect(page.locator('[data-testid="history-confirmer-1"]')).toHaveText('평가자A');
    await expect(page.locator('[data-testid="history-reason-1"]')).toContainText(editReasonText);

    // 3회차: 보완 필요 / 평가자A
    await expect(page.locator('[data-testid="history-type-2"]')).toHaveText('보완 필요');
    await expect(page.locator('[data-testid="history-confirmer-2"]')).toHaveText('평가자A');

    // ------------------------------------------------------------------------
    // 6. 줄 펼침 비교 및 AI 최초 제안 보존 단언 (RQ-19, UC-05, UC-14)
    // ------------------------------------------------------------------------
    // 1회차 행 펼침
    await page.locator('[data-testid="history-expand-button-0"]').click();
    const detail0 = page.locator('[data-testid="history-detail-panel-0"]');
    await expect(detail0).toBeVisible();
    await expect(page.locator('[data-testid="history-initial-proposal-0"]')).toContainText(
      rawAiProposal
    );

    // 2회차 행 펼침
    await page.locator('[data-testid="history-expand-button-1"]').click();
    const detail1 = page.locator('[data-testid="history-detail-panel-1"]');
    await expect(detail1).toBeVisible();
    // 첫 번째 줄의 AI 최초 제안이 2회차에도 동일하게 고정 보존됨
    await expect(page.locator('[data-testid="history-initial-proposal-1"]')).toContainText(
      rawAiProposal
    );
    // 2회차의 수정본 확인
    await expect(page.locator('[data-testid="history-edited-text-1"]')).toContainText(
      '공무원 500명 이수 달성을 현장에서 최종 검증 완료함.'
    );

    // ------------------------------------------------------------------------
    // 7. 페이지 새로 고침 뒤에도 3건의 이력과 최초 제안이 영속 유지됨
    // ------------------------------------------------------------------------
    await page.reload();
    await expect(page.getByRole('heading', { name: '확정 이력' })).toBeVisible();
    // Admin 메뉴에서 연 이력은 기본 지표를 선택하므로 검증 대상을 다시 고른다.
    await indicatorSelect.selectOption({ label: '[활동] 공무원 디지털 직무 교육' });

    await expect(page.locator('[data-testid="history-row-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="history-row-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="history-row-2"]')).toBeVisible();

    // ------------------------------------------------------------------------
    // 8. 화면 어디에도 이력 수정·삭제 버튼이 없음 (RQ-18, UC-14)
    // ------------------------------------------------------------------------
    const forbiddenButtons = page.locator(
      'button:has-text("고치기"), button:has-text("지우기"), button:has-text("삭제"), button:has-text("이력 수정")'
    );
    expect(await forbiddenButtons.count()).toBe(0);
  });
});

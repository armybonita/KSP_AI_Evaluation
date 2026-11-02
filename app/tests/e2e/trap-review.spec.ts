import { test, expect } from './isolated-test';

test.describe('함정 검토 및 5대 요구사항 E2E 시험 (RQ-06, RQ-13, RQ-14, RQ-15, RQ-16, D01, D48)', () => {
  const PROJECT_ID = 'proj-dev-seed';
  const REVIEW_URL = `/projects/${PROJECT_ID}/review`;
  const DOCUMENTS_URL = `/projects/${PROJECT_ID}/documents`;

  test('함정 1: 근거 충돌 지표는 두 근거를 문서·위치와 함께 나란히 표시하며 택일 라디오는 없다 (RQ-13, D48)', async ({
    page,
  }) => {
    await page.goto(REVIEW_URL);
    await expect(page.getByRole('heading', { name: 'AI 제안 검토' })).toBeVisible();

    // '대국민 행정 편의 증진' (ind-conflict) 선택
    await page.locator('[data-testid="indicator-item-ind-conflict"]').click();

    // 판정 배지: '근거 충돌'
    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('근거 충돌');

    // 두 근거 나란히 그리드 컨테이너 확인 (RQ-13)
    const conflictGrid = page.locator('[data-testid="conflict-evidences-grid"]');
    await expect(conflictGrid).toBeVisible();

    // 두 근거 카드 확인
    const card0 = page.locator('[data-testid="evidence-card-0"]');
    const card1 = page.locator('[data-testid="evidence-card-1"]');
    await expect(card0).toBeVisible();
    await expect(card1).toBeVisible();

    // 카드 0: 문서 및 위치
    await expect(card0.locator('[data-testid="evidence-doc-0"]')).toHaveText(
      '01_project_plan.hwpx'
    );
    await expect(card0.locator('[data-testid="evidence-loc-0"]')).toHaveText('¶4');

    // 카드 1: 문서 및 위치
    await expect(card1.locator('[data-testid="evidence-doc-1"]')).toHaveText(
      '02_pdm.docx'
    );
    await expect(card1.locator('[data-testid="evidence-loc-1"]')).toHaveText('¶3');

    // D48: 택일 절차는 열려 있으므로 택일 라디오/선택 버튼이 없어야 함
    const radioInputs = page.locator('input[type="radio"]');
    await expect(radioInputs).toHaveCount(0);
  });

  test('함정 2: "근거 없는 판단" 지표는 "미확인"과 사유가 보인다 (RQ-06, RQ-11)', async ({ page }) => {
    await page.goto(REVIEW_URL);

    // 디지털 법제 정비 (ind-unsupported) 선택
    await page.locator('[data-testid="indicator-item-ind-unsupported"]').click();

    // 판정 배지: '미확인'
    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('미확인');

    // 사유 상자 확인
    const reasonBox = page.locator('[data-testid="unconfirmed-reason-box"]');
    await expect(reasonBox).toBeVisible();
    await expect(reasonBox).toContainText('포함 문서에서 근거를 찾지 못함');
  });

  test('함정 3: S2 자료 등록에서 제외 분류된 문서는 제외 사유와 함께 표시된다 (RQ-04, FE-07)', async ({
    page,
  }) => {
    await page.goto(DOCUMENTS_URL);
    await expect(page.getByRole('heading', { name: '자료 등록' })).toBeVisible();

    // 05_other_project.docx: 기본 제외 + 다른 사업 자료
    const doc05Row = page.locator('tbody tr', { hasText: '05_other_project.docx' });
    await expect(doc05Row).toBeVisible();
    await expect(doc05Row.locator('[data-testid^="doc-inclusion-select-"]')).toHaveValue('기본 제외');
    await expect(doc05Row.locator('[data-testid^="doc-excluded-reason-"]')).toContainText('다른 사업 자료');

    // 06_personal_memo.pdf: 기본 제외 + 개인 서류
    const doc06Row = page.locator('tbody tr', { hasText: '06_personal_memo.pdf' });
    await expect(doc06Row).toBeVisible();
    await expect(doc06Row.locator('[data-testid^="doc-inclusion-select-"]')).toHaveValue('기본 제외');
    await expect(doc06Row.locator('[data-testid^="doc-excluded-reason-"]')).toContainText('개인 서류');
  });

  test('함정 4: S4 상단 "읽지 못함"(⊘) 알림과 지표 "미확인" 배지는 글자와 모양이 다르다 (RQ-06)', async ({
    page,
  }) => {
    await page.goto(REVIEW_URL);

    // 1. 상단 읽지 못함 알림 (기호: ⊘, 글자: '읽지 못함')
    const unreadableAlert = page.locator('[data-testid="unreadable-docs-alert"]');
    await expect(unreadableAlert).toBeVisible();
    await expect(unreadableAlert).toContainText('⊘');
    await expect(unreadableAlert).toContainText('읽지 못함');

    // 2. 지표 '미확인' 배지 (글자: '미확인', 원형 점)
    await page.locator('[data-testid="indicator-item-ind-unsupported"]').click();
    const verdictBadge = page.locator('[data-testid="selected-verdict-badge"]');
    await expect(verdictBadge).toBeVisible();
    await expect(verdictBadge).toContainText('미확인');

    // 두 표시의 텍스트가 명확히 다름을 단언
    const alertText = await unreadableAlert.innerText();
    const badgeText = await verdictBadge.innerText();
    expect(alertText).toContain('읽지 못함');
    expect(badgeText).toBe('미확인');
    expect(badgeText.includes('읽지 못함')).toBe(false);
  });

  test('함정 5: 인용 금지 문장은 "인용 금지 문장 있음"과 위치만 표시되고 [원문 위치 열기] 및 S2 미리보기에서 "[인용 금지 문장]"으로 가려지며, 화면 전체 HTML에 금지 문장 글자가 0건이다 (RQ-14, D01)', async ({
    page,
  }) => {
    // 1. S4 AI 제안 검토 화면에서 인용 금지 확인
    await page.goto(REVIEW_URL);

    // ind-output(디지털 행정 기반 구축) 선택
    await page.locator('[data-testid="indicator-item-ind-output"]').click();

    // 두 번째 근거 카드가 인용 금지 알림 카드인지 확인
    const bannedNotice = page.locator('[data-testid="citation-banned-notice-1"]');
    await expect(bannedNotice).toBeVisible();
    await expect(bannedNotice).toContainText('인용 금지 문장 있음');
    await expect(bannedNotice).toContainText('03_trip_report.pdf');
    await expect(bannedNotice).toContainText('2쪽 ¶3');

    // [원문 위치 열기] 버튼 클릭
    const toggleButton = page.locator('[data-testid="toggle-source-button-1"]');
    await toggleButton.click();

    // 원문 문맥 패널 확인
    const contextPanel = page.locator('[data-testid="source-context-panel-1"]');
    await expect(contextPanel).toBeVisible();
    await expect(contextPanel).toContainText('[인용 금지 문장]');

    // S4 화면 전체 HTML에 금지 문장 글자 0건 단언
    const s4Html = await page.content();
    expect(s4Html.includes('이름을 밝히지 말아')).toBe(false);

    // 2. S2 자료 등록 화면 미리보기에서 인용 금지 문장 가림 확인
    await page.goto(DOCUMENTS_URL);
    await expect(page.getByRole('heading', { name: '자료 등록' })).toBeVisible();

    const tripDocRow = page.locator('tbody tr', { hasText: '03_trip_report.pdf' });
    await tripDocRow.click();

    const maskedQuote = page.locator('[data-testid="forbidden-quote-masked"]');
    await expect(maskedQuote).toBeVisible();
    await expect(maskedQuote).toContainText('[인용 금지 문장]');

    // S2 화면 전체 HTML에 금지 문장 글자 0건 단언
    const s2Html = await page.content();
    expect(s2Html.includes('이름을 밝히지 말아')).toBe(false);
  });

  test('단계 탭 이동: 산출물/단기성과/중·장기성과/기여·제약요인 1클릭 이동, 기여·제약요인 빈 상태 안내, 입력 값 유지 (RQ-15)', async ({
    page,
  }) => {
    await page.goto(REVIEW_URL);

    // 단계 탭 목록 확인
    await expect(page.locator('[data-testid="stage-tab-산출물"]')).toBeVisible();
    await expect(page.locator('[data-testid="stage-tab-단기성과"]')).toBeVisible();
    await expect(page.locator('[data-testid="stage-tab-중·장기성과"]')).toBeVisible();
    await expect(page.locator('[data-testid="stage-tab-기여·제약요인"]')).toBeVisible();

    // 1. 단기성과 탭 클릭
    await page.locator('[data-testid="stage-tab-단기성과"]').click();
    await expect(page.locator('[data-testid="indicator-item-ind-shortterm"]')).toBeVisible();
    await expect(page.locator('[data-testid="indicator-item-ind-output"]')).not.toBeVisible();

    // 단기성과 지표에 기여 귀속 임시 입력
    const attrInput = page.locator('[data-testid="contribution-attribution-input"]');
    await attrInput.fill('임시 기여 귀속 메모 작성 중...');

    // 2. 산출물 탭 클릭
    await page.locator('[data-testid="stage-tab-산출물"]').click();
    await expect(page.locator('[data-testid="indicator-item-ind-output"]')).toBeVisible();
    await expect(page.locator('[data-testid="indicator-item-ind-shortterm"]')).not.toBeVisible();

    // 3. 기여·제약요인 탭 클릭 (정의 필요 단계 - 빈 상태 안내 표시)
    await page.locator('[data-testid="stage-tab-기여·제약요인"]').click();
    const emptyMsg = page.locator('[data-testid="stage-empty-message"]');
    await expect(emptyMsg).toBeVisible();
    await expect(emptyMsg).toContainText('기여·제약요인 단계에 등록된 지표가 없습니다.');

    // 4. 다시 단기성과 탭으로 1클릭 이동 후 입력 중인 값 유지 확인
    await page.locator('[data-testid="stage-tab-단기성과"]').click();
    await page.locator('[data-testid="indicator-item-ind-shortterm"]').click();
    await expect(attrInput).toHaveValue('임시 기여 귀속 메모 작성 중...');
  });

  test('기여 귀속 저장: 평가자 판단 입력 후 저장하면 확정 및 새로고침 후에도 유지된다 (RQ-16)', async ({
    page,
  }) => {
    await page.goto(REVIEW_URL);

    // ind-shortterm 선택
    await page.locator('[data-testid="indicator-item-ind-shortterm"]').click();

    // 평가자 기여 귀속 판단 입력
    const testAttribution =
      'KSP 디지털 전환 자문 및 시범 사업 연계가 포털 가입자 목표 달성에 결정적으로 기여하였음.';
    const attrInput = page.locator('[data-testid="contribution-attribution-input"]');
    await attrInput.fill(testAttribution);

    // [기여 귀속 저장] 버튼 클릭
    const saveButton = page.locator('[data-testid="save-attribution-button"]');
    await saveButton.click();

    // 저장 성공 메시지 확인
    const successMsg = page.locator('[data-testid="attribution-saved-message"]');
    await expect(successMsg).toBeVisible();
    await expect(successMsg).toContainText('기여 귀속 판단이 저장되었습니다.');

    // 페이지 새로고침
    await page.reload();

    // ind-shortterm 재선택
    await page.locator('[data-testid="indicator-item-ind-shortterm"]').click();

    // 새로고침 후에도 저장된 기여 귀속 판단 내용이 그대로 유지되는지 단언
    await expect(attrInput).toHaveValue(testAttribution);
    await expect(page.locator('[data-testid="attribution-status-badge"]')).toBeVisible();
  });

  test('단계·지표 이동 시 확정 폼 입력(수정본·사유) 지표별 보관·복원 (Item 8)', async ({
    page,
  }) => {
    await page.goto(REVIEW_URL);

    // 1. A 지표(ind-shortterm, 단기성과) 선택 후 수정 후 확정 폼에 입력
    await page.locator('[data-testid="stage-tab-단기성과"]').click();
    await page.locator('[data-testid="indicator-item-ind-shortterm"]').click();
    await page.locator('[data-testid="confirm-btn-수정후확정"]').click();

    const editTextInput = page.locator('[data-testid="edited-text-input"]');
    const reasonInput = page.locator('[data-testid="reason-input"]');
    await expect(editTextInput).toBeVisible();

    await editTextInput.fill('지표 A 수정본 입력 내용');
    await reasonInput.fill('지표 A 사유 입력 내용');

    // 2. 다른 단계(산출물)의 B 지표(ind-output)로 이동
    await page.locator('[data-testid="stage-tab-산출물"]').click();
    await page.locator('[data-testid="indicator-item-ind-output"]').click();

    // 3. B 지표의 수정 후 확정 폼 열기 -> 비어 있음 확인
    await page.locator('[data-testid="confirm-btn-수정후확정"]').click();
    await expect(page.locator('[data-testid="edited-text-input"]')).toHaveValue('');
    await expect(page.locator('[data-testid="reason-input"]')).toHaveValue('');

    // 4. 다시 A 지표(단기성과)로 돌아오기 -> 입력 유지 확인
    await page.locator('[data-testid="stage-tab-단기성과"]').click();
    await page.locator('[data-testid="indicator-item-ind-shortterm"]').click();

    await expect(page.locator('[data-testid="edit-confirm-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="edited-text-input"]')).toHaveValue('지표 A 수정본 입력 내용');
    await expect(page.locator('[data-testid="reason-input"]')).toHaveValue('지표 A 사유 입력 내용');
  });
});

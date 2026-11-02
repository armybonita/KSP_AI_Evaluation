import { test, expect } from './isolated-test';
import type { Page } from '@playwright/test';
import type { Locator } from '@playwright/test';
import path from 'node:path';
import { extractDocx } from '../../src/server/extract';

async function expectHeadingTitleAndBadge(section: Locator, title: string, badge?: { source: string; text: string }) {
  const heading = section.getByRole('heading').first();
  await expect(heading).toBeVisible();
  const titleText = await heading.evaluate((element) => Array.from(element.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent ?? '').join('').trim());
  expect(titleText).toBe(title);
  const badges = heading.locator('[data-testid^="report-source-"]');
  if (!badge) {
    await expect(badges).toHaveCount(0);
    return;
  }
  await expect(badges).toHaveCount(1);
  await expect(heading.getByTestId(`report-source-${badge.source}`)).toHaveText(badge.text);
}

const PATH_TABS = [
  ['toc', '② 초기 ToC'],
  ['ontology', '② 상세 그래프'],
  ['report', '⑧ 종료평가보고서'],
  ['portfolio', '⑨ 포트폴리오'],
  ['result', '⑩ 결과 ToC'],
] as const;

async function expectProjectTabs(page: Page, projectId: string, activeScreen: string) {
  const tabs = page.locator('nav[aria-label="성과 경로 단계"] [role="tab"]');
  if (!['toc', 'ontology', 'report', 'portfolio', 'result'].includes(activeScreen)) {
    await expect(tabs).toHaveCount(0);
    return;
  }
  await expect(tabs).toHaveCount(PATH_TABS.length);
  await expect(tabs).toHaveText(PATH_TABS.map(([, label]) => label));

  for (const [screen, label] of PATH_TABS) {
    const tab = page.getByRole('tab', { name: label, exact: true });
    const expectedHref = screen === 'ontology'
      ? `/projects/${projectId}/toc?view=graph`
      : `/projects/${projectId}/${screen}`;
    await expect(tab).toHaveAttribute('href', expectedHref);
    await expect(tab).toHaveAttribute('aria-selected', screen === activeScreen ? 'true' : 'false');
  }
}

test.describe('흐름 1~7 E2E 여정 시험 (S1~S7, Admin 확정 이력 접근 제한 포함)', () => {
  const fixturesDir = path.resolve(__dirname, '../../fixtures');

  test('화면만으로 S1 사업 생성 → S2 가상 자료 8개 등록·제외·미인식 → S3 성과경로·충돌·기준선택 → S4 제안받기·인용금지가림·4종확정 → S5 평가팀 이력 차단 → S6 초안·DOCX검증 → S7 결과ToC', async ({
    page,
  }) => {
    // ------------------------------------------------------------------------
    // [S1] 사업 만들기 (/projects)
    // ------------------------------------------------------------------------
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: '사업 목록' })).toBeVisible();

    const journeyProjectName = `완주 여정 사업 ${Date.now()}`;
    await page.getByTestId('project-name-input').fill(journeyProjectName);
    await page.getByTestId('project-create-button').click();

    // S2 로 자동 이동 완료 대기
    await expect(page.getByRole('heading', { name: '자료 등록' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('project-name-display')).toHaveText(journeyProjectName);

    const projectUrl = page.url();
    const projectIdMatch = projectUrl.match(/\/projects\/([^/]+)\/documents/);
    expect(projectIdMatch).not.toBeNull();
    const projectId = projectIdMatch![1];
    await expectProjectTabs(page, projectId, 'documents');

    // ------------------------------------------------------------------------
    // [S2] 가상 자료 8개 올리기 및 제외·읽지 못함 확인
    // ------------------------------------------------------------------------
    const filesToUpload = [
      path.join(fixturesDir, '01_project_plan.hwpx'),
      path.join(fixturesDir, '02_pdm.docx'),
      path.join(fixturesDir, '03_trip_report.pdf'),
      path.join(fixturesDir, '04_review_opinion.docx'),
      path.join(fixturesDir, '05_other_project.docx'),
      path.join(fixturesDir, '06_personal_memo.pdf'),
      path.join(fixturesDir, '07_empty.pdf'),
      path.join(fixturesDir, '08_irrelevant_note.docx'),
    ];

    // DR-005: 올린 자료가 이번 사업 자료임을 확인해야 분석에 쓰인다(미선택은 분석 제외).
    await page.getByLabel('종료평가보고서 여부').selectOption('false');
    const fileInput = page.getByTestId('file-upload-input');
    await fileInput.setInputFiles(filesToUpload);

    // 8개 행 업로드 완료 대기
    await expect(page.getByTestId('documents-table')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(8, { timeout: 15000 });

    // 1. 기본 제외 문서 3종 및 사유 검증 (RQ-04, RQ-05, D14)
    const doc05Row = page.locator('tbody tr', { hasText: '05_other_project.docx' });
    await expect(doc05Row).toBeVisible();
    await expect(doc05Row.locator('[data-testid^="doc-inclusion-select-"]')).toHaveValue('기본 제외');
    await expect(doc05Row.locator('[data-testid^="doc-excluded-reason-"]')).toContainText('다른 사업 자료');

    const doc06Row = page.locator('tbody tr', { hasText: '06_personal_memo.pdf' });
    await expect(doc06Row).toBeVisible();
    await expect(doc06Row.locator('[data-testid^="doc-inclusion-select-"]')).toHaveValue('기본 제외');
    await expect(doc06Row.locator('[data-testid^="doc-excluded-reason-"]')).toContainText('개인 서류');

    const doc08Row = page.locator('tbody tr', { hasText: '08_irrelevant_note.docx' });
    await expect(doc08Row).toBeVisible();
    await expect(doc08Row.locator('[data-testid^="doc-inclusion-select-"]')).toHaveValue('기본 제외');
    await expect(doc08Row.locator('[data-testid^="doc-excluded-reason-"]')).toContainText('무관 문서');

    // 2. 읽지 못함 문서 1종 검증 (RQ-06)
    const doc07Row = page.locator('tbody tr', { hasText: '07_empty.pdf' });
    await expect(doc07Row).toBeVisible();
    await expect(doc07Row.locator('[data-testid^="doc-status-"]')).toContainText('읽지 못함');
    await expect(doc07Row.locator('[data-testid^="doc-inclusion-select-"]')).toHaveCount(0);
    await expect(doc07Row.locator('[data-testid^="doc-inclusion-unavailable-"]')).toHaveCount(1);
    await expect(doc07Row.locator('[data-testid^="doc-excluded-reason-"]')).toHaveCount(0);

    // 3. 정상 포함 문서 4종 검증
    for (const normalDoc of [
      '01_project_plan.hwpx',
      '02_pdm.docx',
      '03_trip_report.pdf',
      '04_review_opinion.docx',
    ]) {
      const row = page.locator('tbody tr', { hasText: normalDoc });
      await expect(row.locator('[data-testid^="doc-inclusion-select-"]')).toHaveValue('포함');
      await expect(row.locator('[data-testid^="doc-status-"]')).toContainText('추출 완료');
    }

    // ------------------------------------------------------------------------
    // [S3] 초기 ToC: 성과 경로·충돌 경고·기준 선택
    // ------------------------------------------------------------------------
    await page.goto(`/projects/${projectId}/toc`);
    await expect(page.getByRole('heading', { name: '초기 ToC' })).toBeVisible();
    await expectProjectTabs(page, projectId, 'toc');

    // 1. 성과 경로 5단계 계층 존재 확인 (RQ-07, D07)
    const tree = page.getByRole('tree');
    await expect(tree).toBeVisible();
    for (const level of ['영향', '중/장기성과', '단기성과', '산출물', '활동']) {
      await expect(page.getByRole('treeitem', { name: new RegExp(`^${level}:`) }).first()).toBeVisible();
    }

    // 2. 지표 충돌 함정 경고 확인 (80% vs 5점 척도 3.5점, RQ-08, D32)
    const conflictWarning = page.locator('[data-testid^="conflict-warning-"]');
    await expect(conflictWarning).toBeVisible();
    await expect(conflictWarning).toContainText('지표 충돌: 사업계획서 "80%" ↔ 성과관리표 "5점 척도 3.5점"');

    // 3. 기준 지표 선택 및 저장
    const planRadio = page.getByTestId('baseline-radio-사업계획서');
    await expect(planRadio).toBeVisible();
    await planRadio.check();

    const saveBaselineBtn = page.locator('[data-testid^="save-baseline-button-"]');
    await expect(saveBaselineBtn).toBeVisible();
    await saveBaselineBtn.click();

    // 저장 뒤 레이블 확인
    const savedBaselineLabel = page.locator('[data-testid^="saved-baseline-label-"]');
    await expect(savedBaselineLabel).toBeVisible();
    await expect(savedBaselineLabel).toHaveText('기준: 사업계획서');

    // ------------------------------------------------------------------------
    // [S4] AI 제안 검토: [제안 받기] 및 판정·근거·인용 금지 가림 확인
    // ------------------------------------------------------------------------
    await page.goto(`/projects/${projectId}/review`);
    await expect(page.getByRole('heading', { name: 'AI 제안 검토' })).toBeVisible();
    await expectProjectTabs(page, projectId, 'review');

    // 1. 상단 읽지 못한 파일 알림(⊘ 07_empty.pdf) 확인 (RQ-06)
    const unreadableAlert = page.locator('[data-testid="unreadable-docs-alert"]');
    await expect(unreadableAlert).toBeVisible();
    await expect(unreadableAlert).toContainText('⊘');
    await expect(unreadableAlert).toContainText('07_empty.pdf');

    // 2. 기준 선택 표시 확인
    const conflictIndicatorBtn = page.locator('button', { hasText: '대국민 행정 편의 증진' });
    await expect(conflictIndicatorBtn).toBeVisible();
    await conflictIndicatorBtn.click();

    const baselineHeaderLabel = page.getByTestId('baseline-header-label');
    await expect(baselineHeaderLabel).toBeVisible();
    await expect(baselineHeaderLabel).toHaveText('기준: 사업계획서');

    // 3. 활동 지표(공무원 디지털 직무 교육) [제안 받기] 및 판정·근거 확인
    const activityIndicatorBtn = page.locator('button', { hasText: '공무원 디지털 직무 교육' });
    await activityIndicatorBtn.click();

    const getSuggestionBtn = page.getByTestId('get-suggestion-button');
    if (await getSuggestionBtn.isVisible()) {
      await getSuggestionBtn.click();
    }
    await expect(page.locator('[data-testid="pending-indicator"]')).not.toBeVisible({ timeout: 15000 });

    // 판정 상태 '실현' 및 근거 확인
    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('실현');
    await expect(page.locator('[data-testid="evidence-quote-0"]')).toContainText('500명');
    await expect(page.locator('[data-testid="evidence-doc-0"]')).toHaveText('03_trip_report.pdf');
    await expect(page.locator('[data-testid="evidence-loc-0"]')).toHaveText('2쪽 ¶2');
    await expect(page.locator('[data-testid="evidence-speaker-0"]')).toHaveText('수행기관');

    // 4. 산출물 지표(디지털 행정 기반 구축) [제안 받기] 및 인용 금지 가림 확인 (RQ-14, D01)
    const outputIndicatorBtn = page.locator('button', { hasText: '디지털 행정 기반 구축' });
    await outputIndicatorBtn.click();

    const getSuggestionBtnOutput = page.getByTestId('get-suggestion-button');
    if (await getSuggestionBtnOutput.isVisible()) {
      await getSuggestionBtnOutput.click();
    }
    await expect(page.locator('[data-testid="pending-indicator"]')).not.toBeVisible({ timeout: 15000 });

    // 판정 상태 '기대'
    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('기대');

    // 두 번째 근거 카드가 인용 금지 알림 카드인지 확인
    const bannedNotice = page.locator('[data-testid="citation-banned-notice-1"]');
    await expect(bannedNotice).toBeVisible();
    await expect(bannedNotice).toContainText('인용 금지 문장 있음');
    await expect(bannedNotice).toContainText('03_trip_report.pdf');
    await expect(bannedNotice).toContainText('2쪽 ¶3');

    // [원문 위치 열기] 클릭 시 [인용 금지 문장] 가림 확인
    await page.locator('[data-testid="toggle-source-button-1"]').click();
    const sourceContextPanel = page.locator('[data-testid="source-context-panel-1"]');
    await expect(sourceContextPanel).toBeVisible();
    await expect(sourceContextPanel).toContainText('[인용 금지 문장]');

    // 화면 전체 HTML에 금지 문장 글자가 0건임을 단언
    const currentHtml = await page.content();
    expect(currentHtml.includes('이름을 밝히지 말아')).toBe(false);

    // 5. 단기성과 지표(디지털 행정 서비스 이용 확산) [제안 받기]
    const shorttermIndicatorBtn = page.locator('button', { hasText: '디지털 행정 서비스 이용 확산' });
    await shorttermIndicatorBtn.click();

    const getSuggestionBtnShortterm = page.getByTestId('get-suggestion-button');
    if (await getSuggestionBtnShortterm.isVisible()) {
      await getSuggestionBtnShortterm.click();
    }
    await expect(page.locator('[data-testid="pending-indicator"]')).not.toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('추진 중');

    // 6. 영향 지표(대국민 행정 편의 증진) [제안 받기]
    await conflictIndicatorBtn.click();
    const getSuggestionBtnConflict = page.getByTestId('get-suggestion-button');
    if (await getSuggestionBtnConflict.isVisible()) {
      await getSuggestionBtnConflict.click();
    }
    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('근거 충돌', { timeout: 15000 });

    // 7. 디지털 법제 정비(근거 없는 판단) [제안 받기] -> '미확인' 확인 후 미확정 상태로 남겨둠
    const unsupportedIndicatorBtn = page.locator('button', { hasText: '디지털 법제 정비' });
    await unsupportedIndicatorBtn.click();
    const getSuggestionBtnUnsupported = page.getByTestId('get-suggestion-button');
    if (await getSuggestionBtnUnsupported.isVisible()) {
      await getSuggestionBtnUnsupported.click();
    }
    await expect(page.locator('[data-testid="selected-verdict-badge"]')).toHaveText('미확인', { timeout: 15000 });

    // ------------------------------------------------------------------------
    // [S4] 4종 확정 수행: 확정, 수정 후 확정(판정 변경), 보완 필요, 채택 제외
    // ------------------------------------------------------------------------
    const nameInput = page.locator('[data-testid="confirmer-name-input"]');
    await nameInput.fill('완주평가자');

    // (1) 활동 (공무원 디지털 직무 교육) -> [확정]
    await activityIndicatorBtn.click();
    await page.locator('[data-testid="confirm-btn-확정"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toContainText(
      "'확정' 상태로 확정되었습니다"
    );

    // (2) 단기성과 (디지털 행정 서비스 이용 확산) -> [수정 후 확정] (AI: 추진 중 -> 평가자: 실현 판정 변경)
    await shorttermIndicatorBtn.click();
    await page.locator('[data-testid="confirm-btn-수정후확정"]').click();
    await expect(page.locator('[data-testid="edit-confirm-panel"]')).toBeVisible();

    // 판정 상태 셀렉트에서 '실현' 선택 (판정 변경)
    const verdictSelect = page.locator('[data-testid="edited-verdict-status-select"]');
    await expect(verdictSelect).toHaveValue('추진 중'); // 기본값: AI 판정
    await verdictSelect.selectOption('실현');

    await page
      .locator('[data-testid="edited-text-input"]')
      .fill('포털 가입자 100만명 확보 목표를 적극적 홍보로 최종 달성 완료함.');
    await page
      .locator('[data-testid="reason-input"]')
      .fill('현장 증빙 자료 확인에 따라 판정 상태를 추진 중에서 실현으로 상향 변경함.');

    await page.locator('[data-testid="save-edit-confirm-button"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toContainText(
      "'수정 후 확정' 상태로 확정되었습니다"
    );

    // (3) 산출물 (디지털 행정 기반 구축) -> [보완 필요]
    await outputIndicatorBtn.click();
    await page.locator('[data-testid="confirm-btn-보완필요"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toContainText(
      "'보완 필요' 상태로 확정되었습니다"
    );

    // (4) 영향 (대국민 행정 편의 증진) -> [채택 제외]
    await conflictIndicatorBtn.click();
    await page.locator('[data-testid="confirm-btn-채택제외"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toContainText(
      "'채택 제외' 상태로 확정되었습니다"
    );

    // ------------------------------------------------------------------------
    // [S5] 확정 이력: 판정 변경(AI → 평가자) 표시 확인
    // ------------------------------------------------------------------------
    await expect(page.locator('.app-admin-link')).toHaveCount(0);
    const deniedHistory = await page.goto(`/projects/${projectId}/history`);
    expect(deniedHistory?.status()).toBe(404);
    await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'admin' });
    await page.goto(`/projects/${projectId}/history`);
    await page.locator('[data-testid="indicator-select"]').selectOption({ label: '[활동] 공무원 디지털 직무 교육' });
    await expect(page.locator('[data-testid="history-row-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="history-type-0"]')).toHaveText('확정');
    await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'evaluator' });

    // ------------------------------------------------------------------------
    // [S6] 보고서 초안: 초안 만들기·근거 링크·Word 내려받아 KSP 목차 및 제외 0건 검증
    // ------------------------------------------------------------------------
    await page.goto(`/projects/${projectId}/report`);
    await expect(page.getByRole('heading', { name: '⑧ 종료평가보고서 종합' })).toBeVisible();
    await expectProjectTabs(page, projectId, 'report');

    // 요약 바 확인: 확정 2건(활동 1건 확정 + 단기성과 1건 수정후확정), 보완 필요·채택 제외·미확정 제외
    const summaryBar = page.locator('[data-testid="report-summary-bar"]');
    await expect(summaryBar).toBeVisible();
    await expect(summaryBar).toContainText('지표 확정 2');
    await expect(summaryBar).toContainText('노트 확정');
    await expect(summaryBar).toContainText('자격을 갖춘 근거');

    // [초안 만들기] 버튼 클릭
    const generateDraftBtn = page.locator('[data-testid="generate-draft-button"]');
    await expect(generateDraftBtn).toBeVisible();
    await page.getByLabel('보고서 서식').selectOption('ksp');
    await generateDraftBtn.click();

    // 초안 내용 렌더링 완료 대기
    await expect(page.locator('[data-testid="report-content"]')).toBeVisible();
    await expect(page.getByTestId('draft-confirmed-count')).toHaveText('생성된 초안 확정 건수 2');

    // 1절 달성표 검증
    const tableSection = page.locator('[data-testid="report-template-ksp-indicators"]');
    await expect(tableSection).toBeVisible();
    await expect(tableSection.getByRole('heading', { level: 4 })).toHaveText('성과지표');

    // 달성표에서 활동(실현) 및 단기성과(수정후확정 판정 변경에 따른 '실현') 확인
    const activityRow = page.locator('tbody tr', { hasText: '공무원 디지털 직무 교육' });
    await expect(activityRow).toBeVisible();
    await expect(activityRow).toContainText('실현');

    const shorttermRow = page.locator('tbody tr', { hasText: '디지털 행정 서비스 이용 확산' });
    await expect(shorttermRow).toBeVisible();
    await expect(shorttermRow).toContainText('실현'); // edited_verdict_status 반영
    await expect(shorttermRow).toContainText('포털 가입자 100만명 확보 목표를 적극적 홍보로 최종 달성 완료함.');

    // 제외 판단 3종(보완 필요, 채택 제외, 미확정)은 달성표에 0건
    await expect(page.locator('tbody tr', { hasText: '디지털 행정 기반 구축' })).toHaveCount(0);
    await expect(page.locator('tbody tr', { hasText: '대국민 행정 편의 증진' })).toHaveCount(0);
    await expect(page.locator('tbody tr', { hasText: '디지털 법제 정비' })).toHaveCount(0);

    // KSP 목차와 근거 창을 확인한다.
    for (const [id, title, badge] of [
      ['ksp-overview', '1. 사업 개요', undefined], ['ksp-results', '2. 종료평가 종합 결과', undefined],
      ['ksp-unclassified', '성과 서술 (분류 미확인)', { source: 'missing', text: '근거 미확보' }],
      ['ksp-factors', '기여요인', { source: 'missing', text: '근거 미확보' }],
      ['ksp-constraints', '제약요인', { source: 'missing', text: '근거 미확보' }],
      ['ksp-responses-lessons', '대응 노력과 교훈 (AI 제안 — PO 확정 필요)', { source: 'missing', text: '근거 미확보' }],
      ['ksp-monitoring', '성과 모니터링 계획', { source: 'missing', text: '근거 미확보' }],
      ['ksp-summary', '4) 총평 (AI 초안)', undefined], ['ksp-pdm', '3. PDM에 따른 성과관리 현황', undefined], ['ksp-midterm', '4. 중간평가', undefined],
    ] as const) {
      await expectHeadingTitleAndBadge(page.getByTestId(`report-template-${id}`), title, badge);
    }
    const sentenceButton = page.locator('[data-testid^="select-sentence-"]').first();
    await expect(sentenceButton).toBeVisible();
    await sentenceButton.click();
    const evidenceLink = page.locator('[data-testid^="open-source-context-"]').first();
    await expect(evidenceLink).toBeVisible();
    const sourceUrl = new URL((await evidenceLink.getAttribute('href'))!, 'http://example.test');
    const snippetId = sourceUrl.searchParams.get('snippet');
    expect(snippetId).toBeTruthy();
    await evidenceLink.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/review.*open=source`));
    await expect(page.getByRole('heading', { name: 'AI 제안 검토' })).toBeVisible();
    await expect(page.locator('[data-testid^="source-context-panel-"]')).toHaveCount(1);
    await expect(page.locator(`[id="evidence-${snippetId}"] [data-testid^="source-context-panel-"]`)).toBeVisible();

    // 다시 S6 보고서 화면으로 복귀하여 Word(DOCX) 다운로드 검증
    await page.goto(`/projects/${projectId}/report`);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="download-docx-button"]').click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toContain('.docx');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    if (stream) {
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
    }
    const docxBuffer = Buffer.concat(chunks);
    expect(docxBuffer.length).toBeGreaterThan(0);
    expect(docxBuffer.subarray(0, 2).toString('ascii')).toBe('PK');
    await download.delete().catch(() => {});

    // Word 문서 바이너리 열어 7개 절 및 제외 판단 0건 단언 (RQ-22)
    const extraction = await extractDocx(docxBuffer);
    expect(extraction.status).toBe('추출 완료');
    const docxText = extraction.paragraphs.map((p) => p.content).join('\n');

    const headings = ['1. 사업 개요', '2. 종료평가 종합 결과', '성과지표', '사업성과 평가', '기여요인', '제약요인', '대응 노력과 교훈', '성과 모니터링 계획', '4) 총평', '3. PDM에 따른 성과관리 현황', '4. 중간평가'];
    let previous = -1;
    for (const heading of headings) {
      const index = docxText.indexOf(heading, previous + 1);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }

    // 확정 지표 내용 포함 확인
    expect(docxText).toContain('공무원 디지털 직무 교육');
    expect(docxText).toContain('포털 가입자 100만명 확보 목표를 적극적 홍보로 최종 달성 완료함.');

    // 제외 판단 0건 단언
    expect(docxText).not.toContain('디지털 행정 기반 구축');
    expect(docxText).not.toContain('대국민 행정 편의 증진');
    expect(docxText).not.toContain('디지털 법제 정비');

    // 인용 금지 문장 글자 0건 단언
    expect(docxText).not.toContain('이름을 밝히지 말아');
    expect(docxText).not.toContain('[인용 금지 문장]');

    // ------------------------------------------------------------------------
    // [S7] 결과 ToC: 색·범례·미확정 확인 및 이력 이동
    // ------------------------------------------------------------------------
    await page.goto(`/projects/${projectId}/result`);
    await expect(page.getByRole('heading', { name: '결과 ToC' })).toBeVisible();
    await expectProjectTabs(page, projectId, 'result');

    // 1. 범례 8종 확인
    const legend = page.locator('[data-testid="result-toc-legend"]');
    await expect(legend).toBeVisible();
    for (const legendStatus of [
      '실현',
      '추진 중',
      '기대',
      '미확인',
      '근거 충돌',
      '보완 필요',
      '채택 제외',
      '미확정',
    ]) {
      await expect(legend).toContainText(legendStatus);
    }

    // 2. 상태별 배지 색 및 형태 단언
    // (1) 활동 (공무원 디지털 직무 교육): '실현' (초록 색상)
    const badgeActivity = page.locator('[role="treeitem"]', { hasText: '공무원 디지털 직무 교육' }).locator('[data-testid^="result-status-badge-"]');
    await expect(badgeActivity).toContainText('실현');
    await expect(badgeActivity).toHaveClass(/bg-emerald-100|text-emerald-800/);

    // (2) 단기성과 (디지털 행정 서비스 이용 확산): 수정 후 확정으로 '실현' 변경됨 -> 초록 색상
    const badgeShortterm = page.locator('[role="treeitem"]', { hasText: '디지털 행정 서비스 이용 확산' }).locator('[data-testid^="result-status-badge-"]');
    await expect(badgeShortterm).toContainText('실현');
    await expect(badgeShortterm).toHaveClass(/bg-emerald-100|text-emerald-800/);

    // (3) 산출물 (디지털 행정 기반 구축): '보완 필요' -> 회색 점선 테두리
    const badgeOutput = page.locator('[role="treeitem"]', { hasText: '디지털 행정 기반 구축' }).locator('[data-testid^="result-status-badge-"]');
    await expect(badgeOutput).toContainText('보완 필요');
    await expect(badgeOutput).toHaveClass(/border-dashed/);

    // (4) 영향 (대국민 행정 편의 증진): '채택 제외' -> 취소선
    const badgeConflict = page.locator('[role="treeitem"]', { hasText: '대국민 행정 편의 증진' }).locator('[data-testid^="result-status-badge-"]');
    await expect(badgeConflict).toContainText('채택 제외');
    await expect(badgeConflict).toHaveClass(/line-through/);

    // (5) 디지털 법제 정비: '미확정' -> 실선 테두리
    const badgeUnsupported = page.locator('[role="treeitem"]', { hasText: '디지털 법제 정비' }).locator('[data-testid^="result-status-badge-"]');
    await expect(badgeUnsupported).toContainText('미확정');
    await expect(badgeUnsupported).toHaveClass(/border-solid/);

    // 3. 이력은 Admin에게만 허용되므로 역할을 전환한 뒤 항목을 연다.
    await page.setExtraHTTPHeaders({ 'x-auth-request-user': 'admin' });
    await page.reload();
    const activityResultItem = page.locator('[role="treeitem"]', { hasText: '공무원 디지털 직무 교육' });
    await activityResultItem.click();

    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/history\\?indicatorId=`));
    await expect(page.getByRole('heading', { name: '확정 이력' })).toBeVisible();
    await expect(page.locator('[data-testid="history-row-0"]')).toBeVisible();
  });
});

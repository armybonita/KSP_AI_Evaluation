import { test, expect } from './isolated-test';
import type { Locator } from '@playwright/test';
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

test.describe('보고서 초안 및 Word 내려받기 E2E 시험 (#22, RQ-20, RQ-21, RQ-22, UC-06, UC-17, D04, D33, D35, FE-11)', () => {
  const PROJECT_ID = 'proj-dev-seed';
  const REVIEW_URL = `/projects/${PROJECT_ID}/review`;
  const REPORT_URL = `/projects/${PROJECT_ID}/report`;

  test('빈 상태: 확정 판단이 없으면 안내 문구와 S4 바로가기 링크가 보인다 (UC-17)', async ({
    page,
  }) => {
    // PDM은 있지만 확정이 없는 독립 시드 사업에서 보고서 빈 상태를 확인한다.
    const newProjectId = 'proj-multi-conflict';
    await page.goto(`/projects/${newProjectId}/report`);

    // 3. 확정한 판단 없음 안내 및 S4 링크 단언 (UC-17)
    const emptyState = page.locator('[data-testid="empty-report-state"]');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText('확정한 판단이 없습니다');

    const gotoReviewLink = page.locator('[data-testid="goto-review-link"]');
    await expect(gotoReviewLink).toBeVisible();
    await gotoReviewLink.click();

    // S4 화면으로 정상 이동 확인
    await expect(page).toHaveURL(`/projects/${newProjectId}/review`);
    await expect(page.getByRole('heading', { name: 'AI 제안 검토' })).toBeVisible();
  });

  test('확정 → S6 → 초안 생성 → [근거] 링크 동작 → Word(DOCX) 파일 내려받아 KSP 목차 및 금지 판단 0건 검증', async ({
    page,
  }) => {
    // ------------------------------------------------------------------------
    // 1. S4 화면에서 4가지 판단 수행 (확정, 수정 후 확정, 미확인 확정, 보완 필요)
    // ------------------------------------------------------------------------
    await page.goto(REVIEW_URL);
    await expect(page.getByRole('heading', { name: 'AI 제안 검토' })).toBeVisible();

    // 1-1. 활동 지표(ind-activity): '확정'
    await page.locator('[data-testid="indicator-item-ind-activity"]').click();
    await page.locator('[data-testid="confirmer-name-input"]').fill('평가자A');
    await page.locator('[data-testid="confirm-btn-확정"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toBeVisible();

    // 1-2. 단기성과 지표(ind-shortterm): '수정 후 확정'
    await page.locator('[data-testid="indicator-item-ind-shortterm"]').click();
    await page.locator('[data-testid="confirm-btn-수정후확정"]').click();
    await page
      .locator('[data-testid="edited-text-input"]')
      .fill('가입자 100만명 확보를 위해 적극적 홍보를 전개하여 목표에 근접함.');
    await page
      .locator('[data-testid="reason-input"]')
      .fill('실적 문서 확인에 따른 수치 정정');
    await page.locator('[data-testid="save-edit-confirm-button"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toBeVisible();

    // 1-3. 중기성과 지표(ind-midterm, '미확인' 판정): '확정' (D33 대상)
    await page.locator('[data-testid="indicator-item-ind-midterm"]').click();
    await page.locator('[data-testid="confirm-btn-확정"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toBeVisible();

    // 1-4. 영향 지표(ind-conflict, '근거 충돌' 판정): '보완 필요' (보고서 제외 대상, D04)
    await page.locator('[data-testid="indicator-item-ind-conflict"]').click();
    await page.locator('[data-testid="confirm-btn-보완필요"]').click();
    await expect(page.locator('[data-testid="confirm-success-message"]')).toBeVisible();

    // ------------------------------------------------------------------------
    // 2. S6 보고서 화면으로 이동
    // ------------------------------------------------------------------------
    await page.goto(REPORT_URL);
    await expect(page.getByRole('heading', { name: '⑧ 종료평가보고서 종합' })).toBeVisible();

    // 요약 헤더 문구 확인: 확정 3건, 보완 필요·채택 제외·미확정 제외 안내 (SP S6)
    const summaryBar = page.locator('[data-testid="report-summary-bar"]');
    await expect(summaryBar).toBeVisible();
    await expect(summaryBar).toContainText(
      '자격을 갖춘 근거'
    );

    // ------------------------------------------------------------------------
    // 3. [초안 만들기] 버튼 클릭 및 KSP 목차 렌더링 확인 (D35, D33, RQ-20)
    // ------------------------------------------------------------------------
    const generateBtn = page.locator('[data-testid="generate-draft-button"]');
    await expect(generateBtn).toBeVisible();
    await page.getByLabel('보고서 서식').selectOption('ksp');
    await generateBtn.click();
    await expect(summaryBar).toContainText('지표 확정 3');
    await expect(summaryBar).toContainText('노트 확정');

    // 초안 내용 영역 확인
    const reportContent = page.locator('[data-testid="report-content"]');
    await expect(reportContent).toBeVisible();
    await expect(page.getByTestId('draft-confirmed-count')).toHaveText('생성된 초안 확정 건수 3');

    // 1절: 성과지표 달성표 확인
    const achievementSection = page.locator('[data-testid="report-template-ksp-indicators"]');
    await expect(achievementSection).toBeVisible();
    await expect(achievementSection.getByRole('heading', { level: 4 })).toHaveText(
      '성과지표'
    );

    // 달성표 행 검증: 활동(실현), 단기성과(추진 중), 중기성과(근거 미확인 D33)
    await expect(achievementSection.getByRole('row', { name: /공무원 디지털 직무 교육/ })).toBeVisible();
    await expect(achievementSection.getByRole('row', { name: /디지털 행정 서비스 이용 확산/ })).toBeVisible();

    const midtermRow = achievementSection.getByRole('row', { name: /행정 효율성 증대/ });
    await expect(midtermRow).toBeVisible();
    // D33 단언: '미확인' 확정 지표는 달성 실적 대신 근거 미확인으로 표기
    await expect(midtermRow).toContainText('근거 미확인');

    // D04 단언: '보완 필요'(ind-conflict) 및 미확정 지표는 달성표에 존재하지 않음
    await expect(achievementSection.getByRole('row', { name: /대국민 행정 편의 증진/ })).toHaveCount(0);
    await expect(achievementSection.getByRole('row', { name: /디지털 행정 기반 구축/ })).toHaveCount(0);

    // 2절: 성과 분석 서술 확인 (RQ-21)
    const analysisSection = page.locator('[data-testid="report-template-ksp-unclassified"]');
    await expect(analysisSection).toBeVisible();
    await expectHeadingTitleAndBadge(analysisSection, '성과 서술 (분류 미확인)', { source: 'missing', text: '근거 미확보' });

    // D33 단언: '미확인' 확정 지표(ind-midterm)는 서술 절에 문장이 없음
    await expect(
      page.locator('[data-testid^="select-sentence-ind-midterm-"]')
    ).toHaveCount(0);

    // 나머지 KSP 목차와 문장의 근거 각주, 원문 창 자동 열기 확인
    for (const [id, title, badge] of [
      ['ksp-overview', '1. 사업 개요', undefined], ['ksp-results', '2. 종료평가 종합 결과', undefined],
      ['ksp-factors', '기여요인', { source: 'missing', text: '근거 미확보' }],
      ['ksp-constraints', '제약요인', { source: 'missing', text: '근거 미확보' }],
      ['ksp-responses-lessons', '대응 노력과 교훈 (AI 제안 — PO 확정 필요)', { source: 'missing', text: '근거 미확보' }],
      ['ksp-monitoring', '성과 모니터링 계획', { source: 'missing', text: '근거 미확보' }],
      ['ksp-summary', '4) 총평 (AI 초안)', undefined], ['ksp-pdm', '3. PDM에 따른 성과관리 현황', undefined], ['ksp-midterm', '4. 중간평가', undefined],
    ] as const) {
      await expectHeadingTitleAndBadge(page.getByTestId(`report-template-${id}`), title, badge);
    }
    const activitySentence = page.locator('[data-testid^="select-sentence-ind-activity-"]').first();
    await expect(activitySentence).toBeVisible();
    await expect(activitySentence).toHaveAttribute('aria-label', '근거: 공무원 디지털 직무 교육');
    await activitySentence.click();
    const activityEvidenceLink = page.locator('[data-testid^="open-source-context-"]').first();
    await expect(activityEvidenceLink).toBeVisible();
    const sourceUrl = new URL((await activityEvidenceLink.getAttribute('href'))!, 'http://example.test');
    const snippetId = sourceUrl.searchParams.get('snippet');
    expect(snippetId).toBeTruthy();
    await activityEvidenceLink.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/review.*ind-activity.*open=source`));
    await expect(page.locator('[data-testid="selected-indicator-name"]')).toHaveText('공무원 디지털 직무 교육');
    await expect(page.locator('[data-testid^="source-context-panel-"]')).toHaveCount(1);
    await expect(page.locator(`[id="evidence-${snippetId}"] [data-testid^="source-context-panel-"]`)).toBeVisible();

    // ------------------------------------------------------------------------
    // 5. 다시 S6 로 복귀하여 [Word 로 내려받기] 수행 및 파일 검증 (RQ-22, UC-06)
    // ------------------------------------------------------------------------
    await page.goto(REPORT_URL);
    await expect(page.getByRole('heading', { name: '⑧ 종료평가보고서 종합' })).toBeVisible();

    const downloadButton = page.locator('[data-testid="download-docx-button"]');
    await expect(downloadButton).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await downloadButton.click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toContain('.docx');
    const failure = await download.failure();
    expect(failure).toBeNull();

    // 파일 스트림을 인메모리 버퍼로 읽음 (디스크 저장 불필요 -> 자료 경계 준수)
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

    // 다운로드 임시 파일 정리
    await download.delete().catch(() => {});

    // Word 문서 바이너리를 extractDocx 로 열어 일곱 절 및 배제 단언 (RQ-22)
    const extraction = await extractDocx(docxBuffer);
    expect(extraction.status).toBe('추출 완료');

    const fullDocxText = extraction.paragraphs.map((p) => p.content).join('\n');

    // KSP 목차가 같은 순서로 Word에 존재한다.
    const headings = ['1. 사업 개요', '2. 종료평가 종합 결과', '성과지표', '사업성과 평가', '기여요인', '제약요인', '대응 노력과 교훈', '성과 모니터링 계획', '4) 총평', '3. PDM에 따른 성과관리 현황', '4. 중간평가'];
    let previous = -1;
    for (const heading of headings) {
      const index = fullDocxText.indexOf(heading, previous + 1);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }

    // 정상 확정 내용 포함
    expect(fullDocxText).toContain('공무원 디지털 직무 교육');

    // 보완 필요 지표('대국민 행정 편의 증진') 문장 0건 (RQ-22, D04)
    expect(fullDocxText).not.toContain('대국민 행정 편의 증진');

    // 미확정 지표('디지털 행정 기반 구축') 문장 0건 (RQ-22)
    expect(fullDocxText).not.toContain('디지털 행정 기반 구축');

    // 인용 금지 문장 글자 0건 (RQ-14)
    expect(fullDocxText).not.toContain('면담에 참여한 현지 실무관은 이름을 밝히지 말아');
    expect(fullDocxText).not.toContain('이름을 밝히지 말아');
    expect(fullDocxText).not.toContain('[인용 금지 문장]');
  });
});

import os from 'node:os';
import { expect, test } from './isolated-test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeDatabase, createDocument, createProject, insertParagraphs, openDatabase } from '../../src/server/store';
import { saveNoteReview } from '../../src/server/store/note-review';
import { replaceProjectOntology } from '../../src/server/store/ontology';

const projectId = 'proj-summary-e2e';
const workflowProjectId = 'proj-dev-seed';
const shotsDir = process.env.AIEAS_REPORT_SHOTS_DIR ?? path.join(os.tmpdir(), 'aieas-report-shots');

function seedVirtualSummaryProject() {
  const dbPath = process.env.AIEAS_DB_PATH;
  if (!dbPath) throw new Error('Isolated E2E database path is not configured.');
  const db = openDatabase(dbPath);
  try {
    createProject({ id: projectId, name: '가상 EIPP 다절 요약시험', project_type: 'EIPP', created_at: '2026-11-02' }, db);
    createDocument({ id: 'doc-summary-e2e', project_id: projectId, file_name: '가상 요약 근거.docx', file_type: 'docx', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-11-02' }, db);

    const nodeSpecs = [
      { id: 'OUT-M-R2-FINANCE', type: 'outcome-mid', title: '가상 재원연계 성과', outcome_family: '개발협력', text: '가상 재원연계 성과가 확인되었다.', status: '확정' },
      { id: 'OUT-M-R2-POLICY', type: 'outcome-mid', title: '가상 정책 성과', outcome_family: '정책', text: '가상 정책 성과가 확인되었다.', status: '수정 후 확정' },
      { id: 'OUT-M-R2-TRADE', type: 'outcome-mid', title: '가상 교류 성과', outcome_family: '경제협력', text: '가상 교류 성과가 확인되었다.', status: '확정' },
      { id: 'FAC-E-R2', type: 'enabler', title: '가상 기여요인', text: '가상 기여요인이 확인되었다.', status: '확정' },
      { id: 'FAC-C-R2', type: 'constraint', title: '가상 제약요인', text: '가상 제약요인이 확인되었다.', status: '확정' },
    ] as const;
    insertParagraphs(nodeSpecs.map((node, index) => ({ id: `para-summary-e2e-${index + 1}`, document_id: 'doc-summary-e2e', sequence_no: index + 1, location: `가상 위치 ${index + 1}`, content: node.text })) , db);
    const nodes = Object.fromEntries(nodeSpecs.map(node => [node.id, { type: node.type, title: node.title, description: node.text, outcome_family: 'outcome_family' in node ? node.outcome_family : undefined, level_ai: '4', confidence_ai: '높음' }]));
    const snippets = Object.fromEntries(nodeSpecs.map((node, index) => [`SN-R2-${index + 1}`, { source: 'SRC-R2', locator: `가상 위치 ${index + 1}`, quote: node.text, evidence_level: '입증', speaker: '수행기관', proves: [node.id] }]));
    const graph = {
      code: 'summary-e2e', projectName: '가상 EIPP 다절 요약시험', project: {},
      sources: { 'SRC-R2': { title: '가상 요약 근거.docx', document_id: 'doc-summary-e2e' } },
      snippets, nodes, edges: [], reports: {}, report_status: {}, issues: [],
    };
    const imported = replaceProjectOntology(projectId, graph, '가상 E2E', db);
    for (const node of nodeSpecs) saveNoteReview(projectId, imported.id, node.id, {
      status: node.status,
      text: node.text,
      outcomeState: '관측됨',
      reason: node.status === '수정 후 확정' ? '가상 근거 확인에 따른 문안 확정' : '',
      errorType: node.status === '수정 후 확정' ? '근거 부족' : '',
    }, '가상 평가자', db);
  } finally {
    closeDatabase();
  }
}

test('기존 검토 지표 확정 뒤 ④→⑤→⑥→⑦→보고서 이동 및 초안을 확인한다', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(`/projects/${workflowProjectId}/review`);
  await page.getByTestId('indicator-item-ind-activity').click();
  await page.getByTestId('confirmer-name-input').fill('가상 평가자');
  await page.getByTestId('confirm-btn-확정').click();
  await expect(page.getByTestId('confirm-success-message')).toBeVisible();

  const next = page.getByTestId('workflow-next');
  for (const label of ['다음: ⑤ 단기성과→', '다음: ⑥ 중·장기성과→', '다음: ⑦ 기여·제약요인→']) {
    await expect(next).toHaveText(label);
    await next.click();
  }
  await expect(next).toHaveText('종료평가보고서 작성→');
  await next.click();
  await expect(page).toHaveURL(new RegExp(`${workflowProjectId}/report$`));
  await page.getByLabel('보고서 서식').selectOption('eipp');
  await page.getByTestId('generate-draft-button').click();
  await expect(page.getByTestId('report-content')).toBeVisible({ timeout: 30000 });
  for (const id of ['eipp-overview', 'eipp-results', 'eipp-analysis', 'eipp-monitoring', 'eipp-evaluation']) {
    await expect(page.getByTestId(`report-template-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('report-source-ai').first()).toBeVisible();
  const footnote = page.locator('[data-testid^="report-footnote-"]').first();
  await expect(footnote).toBeVisible();
  await footnote.click();
  await expect(page.getByTestId('report-evidence-panel')).toBeVisible();
  await expect(page.getByTestId('report-evidence-panel').locator('blockquote').first()).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('download-docx-button').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  let bytes = 0;
  for await (const chunk of stream!) bytes += Buffer.byteLength(chunk);
  expect(bytes).toBeGreaterThan(0);
});

test('가상 확정 근거 여러 절의 본문·출처·각주를 확인한다', async ({ page }) => {
  test.setTimeout(120000);
  seedVirtualSummaryProject();
  await page.goto(`/projects/${projectId}/review`);
  await expect(page.getByRole('heading', { name: 'AI 제안 검토' })).toBeVisible();
  await page.goto(`/projects/${projectId}/report`);
  await expect(page.getByRole('heading', { name: '⑧ 종료평가보고서 종합' })).toBeVisible();
  await page.getByLabel('보고서 서식').selectOption('eipp');
  await page.getByTestId('generate-draft-button').click();
  await expect(page.getByTestId('report-content')).toBeVisible({ timeout: 30000 });
  for (const id of ['eipp-overview', 'eipp-results', 'eipp-indicators', 'eipp-analysis', 'eipp-financing', 'eipp-policy', 'eipp-trade', 'eipp-incidental', 'eipp-factors', 'eipp-constraints', 'eipp-lessons', 'eipp-monitoring', 'eipp-evaluation']) {
    await expect(page.getByTestId(`report-template-${id}`)).toBeVisible();
  }
  const expectedSections = [
    ['eipp-financing', '가상 재원연계 성과가 확인되었다.', 2, 0, 0, 1, 1],
    ['eipp-policy', '가상 정책 성과가 확인되었다.', 2, 1, 0, 2, 2],
    ['eipp-trade', '가상 교류 성과가 확인되었다.', 2, 0, 0, 1, 3],
    ['eipp-factors', '가상 기여요인이 확인되었다.', 2, 0, 0, 1, 4],
    ['eipp-constraints', '가상 제약요인이 확인되었다.', 2, 0, 0, 1, 5],
  ] as const;
  for (const [id, body, aiCount, humanCount, missingCount, referenceCount, footnoteNumber] of expectedSections) {
    const section = page.getByTestId(`report-template-${id}`);
    await expect(section.getByText(body, { exact: true }).first()).toBeVisible();
    await expect(section.getByTestId('report-source-ai')).toHaveCount(aiCount);
    await expect(section.getByTestId('report-source-human')).toHaveCount(humanCount);
    await expect(section.getByTestId('report-source-missing')).toHaveCount(missingCount);
    const references = section.locator('[data-testid^="report-footnote-"]');
    await expect(references).toHaveCount(referenceCount);
    await expect(section.getByTestId(`report-footnote-${footnoteNumber}`).first()).toHaveText(`[${footnoteNumber}]`);
  }
  const incidental = page.getByTestId('report-template-eipp-incidental');
  await expect(incidental.getByText('※ 근거 자료 미확보', { exact: true }).first()).toBeVisible();
  await expect(incidental.getByTestId('report-source-missing')).toHaveCount(2);
  const policy = page.getByTestId('report-template-eipp-policy');
  await expect(policy.getByTestId('select-sentence-OUT-M-R2-POLICY-0')).toBeVisible();
  await expect(policy.getByTestId('select-sentence-OUT-M-R2-POLICY-1')).toBeVisible();
  const footnote = page.locator('[data-testid^="report-footnote-"]').first();
  await expect(footnote).toBeVisible();
  await footnote.click();
  await expect(page.getByTestId('report-evidence-panel')).toBeVisible();
  await expect(page.getByTestId('report-evidence-panel').locator('blockquote').first()).toBeVisible();
  await expect(page.getByTestId('report-evidence-panel')).toContainText('가상 평가자');
  const entries = page.locator('[data-testid^="report-footnote-entry-"]');
  await expect(entries).toHaveCount(5);
  for (let index = 1; index <= 5; index++) {
    await expect(page.getByTestId(`report-footnote-entry-${index}`)).toHaveText(`[${index}] 가상 요약 근거.docx · 가상 위치 ${index}`);
  }

  await fs.mkdir(shotsDir, { recursive: true });
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, fraction] of [['top', 0], ['middle', 0.5], ['bottom', 1]] as const) {
      await page.evaluate((value) => window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * value), fraction);
      await page.screenshot({ path: path.join(shotsDir, `report-${width}-${name}.png`) });
    }
  }

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('download-docx-button').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  let bytes = 0;
  for await (const chunk of stream!) bytes += Buffer.byteLength(chunk);
  expect(bytes).toBeGreaterThan(0);
});

test('새 초안 생성 뒤 이전 평가팀 확정판을 선택해 기획팀 Word를 내려받는다', async ({ page }) => {
  test.setTimeout(120000);
  seedVirtualSummaryProject();
  await page.goto(`/projects/${projectId}/report`);
  await page.getByLabel('보고서 서식').selectOption('eipp');
  await page.getByTestId('generate-draft-button').click();
  await expect(page.getByTestId('report-content')).toBeVisible({ timeout: 30000 });

  await page.getByTestId('finalize-report-button').click();
  const pendingWarning = page.getByTestId('report-finalize-warning');
  if (await pendingWarning.isVisible()) await pendingWarning.getByRole('button', { name: '확인 후 최종 확정' }).click();
  await expect(page.getByText(/문안: 최종 확정 \(평가팀/)).toBeVisible();

  const versionSelect = page.getByTestId('report-version-select');
  const finalizedVersionId = await versionSelect.locator('option').evaluateAll(options => {
    const option = options.find(item => item.textContent?.includes('최종 확정')) as HTMLOptionElement | undefined;
    return option?.value ?? '';
  });
  expect(finalizedVersionId).not.toBe('');

  await page.getByTestId('generate-draft-button').click();
  await expect(page.getByTestId('report-content')).toBeVisible({ timeout: 30000 });
  const versionOptions = versionSelect.locator('option');
  await expect(versionOptions).toHaveCount(3);
  await expect(versionOptions.filter({ hasText: /v1 · 초안 ·/ })).toHaveCount(1);
  await expect(versionOptions.filter({ hasText: /v1 · 최종 확정 \(/ })).toHaveCount(1);
  await expect(versionOptions.filter({ hasText: /v2 · 초안 ·/ })).toHaveCount(1);
  await expect(versionSelect.locator('option:checked')).toContainText(/v2 · 초안 ·/);

  await page.context().setExtraHTTPHeaders({ 'x-auth-request-user': 'planner' });
  await page.reload();
  const plannerVersions = page.getByTestId('report-version-select');
  await expect(plannerVersions).toBeVisible();
  await expect(plannerVersions.locator('option:checked')).toContainText(/v2 · 초안 ·/);
  await plannerVersions.selectOption(finalizedVersionId);
  await expect(plannerVersions.locator('option:checked')).toContainText(/v1 · 최종 확정 \(/);
  await expect(page.getByText(/문안: 최종 확정 \(평가팀/)).toBeVisible();
  await expect(page.getByTestId('download-docx-button')).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('download-docx-button').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.docx$/i);
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  let bytes = 0;
  for await (const chunk of stream!) bytes += Buffer.byteLength(chunk);
  expect(bytes).toBeGreaterThan(0);
});

import { test, expect } from './isolated-test';
import path from 'node:path';

test.describe('S1 사업 만들기 및 S2 자료 등록·분류·기본 제외 E2E 시험 (RQ-01, RQ-02, RQ-04, RQ-05, D06, D14, D29, D31, D47, UC-01, UC-02, UC-13, UC-15)', () => {
  const fixturesDir = path.resolve(__dirname, '../../fixtures');

  test('S1 사업 만들기 -> S2 묶음 올리기 -> 제외 이유 -> 종류·포함 변경 유지 -> 지원하지 않는 형식 거부 -> 두 사업 분리', async ({
    page,
  }) => {
    // -------------------------------------------------------------
    // 1. S1 사업 목록 (/projects)
    // -------------------------------------------------------------
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: '사업 목록' })).toBeVisible();

    // 1-1. 빈 이름 오류 (D47)
    const nameInput = page.getByTestId('project-name-input');
    const createBtn = page.getByTestId('project-create-button');

    await nameInput.fill('   ');
    await createBtn.click();
    await expect(page.getByTestId('project-name-error')).toHaveText('사업 이름을 입력해 주세요.');

    // 1-2. 새 사업 A 생성 -> S2 이동 (FE-15, UC-01)
    const projectAName = 'E2E 가상국 사업 A';
    await nameInput.fill(projectAName);
    await createBtn.click();

    // S2 로 자동 이동 완료 대기 (Next.js 최초 라우트 컴파일 시간 고려)
    await expect(page.getByRole('heading', { name: '자료 등록' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('project-name-display')).toHaveText(projectAName);

    const projectAUrl = page.url();
    expect(projectAUrl).toContain('/documents');

    // -------------------------------------------------------------
    // 2. S2 가상 파일 여러 개 한 번에 올리기 (RQ-02, UC-02)
    // -------------------------------------------------------------
    const filesToUpload = [
      path.join(fixturesDir, '01_project_plan.hwpx'),
      path.join(fixturesDir, '02_pdm.docx'),
      path.join(fixturesDir, '05_other_project.docx'),
      path.join(fixturesDir, '06_personal_memo.pdf'),
    ];

    const fileInput = page.getByTestId('file-upload-input');
    await fileInput.setInputFiles(filesToUpload);

    // 업로드 후 4개 파일이 테이블에 표시됨을 대기
    await expect(page.getByTestId('documents-table')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(4);

    // 2-1. 기본 제외 및 제외 이유 표시 확인 (RQ-05, UC-13, D14)
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

    // 01_project_plan.hwpx: 사업계획서 + 추출 완료 + 포함
    const doc01Row = page.locator('tbody tr', { hasText: '01_project_plan.hwpx' });
    await expect(doc01Row.locator('[data-testid^="doc-type-select-"]')).toHaveValue('사업계획서');
    await expect(doc01Row.locator('[data-testid^="doc-status-"]')).toContainText('추출 완료');
    await expect(doc01Row.locator('[data-testid^="doc-inclusion-select-"]')).toHaveValue('포함');

    // 2-2. 문단 미리보기 확인 (D06)
    await doc01Row.click();
    const previewPanel = page.getByTestId('paragraph-preview-panel');
    await expect(previewPanel).toBeVisible();
    await expect(previewPanel).toContainText('01_project_plan.hwpx');

    // -------------------------------------------------------------
    // 3. 종류·포함 변경 및 새로 고침 뒤 유지 (RQ-04, RQ-05, D31)
    // -------------------------------------------------------------
    // 05_other_project.docx 의 종류를 '심사 의견'으로, 포함 여부를 '포함'으로 변경
    const doc05TypeSelect = doc05Row.locator('[data-testid^="doc-type-select-"]');
    await doc05TypeSelect.selectOption('심사 의견');
    await expect(doc05TypeSelect).toHaveValue('심사 의견');

    const doc05InclusionSelect = doc05Row.locator('[data-testid^="doc-inclusion-select-"]');
    await doc05InclusionSelect.selectOption('포함');
    await expect(doc05InclusionSelect).toHaveValue('포함');

    // D31 안내 문구 표시 확인
    await expect(page.getByTestId('inclusion-notice')).toHaveText(/다음 \[제안 받기\]부터 반영/);

    // 새로 고침 뒤에도 변경 내용 영속 유지 확인
    await page.reload();
    await expect(page.getByRole('heading', { name: '자료 등록' })).toBeVisible();

    const reloadedDoc05Row = page.locator('tbody tr', { hasText: '05_other_project.docx' });
    await expect(reloadedDoc05Row.locator('[data-testid^="doc-type-select-"]')).toHaveValue('심사 의견');
    await expect(reloadedDoc05Row.locator('[data-testid^="doc-inclusion-select-"]')).toHaveValue('포함');

    // -------------------------------------------------------------
    // 4. 지원하지 않는 형식 거부 (RQ-02, UC-15)
    // -------------------------------------------------------------
    // 가상의 .txt 파일 업로드 시도
    await fileInput.setInputFiles({
      name: 'unsupported_memo.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('이 파일은 텍스트 메모 파일입니다.'),
    });

    // 거부 알림 확인 (표에 추가되지 않고 이유 보임)
    const rejectedAlert = page.getByTestId('rejected-files-section');
    await expect(rejectedAlert).toBeVisible();
    await expect(rejectedAlert).toContainText('unsupported_memo.txt');
    await expect(rejectedAlert).toContainText(
      '지원하지 않는 형식입니다 (HWP · HWPX · PDF · DOC · DOCX 만 받습니다)'
    );

    // 파일 수는 여전히 4개
    await expect(page.locator('tbody tr')).toHaveCount(4);
    await expect(page.locator('tbody tr', { hasText: 'unsupported_memo.txt' })).toHaveCount(0);

    // -------------------------------------------------------------
    // 5. 두 사업 분리 (RQ-01)
    // -------------------------------------------------------------
    // 다시 S1 으로 이동
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: '사업 목록' })).toBeVisible();

    // 새 사업 B 생성
    const projectBName = 'E2E 가상국 사업 B';
    await page.getByTestId('project-name-input').fill(projectBName);
    await page.getByTestId('project-create-button').click();

    // 사업 B 의 S2 로 이동 완료 대기
    await expect(page.getByRole('heading', { name: '자료 등록' })).toBeVisible();
    await expect(page.getByTestId('project-name-display')).toHaveText(projectBName);

    // 사업 B 에는 사업 A 의 자료가 없어야 함
    await expect(page.getByTestId('empty-documents-notice')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(0);
  });
});

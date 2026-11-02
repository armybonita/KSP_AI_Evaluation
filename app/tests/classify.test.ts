import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import answers from '../fixtures/answers.json';
import { extractDocument } from '../src/server/extract';
import {
  classifyDocument,
  extractProjectPlanInfo,
  maskForbiddenSentenceInContent,
} from '../src/server/classify';
import {
  getUploadDirectory,
  isSupportedExtension,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_BATCH,
  processUploadedFile,
  sanitizeProjectId,
  verifyFileSignature,
} from '../src/server/documents';
import {
  closeDatabase,
  createProject,
  getDocument,
  openDatabase,
} from '../src/server/store';
import { uploadDocumentsAction } from '../src/app/projects/[projectId]/documents/actions';
import JSZip from 'jszip';

describe('문서 형식 검사, 규칙 기반 분류 및 기본 제외 단위 시험 (RQ-02, RQ-04, RQ-05, D02, D14, D29, UC-15)', () => {
  const fixturesDir = path.resolve(__dirname, '../fixtures');

  // ---------------- 1. 파일 형식 검사 (RQ-02, UC-15) ----------------
  it('(형식 검사) HWP, HWPX, PDF, DOC, DOCX 를 지원하고 그 외 확장자는 거부한다', () => {
    // 지원하는 형식
    expect(isSupportedExtension('file.hwp')).toBe(true);
    expect(isSupportedExtension('file.HWP')).toBe(true);
    expect(isSupportedExtension('file.hwpx')).toBe(true);
    expect(isSupportedExtension('file.HWPX')).toBe(true);
    expect(isSupportedExtension('file.pdf')).toBe(true);
    expect(isSupportedExtension('file.PDF')).toBe(true);
    expect(isSupportedExtension('file.doc')).toBe(true);
    expect(isSupportedExtension('file.DOC')).toBe(true);
    expect(isSupportedExtension('file.docx')).toBe(true);
    expect(isSupportedExtension('file.DOCX')).toBe(true);
    expect(isSupportedExtension('.pdf')).toBe(true);

    // 지원하지 않는 형식 (거부 대상)
    expect(isSupportedExtension('file.txt')).toBe(false);
    expect(isSupportedExtension('file.xlsx')).toBe(false);
    expect(isSupportedExtension('file.pptx')).toBe(false);
    expect(isSupportedExtension('file.zip')).toBe(false);
    expect(isSupportedExtension('file')).toBe(false);
  });

  it('(내용 시그니처 검사) 확장자와 내용 시그니처가 일치하지 않으면 "형식이 확장자와 다릅니다"로 거부된다', async () => {
    // 1. PDF 시그니처 (%PDF-)
    const validPdfBuffer = Buffer.from('%PDF-1.4\n%test');
    const invalidPdfBuffer = Buffer.from('NOT_A_PDF_CONTENT');
    expect((await verifyFileSignature('pdf', validPdfBuffer)).valid).toBe(true);
    const pdfCheck = await verifyFileSignature('pdf', invalidPdfBuffer);
    expect(pdfCheck.valid).toBe(false);
    expect(pdfCheck.reason).toBe('형식이 확장자와 다릅니다');

    // 2. DOCX 시그니처 (ZIP 이고 word/document.xml 포함)
    const validDocxZip = new JSZip();
    validDocxZip.file('word/document.xml', '<xml></xml>');
    const validDocxBuffer = await validDocxZip.generateAsync({ type: 'nodebuffer' });

    const nonDocxZip = new JSZip();
    nonDocxZip.file('other.xml', '<xml></xml>');
    const nonDocxZipBuffer = await nonDocxZip.generateAsync({ type: 'nodebuffer' });

    const notZipBuffer = Buffer.from('NOT_A_ZIP');

    expect((await verifyFileSignature('docx', validDocxBuffer)).valid).toBe(true);
    const docxCheck1 = await verifyFileSignature('docx', nonDocxZipBuffer);
    expect(docxCheck1.valid).toBe(false);
    expect(docxCheck1.reason).toBe('형식이 확장자와 다릅니다');
    const docxCheck2 = await verifyFileSignature('docx', notZipBuffer);
    expect(docxCheck2.valid).toBe(false);
    expect(docxCheck2.reason).toBe('형식이 확장자와 다릅니다');

    // 3. HWPX 시그니처 (ZIP 이고 Contents/section0.xml 포함 또는 mimetype 이 hwp+zip)
    const validHwpxZip1 = new JSZip();
    validHwpxZip1.file('Contents/section0.xml', '<xml></xml>');
    const validHwpxBuffer1 = await validHwpxZip1.generateAsync({ type: 'nodebuffer' });

    const validHwpxZip2 = new JSZip();
    validHwpxZip2.file('mimetype', 'application/hwp+zip');
    const validHwpxBuffer2 = await validHwpxZip2.generateAsync({ type: 'nodebuffer' });

    const invalidHwpxZip = new JSZip();
    invalidHwpxZip.file('random.txt', 'hello');
    const invalidHwpxBuffer = await invalidHwpxZip.generateAsync({ type: 'nodebuffer' });

    expect((await verifyFileSignature('hwpx', validHwpxBuffer1)).valid).toBe(true);
    expect((await verifyFileSignature('hwpx', validHwpxBuffer2)).valid).toBe(true);
    const hwpxCheck1 = await verifyFileSignature('hwpx', invalidHwpxBuffer);
    expect(hwpxCheck1.valid).toBe(false);
    expect(hwpxCheck1.reason).toBe('형식이 확장자와 다릅니다');
    const hwpxCheck2 = await verifyFileSignature('hwpx', notZipBuffer);
    expect(hwpxCheck2.valid).toBe(false);
    expect(hwpxCheck2.reason).toBe('형식이 확장자와 다릅니다');

    // 4. HWP·DOC 시그니처 (CFB/OLE 매직 바이트)
    const cfbBuffer = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
    expect((await verifyFileSignature('hwp', cfbBuffer)).valid).toBe(true);
    expect((await verifyFileSignature('doc', cfbBuffer)).valid).toBe(true);
    expect((await verifyFileSignature('hwp', validPdfBuffer)).reason).toBe(
      '형식이 확장자와 다릅니다'
    );
    expect((await verifyFileSignature('hwp', validHwpxBuffer1)).reason).toBe(
      '형식이 확장자와 다릅니다'
    );
    expect((await verifyFileSignature('doc', validPdfBuffer)).reason).toBe(
      '형식이 확장자와 다릅니다'
    );
    expect((await verifyFileSignature('doc', validHwpxBuffer1)).reason).toBe(
      '형식이 확장자와 다릅니다'
    );
  });

  it('(크기 제한 및 개수 한도) 파일당 50MB 초과 및 한 번에 20개 초과는 거부된다', async () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_FILES_PER_BATCH).toBe(20);

    const testDb = path.join(os.tmpdir(), `test-limit-${Date.now()}.db`);
    const testUploadDir = path.join(os.tmpdir(), `test-upload-limit-${Date.now()}`);
    process.env.AIEAS_DB_PATH = testDb;
    process.env.AIEAS_UPLOAD_DIR = testUploadDir;
    openDatabase(testDb);
    createProject({ id: 'proj-limit-test', name: '한도 테스트', created_at: new Date().toISOString() });

    try {
      // 50MB 초과 파일 가상 버퍼 (50MB + 10바이트)
      const oversizedBuffer = Buffer.alloc(50 * 1024 * 1024 + 10);
      oversizedBuffer.write('%PDF-1.4', 0); // 시작은 정상 PDF 시그니처

      const res = await processUploadedFile('proj-limit-test', 'large.pdf', oversizedBuffer);
      expect(res.success).toBe(false);
      expect((res as any).rejected).toBe(true);
      expect((res as any).reason).toContain('50MB');

      // 시그니처 불일치 파일 processUploadedFile 거부 및 DB 미저장 검증
      const fakePdfBuffer = Buffer.from('THIS_IS_NOT_A_PDF');
      const sigMismatchRes = await processUploadedFile('proj-limit-test', 'fake.pdf', fakePdfBuffer);
      expect(sigMismatchRes.success).toBe(false);
      expect((sigMismatchRes as any).rejected).toBe(true);
      expect((sigMismatchRes as any).reason).toBe('형식이 확장자와 다릅니다');

      const fakeHwpPdfRes = await processUploadedFile(
        'proj-limit-test',
        'fake.hwp',
        Buffer.from('%PDF-1.4 fake')
      );
      const fakeHwpZipRes = await processUploadedFile(
        'proj-limit-test',
        'fake.hwp',
        Buffer.from('NOT_A_ZIP')
      );
      expect(fakeHwpPdfRes.success).toBe(false);
      expect((fakeHwpPdfRes as any).reason).toBe('형식이 확장자와 다릅니다');
      expect(fakeHwpZipRes.success).toBe(false);
      expect((fakeHwpZipRes as any).reason).toBe('형식이 확장자와 다릅니다');

      // 20개 초과 파일 업로드 거부 검증 (21개)
      const formData = new FormData();
      for (let i = 0; i < 21; i++) {
        formData.append('files', new File(['%PDF-1.4 test'], `file_${i}.pdf`, { type: 'application/pdf' }));
      }
      const batchRes = await uploadDocumentsAction('proj-limit-test', formData);
      expect(batchRes.success).toBe(false);
      expect(batchRes.errors.length).toBeGreaterThan(0);
      expect(batchRes.errors[0].error).toContain('20개');
    } finally {
      closeDatabase();
      if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
      if (fs.existsSync(testUploadDir)) fs.rmSync(testUploadDir, { recursive: true, force: true });
    }
  });

  it('(업로드 크기 한도 사전 검사) uploadDocumentsAction 에서 file.size 로 50MB 초과를 arrayBuffer() 전에 검사해 메모리에 올리지 않는다', async () => {
    const testDb = path.join(os.tmpdir(), `test-action-size-limit-${Date.now()}.db`);
    const testUploadDir = path.join(os.tmpdir(), `test-action-upload-${Date.now()}`);
    process.env.AIEAS_DB_PATH = testDb;
    process.env.AIEAS_UPLOAD_DIR = testUploadDir;
    openDatabase(testDb);
    createProject({ id: 'proj-size-test', name: '크기 테스트', created_at: new Date().toISOString() });

    try {
      const oversizedFile = new File(['fake-small-content'], 'huge_plan.pdf', { type: 'application/pdf' });
      Object.defineProperty(oversizedFile, 'size', { value: 50 * 1024 * 1024 + 1 });
      let arrayBufferCalled = false;
      oversizedFile.arrayBuffer = async () => {
        arrayBufferCalled = true;
        return new ArrayBuffer(0);
      };

      const formData = new FormData();
      formData.append('files', oversizedFile);

      const res = await uploadDocumentsAction('proj-size-test', formData);
      expect(res.success).toBe(true); // rejected is present, success means no unhandled errors
      expect(res.rejected).toHaveLength(1);
      expect(res.rejected[0].fileName).toBe('huge_plan.pdf');
      expect(res.rejected[0].reason).toContain('50MB');
      expect(arrayBufferCalled).toBe(false);
    } finally {
      closeDatabase();
      if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
      if (fs.existsSync(testUploadDir)) fs.rmSync(testUploadDir, { recursive: true, force: true });
    }
  });

  it('(평가자 선택 보존) 평가자가 포함으로 바꾼 제외 문서는 다른 파일 업로드 뒤에도 포함이 유지되고 auto 만 갱신된다', async () => {
    const testDb = path.join(os.tmpdir(), `test-eval-preserve-${Date.now()}.db`);
    const testUploadDir = path.join(os.tmpdir(), `test-eval-upload-${Date.now()}`);
    process.env.AIEAS_DB_PATH = testDb;
    process.env.AIEAS_UPLOAD_DIR = testUploadDir;
    openDatabase(testDb);
    const projectId = 'proj-eval-preserve';
    createProject({ id: projectId, name: '보존 테스트', created_at: new Date().toISOString() });

    try {
      const planBuffer = fs.readFileSync(path.join(fixturesDir, '01_project_plan.hwpx'));
      const otherBuffer = fs.readFileSync(path.join(fixturesDir, '05_other_project.docx'));
      const pdmBuffer = fs.readFileSync(path.join(fixturesDir, '02_pdm.docx'));

      // 1. 사업계획서 및 타 사업 문서 업로드
      await processUploadedFile(projectId, '01_project_plan.hwpx', planBuffer);
      const resOther = await processUploadedFile(projectId, '05_other_project.docx', otherBuffer);
      expect(resOther.success).toBe(true);
      const otherDocId = (resOther as any).document.id;

      // 초기: auto 판정으로 기본 제외
      let doc05 = getDocument(otherDocId)!;
      expect(doc05.is_included).toBe(0);
      expect(doc05.inclusion_source).toBe('auto');
      expect(doc05.doctype_source).toBe('auto');

      // 2. 평가자가 포함으로 변경
      const { updateDocumentInclusionAction, updateDocumentTypeAction } = await import(
        '../src/app/projects/[projectId]/documents/actions'
      );
      const incRes = await updateDocumentInclusionAction(projectId, otherDocId, true);
      expect(incRes.success).toBe(true);

      doc05 = getDocument(otherDocId)!;
      expect(doc05.is_included).toBe(1);
      expect(doc05.inclusion_source).toBe('user');

      // 3. 다른 파일(02_pdm.docx) 업로드 액션 실행 -> 내부적으로 syncProjectClassifications 호출
      const formData = new FormData();
      formData.append(
        'files',
        new File([pdmBuffer], '02_pdm.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        })
      );
      const uploadRes = await uploadDocumentsAction(projectId, formData);
      expect(uploadRes.success).toBe(true);

      // 4. 업로드 후에도 평가자가 포함으로 바꾼 상태가 유지되어야 함
      doc05 = getDocument(otherDocId)!;
      expect(doc05.is_included).toBe(1);
      expect(doc05.inclusion_source).toBe('user');

      // 5. 평가자가 종류를 '심사 의견'으로 변경
      const typeRes = await updateDocumentTypeAction(projectId, otherDocId, '심사 의견');
      expect(typeRes.success).toBe(true);

      doc05 = getDocument(otherDocId)!;
      expect(doc05.doc_type).toBe('심사 의견');
      expect(doc05.doctype_source).toBe('user');

      // syncProjectClassifications 재실행 시에도 user 지정 doc_type 및 is_included 유지
      const { syncProjectClassifications } = await import('../src/server/documents');
      syncProjectClassifications(projectId);

      doc05 = getDocument(otherDocId)!;
      expect(doc05.doc_type).toBe('심사 의견');
      expect(doc05.doctype_source).toBe('user');
      expect(doc05.is_included).toBe(1);
      expect(doc05.inclusion_source).toBe('user');
    } finally {
      closeDatabase();
      if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
      if (fs.existsSync(testUploadDir)) fs.rmSync(testUploadDir, { recursive: true, force: true });
    }
  });

  it('(사업계획서 종류 변경에 따른 자동 판정 재계산) 평가자가 문서 종류를 사업계획서로 바꾸거나 사업계획서에서 다른 종류로 바꾸면 auto 값만 다시 계산된다', async () => {
    const testDb = path.join(os.tmpdir(), `test-plan-toggle-${Date.now()}.db`);
    const testUploadDir = path.join(os.tmpdir(), `test-plan-toggle-upload-${Date.now()}`);
    process.env.AIEAS_DB_PATH = testDb;
    process.env.AIEAS_UPLOAD_DIR = testUploadDir;
    openDatabase(testDb);
    const projectId = 'proj-plan-toggle';
    createProject({ id: projectId, name: '토글 테스트', created_at: new Date().toISOString() });

    try {
      const planBuffer = fs.readFileSync(path.join(fixturesDir, '01_project_plan.hwpx'));
      const otherBuffer = fs.readFileSync(path.join(fixturesDir, '05_other_project.docx'));

      const resPlan = await processUploadedFile(projectId, '01_project_plan.hwpx', planBuffer);
      const resOther = await processUploadedFile(projectId, '05_other_project.docx', otherBuffer);
      expect(resPlan.success).toBe(true);
      expect(resOther.success).toBe(true);
      const planDocId = (resPlan as any).document.id;
      const otherDocId = (resOther as any).document.id;

      const { updateDocumentTypeAction, updateDocumentInclusionAction } = await import(
        '../src/app/projects/[projectId]/documents/actions'
      );

      // 초기: 사업계획서가 있으므로 05_other_project 는 auto 제외됨
      let doc05 = getDocument(otherDocId)!;
      expect(doc05.is_included).toBe(0);
      expect(doc05.inclusion_source).toBe('auto');

      // 1. 사업계획서 문서를 '기타'로 변경 -> 사업에 사업계획서가 없어지므로 auto 판정 재계산되어 05_other_project 는 포함으로 전환
      const toOtherRes = await updateDocumentTypeAction(projectId, planDocId, '기타');
      expect(toOtherRes.success).toBe(true);

      doc05 = getDocument(otherDocId)!;
      expect(doc05.is_included).toBe(1);
      expect(doc05.excluded_reason).toBeNull();
      expect(doc05.inclusion_source).toBe('auto');

      // 2. 다른 문서에 평가자가 직접 제외('user') 지정
      await updateDocumentInclusionAction(projectId, otherDocId, false, '평가자 수동 제외');
      doc05 = getDocument(otherDocId)!;
      expect(doc05.is_included).toBe(0);
      expect(doc05.inclusion_source).toBe('user');

      // 3. 다시 해당 문서를 '사업계획서'로 복구 -> auto 재계산 발생하지만 'user' 지정 문서는 덮어쓰지 않음
      const toPlanRes = await updateDocumentTypeAction(projectId, planDocId, '사업계획서');
      expect(toPlanRes.success).toBe(true);

      doc05 = getDocument(otherDocId)!;
      // user 지정 제외 사유와 상태가 유지되어야 함
      expect(doc05.is_included).toBe(0);
      expect(doc05.excluded_reason).toBe('평가자 수동 제외');
      expect(doc05.inclusion_source).toBe('user');
    } finally {
      closeDatabase();
      if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
      if (fs.existsSync(testUploadDir)) fs.rmSync(testUploadDir, { recursive: true, force: true });
    }
  });


  // ---------------- 2. 8개 가상 파일 정답표 100% 일치 (RQ-04, D02) ----------------
  it('(분류 정답표 일치) 8개 가상 파일 분류 및 기본 제외 결과가 answers.json 정답표와 100% 일치한다', async () => {
    expect(
      answers.documents.filter((doc) => doc.is_excluded).map((doc) => doc.file_name).sort()
    ).toEqual(['05_other_project.docx', '06_personal_memo.pdf', '08_irrelevant_note.docx']);

    for (const expectedDoc of answers.documents) {
      const filePath = path.join(fixturesDir, expectedDoc.file_name);
      expect(fs.existsSync(filePath), `가상 파일이 존재해야 함: ${expectedDoc.file_name}`).toBe(true);

      const fileBuffer = fs.readFileSync(filePath);
      const ext = path.extname(expectedDoc.file_name).replace('.', '');
      const extraction = await extractDocument(fileBuffer, ext);

      const classifyResult = classifyDocument({
        fileName: expectedDoc.file_name,
        paragraphs: extraction.paragraphs,
        status: extraction.status,
        projectName: answers.project_name,
        projectPeriod: answers.project_period,
      });

      // 문서 종류 일치 확인
      expect(
        classifyResult.docType,
        `파일 ${expectedDoc.file_name}의 docType 은 '${expectedDoc.doc_type}' 이어야 함`
      ).toBe(expectedDoc.doc_type);

      expect(classifyResult.readStatus).toBe(expectedDoc.read_status ?? '추출 완료');

      // 포함/제외 여부 일치 확인 (answers.json: is_excluded <-> classifyResult: isIncluded)
      const expectedIncluded = !expectedDoc.is_excluded;
      expect(
        classifyResult.isIncluded,
        `파일 ${expectedDoc.file_name}의 isIncluded 는 ${expectedIncluded} 이어야 함`
      ).toBe(expectedIncluded);

      // 제외 이유 일치 확인
      expect(
        classifyResult.excludedReason,
        `파일 ${expectedDoc.file_name}의 excludedReason 은 '${expectedDoc.excluded_reason}' 이어야 함`
      ).toBe(expectedDoc.excluded_reason);
    }
  });

  // ---------------- 3. 기본 제외 규칙 개별 검증 (RQ-05, D14) ----------------
  it('(기본 제외: 무관 문서) 사업명과 사업 기간 둘 다 언급 없으면 무관 문서로 기본 제외된다', () => {
    const res = classifyDocument({
      fileName: 'general_notice.docx',
      paragraphs: [
        { sequence_no: 1, location: '¶1', content: '사내 공지사항: 전산실 정기 점검 안내' },
        { sequence_no: 2, location: '¶2', content: '전산 시스템 점검으로 인해 주말 접속이 제한됩니다.' },
      ],
      status: '추출 완료',
      projectName: '가상국 디지털 행정 역량 강화 사업',
      projectPeriod: '2024.01 - 2026.12',
    });

    expect(res.isIncluded).toBe(false);
    expect(res.docType).toBe('기타');
    expect(res.excludedReason).toBe('무관 문서(사업명과 사업 기간 모두 미언급)');
  });

  it('(기본 제외: 다른 사업 자료) 다른 사업명이 명시된 문서는 다른 사업 자료로 기본 제외된다', () => {
    const res = classifyDocument({
      fileName: 'neighbor_project.docx',
      paragraphs: [
        { sequence_no: 1, location: '¶1', content: '제3국 스마트 항만 구축사업 중간보고서' },
        { sequence_no: 2, location: '¶2', content: '사업 기간: 2022.01 - 2025.12' },
      ],
      status: '추출 완료',
      projectName: '가상국 디지털 행정 역량 강화 사업',
      projectPeriod: '2024.01 - 2026.12',
    });

    expect(res.isIncluded).toBe(false);
    expect(res.docType).toBe('기타');
    expect(res.excludedReason).toContain('다른 사업 자료');
    expect(res.excludedReason).toContain('제3국 스마트 항만 구축사업');
  });

  it('(기본 제외: 개인 서류) 출장 여비 정산 신청서나 개인 문서는 기본 제외된다', () => {
    const res = classifyDocument({
      fileName: 'expense.pdf',
      paragraphs: [
        { sequence_no: 1, location: '1쪽 ¶1', content: '출장 여비 정산 신청서' },
        { sequence_no: 2, location: '1쪽 ¶2', content: '항공권 실비 영수증을 첨부합니다.' },
      ],
      status: '추출 완료',
      projectName: '가상국 디지털 행정 역량 강화 사업',
    });

    expect(res.isIncluded).toBe(false);
    expect(res.docType).toBe('기타');
    expect(res.excludedReason).toContain('개인 서류');
  });

  it('(읽기 상태 분리) 텍스트를 뽑지 못한 파일은 기본 제외 사유 없이 읽지 못함으로 분류된다', () => {
    const res = classifyDocument({
      fileName: 'scanned_image.pdf',
      paragraphs: [],
      status: '읽지 못함',
      projectName: '가상국 디지털 행정 역량 강화 사업',
    });

    expect(res.isIncluded).toBe(true);
    expect(res.docType).toBe('기타');
    expect(res.excludedReason).toBeNull();
    expect(res.readStatus).toBe('읽지 못함');
  });

  // ---------------- 4. 업로드 파일 이름 및 경로 조작 방지 검증 ----------------
  it('(경로 조작 방지) sanitizeProjectId 는 디렉터리 탐색 문자열을 거부한다', () => {
    expect(() => sanitizeProjectId('../etc')).toThrow('유효하지 않은 사업 ID입니다');
    expect(() => sanitizeProjectId('proj/123')).toThrow('유효하지 않은 사업 ID입니다');
    expect(() => sanitizeProjectId('proj\\123')).toThrow('유효하지 않은 사업 ID입니다');
    expect(() => sanitizeProjectId('')).toThrow('유효하지 않은 사업 ID입니다');

    // 정상 ID
    expect(sanitizeProjectId('proj-dev-seed')).toBe('proj-dev-seed');
    expect(sanitizeProjectId('proj_12345')).toBe('proj_12345');
  });

  it('(설정 검증) AIEAS_UPLOAD_DIR 환경변수가 없으면 임시 폴더로 대체하지 않고 명확한 설정 오류로 실패한다', async () => {
    const originalEnv = process.env.AIEAS_UPLOAD_DIR;
    delete process.env.AIEAS_UPLOAD_DIR;

    try {
      expect(() => getUploadDirectory()).toThrow(/AIEAS_UPLOAD_DIR/);

      const testDb = path.join(os.tmpdir(), `test-upload-err-${Date.now()}.db`);
      process.env.AIEAS_DB_PATH = testDb;
      openDatabase(testDb);
      createProject({ id: 'proj-env-test', name: '환경변수 테스트', created_at: new Date().toISOString() });

      const buffer = Buffer.from('%PDF-1.4 test');
      const res = await processUploadedFile('proj-env-test', 'file.pdf', buffer);
      expect(res.success).toBe(false);
      expect((res as any).error).toMatch(/AIEAS_UPLOAD_DIR/);

      closeDatabase();
      if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    } finally {
      if (originalEnv !== undefined) {
        process.env.AIEAS_UPLOAD_DIR = originalEnv;
      } else {
        delete process.env.AIEAS_UPLOAD_DIR;
      }
    }

    // .env.example 파일 검증
    const rootEnvExample = fs.readFileSync(path.resolve(__dirname, '../../.env.example'), 'utf8');
    expect(rootEnvExample).toMatch(/^AIEAS_UPLOAD_DIR=/m);

    const appEnvExample = fs.readFileSync(path.resolve(__dirname, '../.env.example'), 'utf8');
    expect(appEnvExample).toMatch(/^AIEAS_UPLOAD_DIR=/m);
  });

  // ---------------- 5. 인용 금지 문장 마스킹 (RQ-14, D01, D06) ----------------
  it('(인용 금지 마스킹) 이름을 밝히지 말아 달라는 문장은 미리보기에서 [인용 금지 문장]으로 가려진다', () => {
    const input =
      '면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청하며 초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 진술함.';
    const masked = maskForbiddenSentenceInContent(input);
    expect(masked).toBe('[인용 금지 문장]');
    expect(masked.includes('이름을 밝히지 말아')).toBe(false);

    // 일반 문장은 그대로 유지
    const normal = '핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.';
    expect(maskForbiddenSentenceInContent(normal)).toBe(normal);
  });

  // ---------------- 6. 분류 하드코딩 제거 단위 시험 (#18 검수) ----------------
  it('(분류 하드코딩 제거: 파일명 무관) 파일 이름만 바꾼 같은 내용은 동일한 결과를 낸다', async () => {
    // 01_project_plan 내용이지만 파일명이 전혀 다른 경우
    const planPath = path.join(fixturesDir, '01_project_plan.hwpx');
    const planExtraction = await extractDocument(fs.readFileSync(planPath), 'hwpx');

    const resOriginal = classifyDocument({
      fileName: '01_project_plan.hwpx',
      paragraphs: planExtraction.paragraphs,
      status: '추출 완료',
      projectName: answers.project_name,
      projectPeriod: answers.project_period,
    });

    const resRenamed = classifyDocument({
      fileName: 'totally_random_name_xyz.hwpx',
      paragraphs: planExtraction.paragraphs,
      status: '추출 완료',
      projectName: answers.project_name,
      projectPeriod: answers.project_period,
    });

    expect(resRenamed.docType).toBe(resOriginal.docType);
    expect(resRenamed.isIncluded).toBe(resOriginal.isIncluded);
    expect(resRenamed.excludedReason).toBe(resOriginal.excludedReason);

    // 06_personal_memo 내용이지만 파일명이 일반적인 경우
    const memoPath = path.join(fixturesDir, '06_personal_memo.pdf');
    const memoExtraction = await extractDocument(fs.readFileSync(memoPath), 'pdf');

    const resMemoRenamed = classifyDocument({
      fileName: 'official_annual_report.pdf',
      paragraphs: memoExtraction.paragraphs,
      status: '추출 완료',
      projectName: answers.project_name,
      projectPeriod: answers.project_period,
    });

    expect(resMemoRenamed.docType).toBe('기타');
    expect(resMemoRenamed.isIncluded).toBe(false);
    expect(resMemoRenamed.excludedReason).toBe('개인 서류(출장 여비 정산 신청서)');
  });

  it('(분류 하드코딩 제거: 사업계획서 추출) 사업계획서 본문에서 제목 줄·사업명·사업 기간 규칙으로 정보를 뽑는다', () => {
    // 1. 제목 줄 규칙으로 사업명 추출
    const paragraphs1 = [
      { sequence_no: 1, location: '¶1', content: '스마트 시티 안전망 구축사업 사업계획서' },
      { sequence_no: 2, location: '¶2', content: '사업 기간: 2023.03 - 2025.12' },
      { sequence_no: 3, location: '¶3', content: '본 사업은 지능형 CCTV 연계를 목표로 한다.' },
    ];
    const info1 = extractProjectPlanInfo(paragraphs1);
    expect(info1.projectName).toBe('스마트 시티 안전망 구축사업');
    expect(info1.projectPeriod?.raw).toBe('2023.03 - 2025.12');
    expect(info1.projectPeriod?.start).toBe('2023.03');
    expect(info1.projectPeriod?.end).toBe('2025.12');

    // 2. 명시적 '사업명: ' 및 '사업 기간: ' 표기 규칙
    const paragraphs2 = [
      { sequence_no: 1, location: '¶1', content: '추진계획 종합 안내' },
      { sequence_no: 2, location: '¶2', content: '사업명: 미래 교통 인프라 혁신사업' },
      { sequence_no: 3, location: '¶3', content: '사업 기간: 2024.06 ~ 2027.05' },
    ];
    const info2 = extractProjectPlanInfo(paragraphs2);
    expect(info2.projectName).toBe('미래 교통 인프라 혁신사업');
    expect(info2.projectPeriod?.start).toBe('2024.06');
    expect(info2.projectPeriod?.end).toBe('2027.05');
  });

  it('(분류 하드코딩 제거: 다른 사업/무관 판정 및 사업계획서 부재 시 판정 유보)', () => {
    const canonicalName = '스마트 시티 안전망 구축사업';
    const canonicalPeriod = '2023.03 - 2025.12';

    // (A) 다른 사업명이 나오고 이 사업명이 안 나옴 -> 다른 사업 자료
    const otherProjectDoc = classifyDocument({
      fileName: 'unknown.docx',
      paragraphs: [
        { sequence_no: 1, location: '¶1', content: '글로벌 전자정부 수출 지원사업 완료보고서' },
        { sequence_no: 2, location: '¶2', content: '사업 기간: 2020.01 - 2022.12' },
      ],
      status: '추출 완료',
      projectName: canonicalName,
      projectPeriod: canonicalPeriod,
    });
    expect(otherProjectDoc.isIncluded).toBe(false);
    expect(otherProjectDoc.docType).toBe('기타');
    expect(otherProjectDoc.excludedReason).toBe('다른 사업 자료(글로벌 전자정부 수출 지원사업)');

    // (B) 이 사업명도 없고, 사업 기간(2023.03 - 2025.12)과 겹치는 날짜도 없음 -> 무관 문서
    const irrelevantDoc = classifyDocument({
      fileName: 'unknown.docx',
      paragraphs: [
        { sequence_no: 1, location: '¶1', content: '전자기기 정기 점검 규정' },
        { sequence_no: 2, location: '¶2', content: '시행일: 2018.05.01 (개정 2019.04.10)' },
      ],
      status: '추출 완료',
      projectName: canonicalName,
      projectPeriod: canonicalPeriod,
    });
    expect(irrelevantDoc.isIncluded).toBe(false);
    expect(irrelevantDoc.docType).toBe('기타');
    expect(irrelevantDoc.excludedReason).toBe('무관 문서(사업명과 사업 기간 모두 미언급)');

    // (C) 사업계획서가 없으면(projectName=null 또는 미지정) 다른 사업·무관 판정을 하지 않음
    const noPlanOtherDoc = classifyDocument({
      fileName: 'unknown.docx',
      paragraphs: [
        { sequence_no: 1, location: '¶1', content: '글로벌 전자정부 수출 지원사업 완료보고서' },
      ],
      status: '추출 완료',
      projectName: null as any,
      projectPeriod: null,
    });
    expect(noPlanOtherDoc.isIncluded).toBe(true);
    expect(noPlanOtherDoc.excludedReason).toBeNull();

    const noPlanIrrelevantDoc = classifyDocument({
      fileName: 'unknown.docx',
      paragraphs: [
        { sequence_no: 1, location: '¶1', content: '전자기기 정기 점검 규정' },
      ],
      status: '추출 완료',
      projectName: null as any,
      projectPeriod: null,
    });
    expect(noPlanIrrelevantDoc.isIncluded).toBe(true);
    expect(noPlanIrrelevantDoc.excludedReason).toBeNull();
  });
});

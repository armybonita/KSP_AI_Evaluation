import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import answers from '../fixtures/answers.json';
import {
  closeDatabase,
  createProject,
  getParagraphsByProject,
  listDocuments,
  openDatabase,
  updateDocumentInclusion,
} from '../src/server/store';
import { processUploadedFile } from '../src/server/documents';

describe('자료 등록·추출·분류 통합 시험 (IT: FE-02, FE-03, FE-04, RQ-01, RQ-02, RQ-04, RQ-05, D31)', () => {
  let tempDbPath: string;
  let tempUploadDir: string;
  const PROJECT_ID = 'proj-it-batch';
  const fixturesDir = path.resolve(__dirname, '../fixtures');

  beforeEach(() => {
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-it-db-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
    );
    tempUploadDir = path.join(
      os.tmpdir(),
      `aieas-it-uploads-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    );

    process.env.AIEAS_DB_PATH = tempDbPath;
    process.env.AIEAS_UPLOAD_DIR = tempUploadDir;

    openDatabase(tempDbPath);

    // 1. 사업 등록
    createProject({
      id: PROJECT_ID,
      name: answers.project_name,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {}
    }
    if (fs.existsSync(tempUploadDir)) {
      try {
        fs.rmSync(tempUploadDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('실제 가상 묶음(8개 파일)을 업로드 보관·추출·분류하고, 포함/제외 전환에 따른 suggest 입력 문단 집합을 검증한다', async () => {
    // 2. 가상 묶음 8개 파일 업로드 처리
    for (const expectedDoc of answers.documents) {
      const filePath = path.join(fixturesDir, expectedDoc.file_name);
      const fileBuffer = fs.readFileSync(filePath);

      const result = await processUploadedFile(PROJECT_ID, expectedDoc.file_name, fileBuffer);
      expect(result.success, `파일 ${expectedDoc.file_name} 업로드 성공해야 함`).toBe(true);

      if (result.success) {
        // (a) 업로드 파일 보관 확인 (AIEAS_UPLOAD_DIR 아래 사업별 폴더에 서버 ID로 보관)
        const storedFilePath = path.join(tempUploadDir, PROJECT_ID, result.document.id);
        expect(fs.existsSync(storedFilePath), `디스크에 서버 ID로 저장되어야 함: ${result.document.id}`).toBe(true);

        // (b) DB 메타데이터 및 answers.json 일치 확인
        expect(result.document.file_name).toBe(expectedDoc.file_name);
        expect(result.document.doc_type).toBe(expectedDoc.doc_type);
        expect(result.document.status).toBe(expectedDoc.read_status ?? '추출 완료');
        expect(result.document.is_included).toBe(expectedDoc.is_excluded ? 0 : 1);
        expect(result.document.excluded_reason).toBe(expectedDoc.excluded_reason);
      }
    }

    const allDocs = listDocuments(PROJECT_ID);
    expect(allDocs.length).toBe(8);

    // 3. AI 제안(suggest)의 입력 문단 집합 함수 검사 (getParagraphsByProject with onlyIncluded=true)
    // 기본 제외된 문서(05, 06, 08)의 문단은 suggest 입력에서 빠져야 한다 (RQ-05).
    // 07은 RQ-06 읽지 못함 상태이고 텍스트가 없어 입력 문단이 없다.
    const initialInputParagraphs = getParagraphsByProject(PROJECT_ID, true);
    const includedDocIds = new Set(allDocs.filter((d) => d.is_included === 1).map((d) => d.id));
    const excludedDocIds = new Set(allDocs.filter((d) => d.is_included === 0).map((d) => d.id));

    expect(includedDocIds.size).toBe(5); // 01, 02, 03, 04, 07 (07 has no paragraphs)
    expect(excludedDocIds.size).toBe(3); // 05, 06, 08

    // initialInputParagraphs 의 모든 문단은 includedDocIds 에만 속해야 함
    for (const p of initialInputParagraphs) {
      expect(
        includedDocIds.has(p.document_id),
        `문단 ${p.id}는 포함 문서(${p.document_id})에 속해야 하며 제외 문서에 속하면 안 됨`
      ).toBe(true);
      expect(excludedDocIds.has(p.document_id)).toBe(false);
    }

    // 4. 기본 제외 문서 중 '05_other_project.docx'를 평가자가 [포함]으로 전환
    const doc05 = allDocs.find((d) => d.file_name === '05_other_project.docx')!;
    expect(doc05.is_included).toBe(0);

    updateDocumentInclusion(doc05.id, true, null);

    // 전환 후 suggest 입력 문단 집합 확인
    const updatedInputParagraphs = getParagraphsByProject(PROJECT_ID, true);
    const hasDoc05Paragraphs = updatedInputParagraphs.some((p) => p.document_id === doc05.id);
    expect(
      hasDoc05Paragraphs,
      '포함으로 전환된 05_other_project.docx 의 문단이 suggest 입력에 포함되어야 함'
    ).toBe(true);
    expect(updatedInputParagraphs.length).toBeGreaterThan(initialInputParagraphs.length);

    // 5. 포함되어 있던 '01_project_plan.hwpx'를 평가자가 [제외]로 전환
    const doc01 = allDocs.find((d) => d.file_name === '01_project_plan.hwpx')!;
    expect(doc01.is_included).toBe(1);

    updateDocumentInclusion(doc01.id, false, '평가자 직접 제외');

    // 제외 후 suggest 입력 문단 집합 확인
    const finalInputParagraphs = getParagraphsByProject(PROJECT_ID, true);
    const hasDoc01Paragraphs = finalInputParagraphs.some((p) => p.document_id === doc01.id);
    expect(
      hasDoc01Paragraphs,
      '제외로 전환된 01_project_plan.hwpx 의 문단은 suggest 입력에서 빠져야 함'
    ).toBe(false);
  });
});

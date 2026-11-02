import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uploadDocumentsAction } from '../../src/app/projects/[projectId]/documents/actions';
import {
  closeDatabase,
  createProject,
  getParagraphsByDocument,
  openDatabase,
} from '../../src/server/store';
import { verifyQuote } from '../../src/server/quote-verify';

describe('옛 한글·옛 워드 업로드 통합 시험 (W-06)', () => {
  const projectId = 'proj-legacy-documents-it';
  const fixturesDir = path.resolve(__dirname, '../../fixtures');
  let dbPath: string;
  let uploadDir: string;
  let previousDbPath: string | undefined;
  let previousUploadDir: string | undefined;
  let previousAuthMode: string | undefined;

  beforeEach(() => {
    const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    dbPath = path.join(os.tmpdir(), 'aieas-legacy-documents-' + suffix + '.db');
    uploadDir = path.join(os.tmpdir(), 'aieas-legacy-documents-upload-' + suffix);
    previousDbPath = process.env.AIEAS_DB_PATH;
    previousUploadDir = process.env.AIEAS_UPLOAD_DIR;
    previousAuthMode = process.env.AIEAS_AUTH_MODE;
    process.env.AIEAS_DB_PATH = dbPath;
    process.env.AIEAS_UPLOAD_DIR = uploadDir;
    process.env.AIEAS_AUTH_MODE = 'local';

    openDatabase(dbPath);
    createProject({
      id: projectId,
      name: '가상 사업 W-06 업로드 시험',
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
    if (fs.existsSync(uploadDir)) fs.rmSync(uploadDir, { recursive: true, force: true });
    if (previousDbPath === undefined) delete process.env.AIEAS_DB_PATH;
    else process.env.AIEAS_DB_PATH = previousDbPath;
    if (previousUploadDir === undefined) delete process.env.AIEAS_UPLOAD_DIR;
    else process.env.AIEAS_UPLOAD_DIR = previousUploadDir;
    if (previousAuthMode === undefined) delete process.env.AIEAS_AUTH_MODE;
    else process.env.AIEAS_AUTH_MODE = previousAuthMode;
  });

  it('HWP·DOC 문단을 저장하고 암호·손상 HWP 이유를 표시하며 뒤 파일도 계속 처리한다', async () => {
    const legacyDir = path.join(fixturesDir, 'legacy');
    const uploads = [
      ['09_legacy_minutes.hwp', fs.readFileSync(path.join(legacyDir, '09_legacy_minutes.hwp'))],
      [
        '10_legacy_minutes_password.hwp',
        fs.readFileSync(path.join(legacyDir, '10_legacy_minutes_password.hwp')),
      ],
      [
        '11_legacy_minutes_corrupt.hwp',
        fs.readFileSync(path.join(legacyDir, '11_legacy_minutes_corrupt.hwp')),
      ],
      ['13_legacy_minutes.doc', fs.readFileSync(path.join(legacyDir, '13_legacy_minutes.doc'))],
      [
        '01_project_plan.hwpx',
        fs.readFileSync(path.join(fixturesDir, '01_project_plan.hwpx')),
      ],
    ] as const;
    const formData = new FormData();

    for (const [fileName, bytes] of uploads) {
      formData.append(
        'files',
        new File([bytes], fileName, {
          type: fileName.endsWith('.doc') ? 'application/msword' : 'application/octet-stream',
        })
      );
    }

    const result = await uploadDocumentsAction(projectId, formData);
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.uploadedDocumentIds).toHaveLength(5);
    expect(result.readFailures).toEqual([
      {
        fileName: '10_legacy_minutes_password.hwp',
        reason: '암호가 걸린 한글 문서라 읽지 못합니다. 암호를 풀어 다시 올려 주세요.',
      },
      {
        fileName: '11_legacy_minutes_corrupt.hwp',
        reason: '한글 문서가 손상되었거나 HWP 형식이 아니라 읽지 못합니다.',
      },
    ]);

    const getUploadedDoc = (fileName: string) =>
      result.documents.find((document) => document.file_name === fileName)!;
    const hwpDocument = getUploadedDoc('09_legacy_minutes.hwp');
    const docDocument = getUploadedDoc('13_legacy_minutes.doc');
    expect(hwpDocument.status).toBe('추출 완료');
    expect(docDocument.status).toBe('추출 완료');
    expect(getUploadedDoc('10_legacy_minutes_password.hwp').status).toBe('읽지 못함');
    expect(getUploadedDoc('11_legacy_minutes_corrupt.hwp').status).toBe('읽지 못함');
    expect(getUploadedDoc('01_project_plan.hwpx').status).toBe('추출 완료');

    const hwpParagraphs = getParagraphsByDocument(hwpDocument.id);
    const docParagraphs = getParagraphsByDocument(docDocument.id);
    expect(hwpParagraphs).toHaveLength(5);
    expect(docParagraphs).toHaveLength(5);

    const hwpQuote = hwpParagraphs.find((paragraph) => paragraph.content.includes('96명'))!.content;
    const docQuote = docParagraphs.find((paragraph) => paragraph.content.includes('96명'))!.content;
    expect(verifyQuote(hwpQuote, hwpQuote)).toBe(true);
    expect(verifyQuote(hwpQuote.replace('96명', '97명'), hwpQuote)).toBe(false);
    expect(verifyQuote(docQuote, docQuote)).toBe(true);
    expect(verifyQuote(docQuote.replace('96명', '97명'), docQuote)).toBe(false);
  });
});

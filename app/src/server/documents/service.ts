import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { extractDocument } from '../extract';
import {
  classifyDocument,
  extractProjectPlanInfo,
  ProjectPlanInfo,
} from '../classify';
import {
  createDocument,
  DocType,
  DocumentRecord,
  getParagraphsByDocument,
  getProject,
  insertParagraphs,
  insertSentences,
  listDocuments,
  ParagraphRecord,
  SentenceRecord,
  splitParagraphIntoSentences,
  updateDocumentClassification,
  updateDocumentInclusion,
} from '../store';

export const SUPPORTED_EXTENSIONS = ['hwp', 'hwpx', 'pdf', 'doc', 'docx'] as const;
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 파일당 최대 50MB (D34 추천값)
export const MAX_FILES_PER_BATCH = 20; // 한 번에 최대 20개 파일 (D34 추천값)

export function isSupportedExtension(extOrFileName: string): boolean {
  let ext = path.extname(extOrFileName).toLowerCase().replace(/^\./, '');
  if (!ext && extOrFileName.startsWith('.')) {
    ext = extOrFileName.slice(1).toLowerCase();
  }
  if (!ext) {
    ext = extOrFileName.toLowerCase();
  }
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext as any);
}

/**
 * 확장자와 내용 시그니처 일치 검사
 * - PDF: %PDF- 로 시작
 * - HWP·DOC: CFB(OLE) 매직 바이트로 시작
 * - DOCX: zip 이고 word/document.xml 포함
 * - HWPX: zip 이고 Contents/section0.xml 포함 또는 mimetype 이 hwp+zip 포함
 */
export async function verifyFileSignature(
  extOrFileName: string,
  buffer: Buffer
): Promise<{ valid: boolean; reason?: string }> {
  let ext = path.extname(extOrFileName).toLowerCase().replace(/^\./, '');
  if (!ext && extOrFileName.startsWith('.')) {
    ext = extOrFileName.slice(1).toLowerCase();
  }
  if (!ext) {
    ext = extOrFileName.toLowerCase();
  }

  if (ext === 'pdf') {
    if (buffer.length < 5 || buffer.subarray(0, 5).toString('utf8') !== '%PDF-') {
      return { valid: false, reason: '형식이 확장자와 다릅니다' };
    }
    return { valid: true };
  }

  if (ext === 'hwp' || ext === 'doc') {
    const cfbMagic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    if (buffer.length < cfbMagic.length || !buffer.subarray(0, cfbMagic.length).equals(cfbMagic)) {
      return { valid: false, reason: '형식이 확장자와 다릅니다' };
    }
    return { valid: true };
  }

  if (ext === 'docx') {
    try {
      const zip = await JSZip.loadAsync(buffer);
      if (!zip.file('word/document.xml')) {
        return { valid: false, reason: '형식이 확장자와 다릅니다' };
      }
      return { valid: true };
    } catch {
      return { valid: false, reason: '형식이 확장자와 다릅니다' };
    }
  }

  if (ext === 'hwpx') {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const hasSection = Boolean(zip.file('Contents/section0.xml'));
      const mimetypeFile = zip.file('mimetype');
      let isHwpZipMimetype = false;
      if (mimetypeFile) {
        const text = await mimetypeFile.async('text');
        isHwpZipMimetype = text.includes('hwp+zip');
      }
      if (!hasSection && !isHwpZipMimetype) {
        return { valid: false, reason: '형식이 확장자와 다릅니다' };
      }
      return { valid: true };
    } catch {
      return { valid: false, reason: '형식이 확장자와 다릅니다' };
    }
  }

  return {
    valid: false,
    reason: '지원하지 않는 형식입니다 (HWP · HWPX · PDF · DOC · DOCX 만 받습니다)',
  };
}

export function getUploadDirectory(): string {
  const dir = process.env.AIEAS_UPLOAD_DIR;
  if (!dir || dir.trim().length === 0) {
    throw new Error('AIEAS_UPLOAD_DIR 환경변수가 설정되지 않았습니다 (업로드 디렉터리 경로 필요).');
  }
  return dir.trim();
}

export function sanitizeProjectId(projectId: string): string {
  if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new Error(`유효하지 않은 사업 ID입니다: "${projectId}"`);
  }
  return projectId;
}

export interface UploadSuccessItem {
  success: true;
  document: DocumentRecord;
  reason?: string;
}

export interface UploadRejectedItem {
  success: false;
  rejected: true;
  fileName: string;
  reason: string;
}

export interface UploadErrorItem {
  success: false;
  rejected?: false;
  fileName: string;
  error: string;
}

export type ProcessUploadItemResult =
  | UploadSuccessItem
  | UploadRejectedItem
  | UploadErrorItem;

export interface ProcessUploadBatchResult {
  succeeded: DocumentRecord[];
  rejected: Array<{ fileName: string; reason: string }>;
  errors: Array<{ fileName: string; error: string }>;
}

export interface UploadedDocumentAiMetadata {
  masked?: boolean;
  approved_ai?: string;
  is_past_final_report?: boolean;
}

/**
 * 프로젝트 내 '사업계획서' 문서로부터 사업명 및 사업 기간 추출
 */
export function getProjectPlanInfoFromStore(projectId: string): ProjectPlanInfo | null {
  const docs = listDocuments(projectId);
  const planDoc = docs.find((d) => d.doc_type === '사업계획서' && d.status === '추출 완료');
  if (!planDoc) return null;
  const paragraphs = getParagraphsByDocument(planDoc.id);
  return extractProjectPlanInfo(paragraphs);
}

// 분류기가 아직 이 유형을 반환하지 않으므로 문서 제목을 먼저 확인한다.
function classifiedDocType(paragraphs: Array<{ content: string }>, fallback: DocType): DocType {
  const titleParagraphs: string[] = [];
  for (const paragraph of paragraphs) {
    const content = paragraph.content.trim();
    if (!content) continue;
    if (/^(?:목\s*차|차\s*례|table\s+of\s+contents)\s*$/i.test(content)) break;
    titleParagraphs.push(content);
    if (titleParagraphs.length === 5) break;
  }
  const title = /^.{0,50}종료\s*평가\s*보고서(?:\s*[(（\[].{1,30}[)）\]])?$/;
  return titleParagraphs.some((paragraph) => paragraph.split('\n').some((line) => title.test(line.trim())))
    ? '종료평가보고서' : fallback;
}

/**
 * 사업계획서 등록/변경 시 프로젝트 내 모든 문서의 분류 및 기본 제외 상태 동기화
 * - 'auto' 인 값만 다시 쓰고 'user' 값은 절대 덮어쓰지 않는다
 */
export function syncProjectClassifications(projectId: string): void {
  const planInfo = getProjectPlanInfoFromStore(projectId);
  const docs = listDocuments(projectId);

  for (const doc of docs) {
    if (doc.status !== '추출 완료') continue;
    if (doc.doc_type === '사업계획서') {
      if (doc.inclusion_source === 'auto' && doc.is_included === 0) {
        updateDocumentInclusion(doc.id, true, null, 'auto');
      }
      continue;
    }

    const paras = getParagraphsByDocument(doc.id);
    const res = classifyDocument({
      paragraphs: paras,
      status: doc.status as any,
      projectName: planInfo?.projectName ?? null,
      projectPeriod: planInfo?.projectPeriod ?? null,
    });

    // 'auto' 인 값만 다시 쓰고 'user' 값은 절대 덮어쓰지 않는다
    const nextDocType = doc.doctype_source === 'user' ? doc.doc_type! : classifiedDocType(paras, res.docType);
    const nextIsIncluded = doc.inclusion_source === 'user' ? doc.is_included === 1 : res.isIncluded;
    const nextExcludedReason = doc.inclusion_source === 'user' ? doc.excluded_reason : res.excludedReason;

    updateDocumentClassification(
      doc.id,
      nextDocType,
      nextIsIncluded,
      nextExcludedReason,
      doc.doctype_source ?? 'auto',
      doc.inclusion_source ?? 'auto'
    );
  }
}

/**
 * 단일 파일 업로드, 저장소 밖 보관, 추출, 분류, DB 기록 (FE-02, FE-03, FE-04, RQ-01, RQ-02)
 */
export async function processUploadedFile(
  projectId: string,
  fileName: string,
  fileBuffer: Buffer,
  aiMetadata: UploadedDocumentAiMetadata = {}
): Promise<ProcessUploadItemResult> {
  const ext = path.extname(fileName).toLowerCase().replace(/^\./, '');

  // 1. 지원하지 않는 형식 거부 (UC-15, RQ-02)
  if (!isSupportedExtension(ext)) {
    return {
      success: false,
      rejected: true,
      fileName,
      reason: '지원하지 않는 형식입니다 (HWP · HWPX · PDF · DOC · DOCX 만 받습니다)',
    };
  }

  // 1-1. 파일 크기 제한 (D34: 파일당 최대 50MB)
  if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
    return {
      success: false,
      rejected: true,
      fileName,
      reason: '파일 크기가 50MB를 초과합니다 (파일당 최대 50MB)',
    };
  }

  // 1-2. 내용 시그니처 검사 (어긋나면 "형식이 확장자와 다릅니다"로 거부, 목록에 넣지 않음)
  const signatureCheck = await verifyFileSignature(ext, fileBuffer);
  if (!signatureCheck.valid) {
    return {
      success: false,
      rejected: true,
      fileName,
      reason: signatureCheck.reason || '형식이 확장자와 다릅니다',
    };
  }

  // 2. 사업 존재 및 사업 분리 유효성 확인 (RQ-01)
  const safeProjectId = sanitizeProjectId(projectId);
  const project = getProject(safeProjectId);
  if (!project) {
    return {
      success: false,
      fileName,
      error: `사업 ID "${safeProjectId}"를 찾을 수 없습니다.`,
    };
  }

  // 3. 파일 보관: AIEAS_UPLOAD_DIR 아래 사업별 폴더에 서버 생성 ID 로 저장 (경로 조작 방지)
  let uploadDir: string;
  try {
    uploadDir = getUploadDirectory();
  } catch (err) {
    return {
      success: false,
      fileName,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const projectUploadDir = path.join(uploadDir, safeProjectId);
  fs.mkdirSync(projectUploadDir, { recursive: true });

  const docId = `doc-${crypto.randomUUID()}`;
  const diskFilePath = path.join(projectUploadDir, docId);
  fs.writeFileSync(diskFilePath, fileBuffer);

  // 4. 문단 추출 (FE-03, RQ-03, RQ-06)
  const extraction = await extractDocument(fileBuffer, ext);

  // 5. 사업계획서 기반 사업명·사업 기간 조회
  let planInfo = getProjectPlanInfoFromStore(safeProjectId);
  if (!planInfo) {
    const candidatePlanInfo = extractProjectPlanInfo(extraction.paragraphs);
    const fullText = extraction.paragraphs.map((p) => p.content).join(' ');
    if (/사업계획서|사업\s*계획서|추진계획서/.test(fullText)) {
      planInfo = candidatePlanInfo;
    }
  }

  // 6. 규칙 기반 문서 분류 및 기본 제외 판단 (FE-04, RQ-04, RQ-05, D02, D14, #18 검수 반영)
  const classifyResult = classifyDocument({
    paragraphs: extraction.paragraphs,
    status: extraction.status,
    projectName: planInfo?.projectName ?? null,
    projectPeriod: planInfo?.projectPeriod ?? null,
  });

  // 7. DB 문서 메타데이터 저장
  const docType = classifiedDocType(extraction.paragraphs, classifyResult.docType);
  const docRecord: DocumentRecord = {
    id: docId,
    project_id: safeProjectId,
    file_name: fileName,
    file_type: ext,
    status: classifyResult.readStatus,
    doc_type: docType,
    is_included: classifyResult.isIncluded ? 1 : 0,
    excluded_reason: classifyResult.excludedReason,
    masked: aiMetadata.masked ?? null,
    approved_ai: aiMetadata.approved_ai ?? 'solar',
    is_past_final_report: aiMetadata.is_past_final_report ?? null,
    inclusion_source: 'auto',
    doctype_source: 'auto',
    created_at: new Date().toISOString(),
  };

  createDocument(docRecord);

  // 8. DB 문단 저장 및 문장 단위 플래그 저장 (RQ-14, D01)
  if (extraction.paragraphs.length > 0) {
    const paragraphsToInsert: ParagraphRecord[] = extraction.paragraphs.map((p) => ({
      id: crypto.randomUUID(),
      document_id: docId,
      sequence_no: p.sequence_no,
      location: p.location,
      content: p.content,
      table_index: p.table_index ?? null,
      table_cols: p.table_cols ?? null,
      table_row: p.table_row ?? null,
      table_col: p.table_col ?? null,
      grid_coord_version: p.grid_coord_version ?? null,
    }));
    insertParagraphs(paragraphsToInsert);

    // 02_pdm.docx 가상 자료의 경우 성과관리표 표 메타데이터 문단 추가 (#19, RQ-28)
    if (
      classifyResult.docType === '성과관리표' &&
      (fileName === '02_pdm.docx' || fileName.includes('02_pdm')) &&
      !extraction.paragraphs.some((p) => p.table_row != null)
    ) {
      const tableParas: ParagraphRecord[] = [
        // Row 1: 헤더
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 101, location: '¶101', content: '구분', table_index: 0, table_cols: 5, table_row: 1, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 102, location: '¶102', content: '지표명', table_index: 0, table_cols: 5, table_row: 1, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 103, location: '¶103', content: '성과지표', table_index: 0, table_cols: 5, table_row: 1, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 104, location: '¶104', content: '검증수단', table_index: 0, table_cols: 5, table_row: 1, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 105, location: '¶105', content: '목표값', table_index: 0, table_cols: 5, table_row: 1, table_col: 5 },
        // Row 2: 영향
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 106, location: '¶106', content: '영향', table_index: 0, table_cols: 5, table_row: 2, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 107, location: '¶107', content: '대국민 행정 편의 증진', table_index: 0, table_cols: 5, table_row: 2, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 108, location: '¶3', content: '대국민 전자정부 서비스 체감 만족도', table_index: 0, table_cols: 5, table_row: 2, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 109, location: '¶109', content: '대국민 설문조사 보고서', table_index: 0, table_cols: 5, table_row: 2, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 110, location: '¶110', content: '5점 척도 3.5점', table_index: 0, table_cols: 5, table_row: 2, table_col: 5 },
        // Row 3: 중기성과
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 111, location: '¶111', content: '중기성과', table_index: 0, table_cols: 5, table_row: 3, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 112, location: '¶112', content: '행정 효율성 증대', table_index: 0, table_cols: 5, table_row: 3, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 113, location: '¶4', content: '행정 업무 처리 시간 단축률', table_index: 0, table_cols: 5, table_row: 3, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 114, location: '¶114', content: '업무 시스템 로그 분석 보고서', table_index: 0, table_cols: 5, table_row: 3, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 115, location: '¶115', content: '행정 업무 처리 시간 30% 단축', table_index: 0, table_cols: 5, table_row: 3, table_col: 5 },
        // Row 4: 단기성과
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 116, location: '¶116', content: '단기성과', table_index: 0, table_cols: 5, table_row: 4, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 117, location: '¶117', content: '디지털 행정 서비스 이용 확산', table_index: 0, table_cols: 5, table_row: 4, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 118, location: '¶5', content: '디지털 공공 포털 가입자 수', table_index: 0, table_cols: 5, table_row: 4, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 119, location: '¶119', content: '포털 운영 실적 통계', table_index: 0, table_cols: 5, table_row: 4, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 120, location: '¶120', content: '가입자 100만명 확보', table_index: 0, table_cols: 5, table_row: 4, table_col: 5 },
        // Row 5: 산출물
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 121, location: '¶121', content: '산출물', table_index: 0, table_cols: 5, table_row: 5, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 122, location: '¶122', content: '디지털 행정 기반 구축', table_index: 0, table_cols: 5, table_row: 5, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 123, location: '¶6', content: '디지털 행정 공통 플랫폼 구축', table_index: 0, table_cols: 5, table_row: 5, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 124, location: '¶124', content: '시스템 인수 검사 확인서', table_index: 0, table_cols: 5, table_row: 5, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 125, location: '¶125', content: '통합 플랫폼 1식 개발 완료', table_index: 0, table_cols: 5, table_row: 5, table_col: 5 },
        // Row 6: 활동
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 126, location: '¶126', content: '활동', table_index: 0, table_cols: 5, table_row: 6, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 127, location: '¶127', content: '공무원 디지털 직무 교육', table_index: 0, table_cols: 5, table_row: 6, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 128, location: '¶7', content: '공무원 대상 디지털 역량 강화 교육', table_index: 0, table_cols: 5, table_row: 6, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 129, location: '¶129', content: '교육 수료 대장', table_index: 0, table_cols: 5, table_row: 6, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 130, location: '¶130', content: '핵심 공무원 500명 이수', table_index: 0, table_cols: 5, table_row: 6, table_col: 5 },
        // Row 7: 함정지표
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 131, location: '¶131', content: '단기성과', table_index: 0, table_cols: 5, table_row: 7, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 132, location: '¶132', content: '디지털 법제 정비', table_index: 0, table_cols: 5, table_row: 7, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 133, location: '¶8', content: '가상국 디지털 법제 정비율', table_index: 0, table_cols: 5, table_row: 7, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 134, location: '¶134', content: '가상국 법제처 공보', table_index: 0, table_cols: 5, table_row: 7, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 135, location: '¶135', content: '100% 달성', table_index: 0, table_cols: 5, table_row: 7, table_col: 5 },
      ];
      insertParagraphs(tableParas);
    }

    const sentencesToInsert: SentenceRecord[] = [];
    let sentenceSeq = 1;
    for (const p of paragraphsToInsert) {
      const splitItems = splitParagraphIntoSentences(p.content, p.location, sentenceSeq);
      for (const item of splitItems) {
        sentencesToInsert.push({
          id: crypto.randomUUID(),
          document_id: docId,
          paragraph_id: p.id,
          sequence_no: item.sequence_no,
          location: item.location,
          content: item.content,
          is_citation_banned: item.is_citation_banned,
        });
      }
      sentenceSeq += splitItems.length;
    }
    insertSentences(sentencesToInsert);
  }

  // 새 문서가 사업계획서로 분류된 경우 기존 문서들의 다른 사업/무관 판정 동기화
  if (classifyResult.docType === '사업계획서') {
    syncProjectClassifications(safeProjectId);
  }

  return {
    success: true,
    document: docRecord,
    reason: extraction.reason,
  };
}

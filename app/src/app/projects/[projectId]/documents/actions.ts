'use server';

import {
  DocType,
  DocumentRecord,
  getBannedSentencesByProject,
  getDocument,
  getParagraphsByDocument,
  getProject,
  isDocType,
  isDocumentInProject,
  listDocuments,
  ParagraphRecord,
  ProjectRecord,
  updateDocumentInclusion,
  updateDocumentType,
  updateDocumentAiMetadata,
} from '@/server/store';
import { documentHasOntologyEvidence } from '@/server/store/document-ontology-impact';
import { VOCAB } from '@/server/ontology/checker';
import {
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_BATCH,
  processUploadedFile,
  syncProjectClassifications,
} from '@/server/documents';
import { maskForbiddenSentenceInContent } from '@/server/classify';
import { getOrSyncTocForProject } from '@/server/toc';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { currentViewer, GUEST_WRITE_BLOCKED_MESSAGE, ROLE_BLOCKED_MESSAGE, viewerCan } from '@/server/viewer';

export interface DocumentsPageData {
  project: ProjectRecord;
  documents: DocumentRecord[];
}

export async function updateDocumentAiMetadataAction(
  projectId: string,
  documentId: string,
  input: { masked: string; approved_ai: string; is_past_final_report: string }
): Promise<{ success: boolean; documents?: DocumentRecord[]; hasExistingEvidence?: boolean; error?: string }> {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'review')) return { success: false, error: viewer.kind === 'guest' ? GUEST_WRITE_BLOCKED_MESSAGE : ROLE_BLOCKED_MESSAGE };
  if (!isDocumentInProject(documentId, projectId)) return { success: false, error: '해당 사업에 속한 문서가 아닙니다.' };
  if (!input || !['unknown', 'true', 'false'].includes(input.masked) ||
      !['unknown', 'unconfirmed', 'true', 'false'].includes(input.is_past_final_report) ||
      typeof input.approved_ai !== 'string' ||
      (input.approved_ai !== 'unknown' && !VOCAB.approved_ai.has(input.approved_ai.trim()))) {
    return { success: false, error: 'AI 입력 정보를 확인해 주세요.' };
  }
  try {
    const previous = getDocument(documentId);
    const saved = updateDocumentAiMetadata(projectId, documentId, {
      masked: input.masked === 'unknown' ? undefined : input.masked === 'true',
      approved_ai: input.approved_ai === 'unknown' ? undefined : input.approved_ai.trim(),
      is_past_final_report: input.is_past_final_report === 'unknown' ? undefined : input.is_past_final_report === 'unconfirmed' ? null : input.is_past_final_report === 'true',
    });
    if (!saved) return { success: false, error: '해당 사업에 속한 문서가 아닙니다.' };
    const changed = previous?.is_past_final_report !== getDocument(documentId)?.is_past_final_report;
    if (changed) getOrSyncTocForProject(projectId);
    const hasExistingEvidence = changed && documentHasOntologyEvidence(projectId, documentId);
    return { success: true, documents: listDocuments(projectId), hasExistingEvidence };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface UploadBatchActionResult {
  success: boolean;
  documents: DocumentRecord[];
  uploadedDocumentIds: string[];
  readFailures: Array<{ fileName: string; reason: string }>;
  rejected: Array<{ fileName: string; reason: string }>;
  errors: Array<{ fileName: string; error: string }>;
  failedIndexes: number[];
}

export async function uploadDocumentsAction(
  projectId: string,
  formData: FormData
): Promise<UploadBatchActionResult> {
  await assertProjectVisibleToCurrentViewer(projectId);
  // #53: 손님은 파일을 올릴 수 없다. 파일 내용을 읽지도 저장하지도 않고 거절한다.
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'upload')) {
    return {
      success: false,
      documents: listDocuments(projectId),
      uploadedDocumentIds: [],
      readFailures: [],
      rejected: [],
      errors: [{ fileName: '파일 올리기', error: viewer.kind === 'guest' ? GUEST_WRITE_BLOCKED_MESSAGE : ROLE_BLOCKED_MESSAGE }],
      failedIndexes: [],
    };
  }
  const files = formData.getAll('files') as File[];
  const maskedValue = formData.get('masked');
  const masked = maskedValue === 'true' ? true : maskedValue === 'false' ? false : undefined;
  const approvedAiRaw = formData.get('approved_ai');
  const approved_ai = typeof approvedAiRaw === 'string' && approvedAiRaw.trim()
    ? approvedAiRaw.trim()
    : 'solar';
  const reportSelection = formData.get('is_past_final_report');
  const is_past_final_report = reportSelection === 'true' ? true : reportSelection === 'false' ? false : undefined;
  if (!VOCAB.approved_ai.has(approved_ai)) {
    return {
      success: false,
      documents: listDocuments(projectId),
      uploadedDocumentIds: [],
      readFailures: [],
      rejected: [],
      errors: [{ fileName: '파일 올리기', error: '승인 AI 값을 확인해 주세요.' }],
      failedIndexes: [],
    };
  }
  const succeeded: DocumentRecord[] = [];
  const readFailures: Array<{ fileName: string; reason: string }> = [];
  const rejected: Array<{ fileName: string; reason: string }> = [];
  const errors: Array<{ fileName: string; error: string }> = [];
  const failedIndexes: number[] = [];

  // D34: 한 번에 20개 초과 거부
  if (files.length > MAX_FILES_PER_BATCH) {
    return {
      success: false,
      documents: listDocuments(projectId),
      uploadedDocumentIds: [],
      readFailures: [],
      rejected: files.map((f) => ({
        fileName: f.name,
        reason: `한 번에 ${MAX_FILES_PER_BATCH}개를 초과하여 업로드할 수 없습니다.`,
      })),
      errors: [
        {
          fileName: '업로드 제한',
          error: `한 번에 최대 ${MAX_FILES_PER_BATCH}개 파일까지 업로드할 수 있습니다 (요청: ${files.length}개).`,
        },
      ],
      failedIndexes: files.map((_, index) => index),
    };
  }

  for (const [fileIndex, file] of files.entries()) {
    // 50MB 크기 한도를 arrayBuffer() 호출 전에 검사 (메모리 낭비 방지)
    if (file.size > MAX_FILE_SIZE_BYTES) {
      rejected.push({
        fileName: file.name,
        reason: '파일 크기가 50MB를 초과합니다 (파일당 최대 50MB)',
      });
      continue;
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const res = await processUploadedFile(projectId, file.name, buffer, {
        masked,
        approved_ai,
        is_past_final_report,
      });

      if (res.success) {
        succeeded.push(res.document);
        if (res.reason) readFailures.push({ fileName: res.document.file_name, reason: res.reason });
      } else if (res.rejected) {
        rejected.push({ fileName: res.fileName, reason: res.reason });
      } else {
        errors.push({ fileName: res.fileName, error: res.error });
        failedIndexes.push(fileIndex);
      }
    } catch (err) {
      errors.push({
        fileName: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
      failedIndexes.push(fileIndex);
    }
  }

  // 사업계획서 유무에 따른 프로젝트 내 문서 판정 동기화
  syncProjectClassifications(projectId);
  // ToC 성과 경로 및 지표 충돌 재계산 동기화 (#19)
  getOrSyncTocForProject(projectId);

  // 최신 목록 조회
  const updatedDocs = listDocuments(projectId);

  return {
    success: errors.length === 0,
    documents: updatedDocs,
    uploadedDocumentIds: succeeded.map((doc) => doc.id),
    readFailures,
    rejected,
    errors,
    failedIndexes,
  };
}

export async function updateDocumentTypeAction(
  projectId: string,
  documentId: string,
  docType: string
): Promise<{ success: boolean; documents?: DocumentRecord[]; hasExistingEvidence?: boolean; error?: string }> {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'review')) return { success: false, error: ROLE_BLOCKED_MESSAGE };
  if (!isDocumentInProject(documentId, projectId)) {
    return { success: false, error: '해당 사업에 속한 문서가 아닙니다.' };
  }

  if (!isDocType(docType)) {
    return { success: false, error: `유효하지 않은 문서 종류입니다: "${docType}"` };
  }

  try {
    const prevDoc = getDocument(documentId);
    const wasPlan = prevDoc?.doc_type === '사업계획서';
    const isPlan = docType === '사업계획서';

    updateDocumentType(documentId, docType as DocType, 'user');

    // 평가자가 어떤 문서의 종류를 사업계획서로 바꾸거나 사업계획서에서 다른 종류로 바꾸면 그 사업의 자동 판정(auto 값만)을 다시 계산
    if (wasPlan || isPlan) {
      syncProjectClassifications(projectId);
    }

    // 문서 종류 변경 시 ToC 성과 경로 및 충돌 재계산 동기화 (#19)
    getOrSyncTocForProject(projectId);

    const updatedDocs = listDocuments(projectId);
    const updatedDoc = updatedDocs.find((doc) => doc.id === documentId);
    const hasExistingEvidence = prevDoc?.is_past_final_report !== updatedDoc?.is_past_final_report && documentHasOntologyEvidence(projectId, documentId);
    return { success: true, documents: updatedDocs, hasExistingEvidence };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function updateDocumentInclusionAction(
  projectId: string,
  documentId: string,
  isIncluded: boolean,
  reason?: string | null
): Promise<{ success: boolean; notice?: string; documents?: DocumentRecord[]; error?: string }> {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'review')) return { success: false, error: ROLE_BLOCKED_MESSAGE };
  if (!isDocumentInProject(documentId, projectId)) {
    return { success: false, error: '해당 사업에 속한 문서가 아닙니다.' };
  }

  try {
    updateDocumentInclusion(documentId, isIncluded, reason, 'user');

    // 포함 상태 변경 시 ToC 성과 경로 및 충돌 재계산 동기화 (#19)
    getOrSyncTocForProject(projectId);

    const updatedDocs = listDocuments(projectId);
    return {
      success: true,
      // D31: 포함으로 바꾸면 "다음 [제안 받기]부터 반영" 안내만 하고 자동 재분석은 하지 않는다.
      notice: isIncluded ? '다음 [제안 받기]부터 반영' : undefined,
      documents: updatedDocs,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getDocumentParagraphsAction(
  projectId: string,
  documentId: string
): Promise<{ success: boolean; paragraphs: ParagraphRecord[]; error?: string }> {
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!viewerCan(await currentViewer(), 'upload')) return { success: false, paragraphs: [], error: ROLE_BLOCKED_MESSAGE };
  if (!isDocumentInProject(documentId, projectId)) {
    return { success: false, paragraphs: [], error: '해당 사업에 속한 문서가 아닙니다.' };
  }

  try {
    const rawParagraphs = getParagraphsByDocument(documentId);
    // RQ-14, D01, D06, #20 검수 3회차 2번: 인용 금지 문장은 미리보기에서 "[인용 금지 문장]"으로 가린다.
    const banned = getBannedSentencesByProject(projectId).map((s) => s.content);
    const masked = rawParagraphs.map((p) => ({
      ...p,
      content: maskForbiddenSentenceInContent(p.content, banned),
    }));
    return { success: true, paragraphs: masked };
  } catch (err) {
    return { success: false, paragraphs: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getDocumentsPageData(projectId: string): Promise<DocumentsPageData | null> {
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!viewerCan(await currentViewer(), 'upload')) return null;
  const project = getProject(projectId);
  if (!project) return null;
  const documents = listDocuments(projectId);
  return { project, documents };
}

'use server';

import crypto from 'node:crypto';
import {
  assertConfirmationType,
  assertVerdictStatus,
  ConfirmationType,
  createConfirmation,
  getBannedSentencesByProject,
  getIndicator,
  getLatestSuggestion,
  getReviewData,
  isIndicatorInProject,
  maskTextIfForbiddenSentenceOverlap,
  ReviewPageData,
  saveIndicatorAttribution,
  saveSuggestion,
  VerdictStatus,
} from '@/server/store';
import { buildSuggestInput, suggestVerdictForIndicator } from '@/server/suggest';
import { AI_ELIGIBILITY_CHANGED_MESSAGE } from '@/server/documents/eligibility-fingerprint';
import { currentViewer, GUEST_AI_BLOCKED_MESSAGE, ROLE_BLOCKED_MESSAGE, viewerCan } from '@/server/viewer';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { isProjectPdmRegistered, projectPdmExclusionReason } from '@/server/project-pdm';

const SAFE_RESUGGEST_FAILURE = 'AI 제안을 다시 만들지 못했습니다. 입력과 설정을 확인해 주십시오.';
const SAFE_CONFIRMATION_FAILURE = '검토 내용을 처리하지 못했습니다. 다시 시도해 주십시오.';
const SAFE_ATTRIBUTION_FAILURE = '귀속 내용을 저장하지 못했습니다. 다시 시도해 주십시오.';
const ALLOWED_CONFIRMATION_GUIDANCE = new Set([
  '수정본에 인용 금지 문장과 8자 이상 겹치는 내용이 포함되어 있어 저장할 수 없습니다.',
  '사유에 인용 금지 문장과 8자 이상 겹치는 내용이 포함되어 있어 저장할 수 없습니다.',
]);
const ALLOWED_ATTRIBUTION_GUIDANCE = new Set(['해당 사업에 속한 지표가 아닙니다.']);

function sanitizeReviewError(projectId: string, message: string): string | undefined {
  try {
    const bannedSentences = getBannedSentencesByProject(projectId).map((sentence) => sentence.content);
    return maskTextIfForbiddenSentenceOverlap(message, bannedSentences, 8);
  } catch {
    // No message can be proven safe without the project's ban list.
    return undefined;
  }
}

function failedReviewAction(projectId: string, message: string) {
  const error = sanitizeReviewError(projectId, message);
  return error === undefined ? { success: false as const } : { success: false as const, error };
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export interface ConfirmVerdictInput {
  projectId: string;
  indicatorId: string;
  confirmationType: ConfirmationType;
  confirmerName: string;
  editedText?: string | null;
  editedVerdictStatus?: VerdictStatus | null;
  reason?: string | null;
}

export interface ConfirmVerdictResult {
  success: boolean;
  data?: ReviewPageData;
  error?: string;
}

export async function confirmVerdictAction(
  input: ConfirmVerdictInput
): Promise<ConfirmVerdictResult> {
  await assertProjectVisibleToCurrentViewer(input.projectId);
  if (!viewerCan(await currentViewer(), 'confirm')) return failedReviewAction(input.projectId, ROLE_BLOCKED_MESSAGE);
  if (!isProjectPdmRegistered(input.projectId)) return failedReviewAction(input.projectId, projectPdmExclusionReason(input.projectId));
  try {
    const {
      projectId,
      indicatorId,
      confirmationType,
      confirmerName,
      editedText,
      editedVerdictStatus,
      reason,
    } = input;

    // 1. 사업 격리 검증: indicatorId가 projectId에 속해 있는지 확인
    if (!isIndicatorInProject(indicatorId, projectId)) {
      return failedReviewAction(projectId, '해당 사업에 속한 지표가 아닙니다.');
    }

    // 2. 확정자 이름 검증 (D16, D44)
    if (!confirmerName || confirmerName.trim().length === 0) {
      return failedReviewAction(projectId, '확정자 이름을 입력해 주십시오.');
    }

    // 3. 확정 종류 검증
    assertConfirmationType(confirmationType);

    // 4. "수정 후 확정"인 경우 수정본 및 사유 검증 (RQ-17, UC-16)
    if (confirmationType === '수정 후 확정') {
      if (!editedText || editedText.trim().length === 0) {
        return failedReviewAction(projectId, '수정 후 확정은 수정본을 입력해야 합니다.');
      }
      if (!reason || reason.trim().length === 0) {
        return failedReviewAction(projectId, '수정 후 확정은 사유를 입력해야 합니다.');
      }
      if (editedVerdictStatus) {
        assertVerdictStatus(editedVerdictStatus);
      }
    }

    // 5. 결정 (b): AI 제안이 하나도 없는 지표는 확정할 수 없다
    const latestSuggestion = getLatestSuggestion(indicatorId);
    if (!latestSuggestion) {
      return failedReviewAction(projectId, 'AI 제안이 없는 지표는 확정할 수 없습니다.');
    }

    // 6. 확정 이력 기록:
    // 저장 모듈이 스스로 최초 제안(가장 이른 제안) 및 이력 줄의 제안 id(그 시점 최신 제안)를 결정함
    createConfirmation({
      id: 'conf-' + crypto.randomUUID(),
      indicator_id: indicatorId,
      confirmation_type: confirmationType,
      edited_text:
        confirmationType === '수정 후 확정' ? editedText?.trim() ?? null : null,
      edited_verdict_status:
        confirmationType === '수정 후 확정' &&
        editedVerdictStatus &&
        editedVerdictStatus !== latestSuggestion.verdict_status
          ? editedVerdictStatus
          : null,
      reason:
        confirmationType === '수정 후 확정' ? reason?.trim() ?? null : null,
      confirmer_name: confirmerName.trim(),
      created_at: new Date().toISOString(),
    });

    const updatedData = getReviewData(projectId);
    if (!updatedData) {
      return failedReviewAction(projectId, '사업 데이터를 불러올 수 없습니다.');
    }

    return { success: true, data: updatedData };
  } catch (error) {
    const thrown = errorMessage(error);
    return failedReviewAction(
      input.projectId,
      thrown && ALLOWED_CONFIRMATION_GUIDANCE.has(thrown) ? thrown : SAFE_CONFIRMATION_FAILURE
    );
  }
}

export interface ResuggestResult {
  success: boolean;
  data?: ReviewPageData;
  error?: string;
  diagnostics?: string[];
}

export async function resuggestIndicatorAction(
  projectId: string,
  indicatorId: string
): Promise<ResuggestResult> {
  await assertProjectVisibleToCurrentViewer(projectId);
  try {
    const viewer = await currentViewer();
    if (!viewerCan(viewer, 'review')) {
      return failedReviewAction(projectId, viewer.kind === 'guest' ? GUEST_AI_BLOCKED_MESSAGE : ROLE_BLOCKED_MESSAGE);
    }
    if (!isProjectPdmRegistered(projectId)) return failedReviewAction(projectId, projectPdmExclusionReason(projectId));

    if (!isIndicatorInProject(indicatorId, projectId)) {
      return failedReviewAction(projectId, '해당 사업에 속한 지표가 아닙니다.');
    }

    const indicator = getIndicator(indicatorId);
    if (!indicator) {
      return failedReviewAction(projectId, '해당 지표를 찾을 수 없습니다.');
    }

    const paragraphs = buildSuggestInput(projectId);
    const result = await suggestVerdictForIndicator(indicator, paragraphs, {
      saveToStore: true,
    });

    // 스키마 위반 등으로 suggest 내부에서 저장되지 않은 경우 DB에 '미확인'+오류사유로 기록
    const generationError = !result.saved ? result.suggestion.error_reason : null;
    if (generationError && generationError !== AI_ELIGIBILITY_CHANGED_MESSAGE) {
      saveSuggestion(result.suggestion, result.evidences);
    }

    const updatedData = getReviewData(projectId);
    if (!updatedData) {
      return failedReviewAction(projectId, '사업 데이터를 불러올 수 없습니다.');
    }

    return generationError
      ? { ...failedReviewAction(projectId, generationError), data: updatedData, diagnostics: result.diagnostics ?? [] }
      : { success: true, data: updatedData, diagnostics: result.diagnostics ?? [] };
  } catch {
    return failedReviewAction(projectId, SAFE_RESUGGEST_FAILURE);
  }
}

export interface SaveAttributionInput {
  projectId: string;
  indicatorId: string;
  attributionText: string;
}

export interface SaveAttributionResult {
  success: boolean;
  data?: ReviewPageData;
  error?: string;
}

export async function saveAttributionAction(
  input: SaveAttributionInput
): Promise<SaveAttributionResult> {
  await assertProjectVisibleToCurrentViewer(input.projectId);
  try {
    if (!viewerCan(await currentViewer(), 'review')) return failedReviewAction(input.projectId, ROLE_BLOCKED_MESSAGE);
    if (!isProjectPdmRegistered(input.projectId)) return failedReviewAction(input.projectId, projectPdmExclusionReason(input.projectId));
    const { projectId, indicatorId, attributionText } = input;

    // 1. 사업 격리 검증: indicatorId가 projectId에 속해 있는지 확인
    if (!isIndicatorInProject(indicatorId, projectId)) {
      return failedReviewAction(projectId, '해당 사업에 속한 지표가 아닙니다.');
    }

    saveIndicatorAttribution(projectId, indicatorId, attributionText ?? '');

    const updatedData = getReviewData(projectId);
    if (!updatedData) {
      return failedReviewAction(projectId, '사업 데이터를 불러올 수 없습니다.');
    }

    return { success: true, data: updatedData };
  } catch (error) {
    const thrown = errorMessage(error);
    return failedReviewAction(
      input.projectId,
      thrown && ALLOWED_ATTRIBUTION_GUIDANCE.has(thrown) ? thrown : SAFE_ATTRIBUTION_FAILURE
    );
  }
}

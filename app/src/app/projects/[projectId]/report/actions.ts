'use server';

import { getDatabase, getLatestReportDraft, getProject, saveReportDraft } from '@/server/store';
import {
  createReportDraft,
  generateReportDocx,
  getSavedReportDraftWithStatus,
  listReportDrafts,
} from '@/server/report';
import type { ReportDraftData, ReportTemplate } from '@/server/report/types';
import { currentViewer, GUEST_AI_BLOCKED_MESSAGE, viewerCan } from '@/server/viewer';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { isProjectPdmRegistered, projectPdmExclusionReason } from '@/server/project-pdm';
import { canAccessWorkflowScreen } from '@/lib/workflow-access';

export interface ReportVersionOption {
  id: string;
  draft_number?: number;
  created_at: string;
  isFinalized: boolean;
  finalizedAt?: string;
  finalizedRole?: string;
}

export interface GenerateReportActionResult {
  success: boolean;
  draft?: ReportDraftData;
  reportId?: string;
  error?: string;
}

/**
 * 보고서 초안 생성 서버 액션 (D35, FE-11)
 * 사업 격리: getProject 를 통해 projectId 유효성 검증
 */
export async function generateReportDraftAction(
  projectId: string,
  template?: Exclude<ReportTemplate, 'legacy7'>
): Promise<GenerateReportActionResult> {
  await assertProjectVisibleToCurrentViewer(projectId);
  try {
    if (!viewerCan(await currentViewer(), 'review')) {
      return { success: false, error: GUEST_AI_BLOCKED_MESSAGE };
    }

    if (!projectId || projectId.trim().length === 0) {
      return { success: false, error: '사업 식별자가 비어 있습니다.' };
    }

    const project = getProject(projectId);
    if (!project) {
      return { success: false, error: `사업 '${projectId}'를 찾을 수 없습니다.` };
    }

    if (!isProjectPdmRegistered(projectId)) return { success: false, error: projectPdmExclusionReason(projectId) };
    if (template && template !== 'ksp' && template !== 'eipp') return { success: false, error: '보고서 서식이 유효하지 않습니다.' };
    const draft = await createReportDraft(projectId, { template });
    const record = getLatestReportDraft(projectId);
    return { success: true, draft, reportId: record?.id };
  } catch (error) {
    const errorMsg =
      error instanceof Error ? error.message : '보고서 초안 생성 중 오류가 발생했습니다.';
    return { success: false, error: errorMsg };
  }
}

export interface ReportDownloadActionResult {
  success: boolean;
  fileName?: string;
  contentBase64?: string;
  error?: string;
}

export async function getReportVersionsAction(projectId: string): Promise<{ success: boolean; versions?: ReportVersionOption[]; error?: string }> {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!canAccessWorkflowScreen(viewer, 'report')) return { success: false, error: '이 역할에는 접근 권한이 없습니다.' };
  if (!isProjectPdmRegistered(projectId)) return { success: false, error: projectPdmExclusionReason(projectId) };
  return { success: true, versions: listReportDrafts(projectId).map(({ id, draft_number, created_at, isFinalized, finalizedAt, finalizedRole }) => ({ id, draft_number, created_at, isFinalized, finalizedAt, finalizedRole })) };
}

export async function getReportVersionAction(projectId: string, reportId: string): Promise<{ success: boolean; reportId?: string; draft?: ReportDraftData | null; isOutdated?: boolean; error?: string }> {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!canAccessWorkflowScreen(viewer, 'report')) return { success: false, error: '이 역할에는 접근 권한이 없습니다.' };
  if (!isProjectPdmRegistered(projectId)) return { success: false, error: projectPdmExclusionReason(projectId) };
  const db = getDatabase();
  const saved = getSavedReportDraftWithStatus(projectId, db, undefined, undefined, reportId);
  const draft = saved.draft;
  if (!draft) return { success: false, error: '선택한 보고서 판을 찾을 수 없습니다.' };
  const isOutdated = saved.isOutdated;
  return { success: true, reportId, draft: isOutdated ? null : draft, isOutdated };
}

/** 확정은 저장된 판에만 붙이고 새 행으로 기록한다. */
export async function finalizeReportAction(projectId: string, createdAt: string, acknowledgePending: boolean): Promise<GenerateReportActionResult> {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (viewer.kind !== 'member' || viewer.role !== '평가팀') return { success: false, error: '문안 최종 확정은 평가팀만 할 수 있습니다.' };
  if (!isProjectPdmRegistered(projectId)) return { success: false, error: projectPdmExclusionReason(projectId) };
  try {
    const db = getDatabase();
    return db.transaction(() => {
      const record = getLatestReportDraft(projectId, db);
      const saved = getSavedReportDraftWithStatus(projectId, db, undefined, undefined, record?.id);
      const draft = saved.draft;
      if (!record || !draft || draft.created_at !== createdAt) return { success: false, error: '보고서 판이 바뀌었습니다. 화면을 새로고침해 주세요.' };
      if (saved.isOutdated) return { success: false, error: '근거가 바뀌었습니다. 초안을 다시 만드세요.' };
      if ((draft.review_pending_count ?? 1) > 0 && !acknowledgePending) return { success: false, error: '근거 검토가 남아 있습니다. 확인 후 다시 확정하세요.' };
      if (draft.report_finalization) return { success: true, draft, reportId: record.id };
      draft.report_finalization = { role: viewer.role, confirmed_at: new Date().toISOString() };
      const finalized = saveReportDraft(projectId, JSON.stringify(draft), db);
      return { success: true, draft, reportId: finalized.id };
    })();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '문안을 확정하지 못했습니다.' };
  }
}

export async function generateReportDownloadAction(
  projectId: string,
  reportId?: string,
): Promise<ReportDownloadActionResult> {
  await assertProjectVisibleToCurrentViewer(projectId);
  try {
    if (!projectId || projectId.trim().length === 0) {
      return { success: false, error: '사업 식별자가 유효하지 않습니다.' };
    }

    const project = getProject(projectId);
    if (!project) {
      return { success: false, error: `사업 '${projectId}'를 찾을 수 없습니다.` };
    }

    const viewer = await currentViewer();
    if (!canAccessWorkflowScreen(viewer, 'report')) return { success: false, error: '이 역할에는 접근 권한이 없습니다.' };
    const planner = viewer.kind === 'member' && viewer.role === '기획팀';
    if (!planner && !viewerCan(viewer, 'review')) return { success: false, error: '이 역할에는 접근 권한이 없습니다.' };
    if (!isProjectPdmRegistered(projectId)) return { success: false, error: projectPdmExclusionReason(projectId) };
    const saved = getSavedReportDraftWithStatus(projectId, undefined, undefined, undefined, reportId);
    const draft = saved.draft;
    if (!draft) {
      return { success: false, error: '저장된 초안이 없습니다. 먼저 초안을 만드세요.' };
    }

    if (planner) {
      if (!draft.report_finalization) return { success: false, error: '기획팀은 평가팀 최종 확정본만 내려받을 수 있습니다.' };
    }
    if (saved.isOutdated) return { success: false, error: '확정 내용이 바뀌었습니다. 초안을 다시 만드세요.' };

    const buffer = await generateReportDocx(draft);
    return {
      success: true,
      fileName: `report_${projectId}.docx`,
      contentBase64: buffer.toString('base64'),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Word 파일을 내려받지 못했습니다.',
    };
  }
}

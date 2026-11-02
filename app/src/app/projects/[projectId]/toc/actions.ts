'use server';

import crypto from 'node:crypto';
import {
  getDatabase,
  getDocumentInProject,
  getIndicatorConflict,
  getIndicatorInProject,
  isDocumentInProject,
  isIndicatorInProject,
  listIndicatorConflicts,
  saveIndicatorBaseline,
  TocPageData,
  getOutcomeFinalResults,
  OutcomeFinalResultsData,
} from '@/server/store';
import { getOrSyncTocForProject } from '@/server/toc';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { currentViewer, viewerCan } from '@/server/viewer';
import { isProjectPdmRegistered, projectPdmExclusionReason } from '@/server/project-pdm';
import { getProjectOntologyGraph } from '@/server/ontology/store';

export interface SelectBaselineResult {
  success: boolean;
  data?: TocPageData;
  error?: string;
}

export async function getTocPageDataAction(projectId: string): Promise<TocPageData | null> {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'review') && !viewerCan(viewer, 'opinion')) return null;
  if (!isProjectPdmRegistered(projectId)) return null;
  return getOrSyncTocForProject(projectId);
}

export async function getTocGraphAction(projectId: string) {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if ((!viewerCan(viewer, 'review') && !viewerCan(viewer, 'opinion')) || !isProjectPdmRegistered(projectId)) return null;
  return getProjectOntologyGraph(projectId);
}

export async function getOutcomeFinalResultsAction(projectId: string): Promise<OutcomeFinalResultsData | null> {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'review') && !viewerCan(viewer, 'opinion')) return null;
  if (!isProjectPdmRegistered(projectId)) return null;
  return getOutcomeFinalResults(projectId);
}

export async function selectBaselineAction(
  projectId: string,
  indicatorId: string,
  documentId: string,
  conflictId?: string
): Promise<SelectBaselineResult> {
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!viewerCan(await currentViewer(), 'review')) return { success: false, error: '이 역할에는 이 작업 권한이 없습니다.' };
  if (!isProjectPdmRegistered(projectId)) return { success: false, error: projectPdmExclusionReason(projectId) };
  try {
    // 사업 격리 검사 (RQ-26)
    if (!isIndicatorInProject(indicatorId, projectId)) {
      return { success: false, error: '해당 사업에 속한 지표가 아닙니다.' };
    }
    if (!isDocumentInProject(documentId, projectId)) {
      return { success: false, error: '해당 사업에 속한 문서가 아닙니다.' };
    }

    const conflicts = listIndicatorConflicts(projectId);
    let conflict = conflictId
      ? conflicts.find((c) => c.id === conflictId && c.indicator_id === indicatorId)
      : undefined;

    if (!conflict) {
      conflict = conflicts.find(
        (c) =>
          c.indicator_id === indicatorId &&
          (c.doc_a_id === documentId || c.doc_b_id === documentId)
      );
    }

    if (!conflict) {
      conflict = getIndicatorConflict(indicatorId);
    }

    if (!conflict) {
      return { success: false, error: '해당 지표에 등록된 충돌 정보가 없습니다.' };
    }

    const doc = getDocumentInProject(documentId, projectId);
    if (!doc) {
      return { success: false, error: '문서 정보를 찾을 수 없습니다.' };
    }

    let targetValue: string;
    let documentName: string;

    if (documentId === conflict.doc_a_id) {
      targetValue = conflict.doc_a_value;
      documentName = conflict.doc_a_name;
    } else if (documentId === conflict.doc_b_id) {
      targetValue = conflict.doc_b_value;
      documentName = conflict.doc_b_name;
    } else {
      return {
        success: false,
        error: '충돌에 관련된 두 문서 중 하나만 기준 문서로 선택할 수 있습니다.',
      };
    }

    const otherDocId = documentId === conflict.doc_a_id ? conflict.doc_b_id : conflict.doc_a_id;

    saveIndicatorBaseline({
      id: crypto.randomUUID(),
      project_id: projectId,
      indicator_id: indicatorId,
      document_id: documentId,
      document_name: documentName,
      target_value: targetValue,
      selected_at: new Date().toISOString(),
      conflict_id: conflict.id,
      other_doc_id: otherDocId,
    });

    const updatedToc = getOrSyncTocForProject(projectId);
    if (!updatedToc) {
      return { success: false, error: 'ToC 데이터를 갱신할 수 없습니다.' };
    }

    return { success: true, data: updatedToc };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

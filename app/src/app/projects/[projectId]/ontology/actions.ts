'use server';

import { getProject } from '@/server/store';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { currentViewer, viewerCan } from '@/server/viewer';
import { loadSyntheticOntologyGraphs } from '@/server/ontology/fixtures';
import {
  getProjectOntology,
  getProjectOntologyGraph,
  getProjectOntologyEvidenceSource,
  listProjectOntologyEvidence,
  replaceProjectOntology,
} from '@/server/ontology/store';
import { getLatestGenerationRun } from '@/server/ontology/generation-store';
import { startProjectOntologyGeneration } from '@/server/ontology/generation-service';
import { isProjectPdmRegistered, projectPdmExclusionReason } from '@/server/project-pdm';
import { getParagraphsByDocument, listDocuments } from '@/server/store';

export async function getOntologyPageAction(projectId: string) {
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!getProject(projectId)) return { success: false as const, error: '사업을 찾을 수 없습니다.' };
  if (!viewerCan(await currentViewer(), 'review') && !viewerCan(await currentViewer(), 'opinion')) return { success: false as const, error: '이 역할에는 접근 권한이 없습니다.' };
  if (!isProjectPdmRegistered(projectId)) return { success: false as const, error: projectPdmExclusionReason(projectId) };
  const graphs = loadSyntheticOntologyGraphs();
  return { success: true as const, availableVaults: graphs.map(({ code, projectName }) => ({ code, name: projectName })), ...getProjectOntology(projectId), graph: getProjectOntologyGraph(projectId), generation: getLatestGenerationRun(projectId) };
}

export async function importOntologyAction(projectId: string, code: string) {
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!getProject(projectId)) return { success: false as const, error: '사업을 찾을 수 없습니다.' };
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'review')) return { success: false as const, error: '이 역할에는 이 작업 권한이 없습니다.' };
  if (!isProjectPdmRegistered(projectId)) return { success: false as const, error: projectPdmExclusionReason(projectId) };
  const graph = loadSyntheticOntologyGraphs().find((candidate) => candidate.code === code);
  if (!graph) return { success: false as const, error: '선택할 수 없는 가상 사업입니다.' };
  try {
    replaceProjectOntology(projectId, graph, viewer.kind === 'member' ? viewer.login : 'guest');
    const graphs = loadSyntheticOntologyGraphs();
    return { success: true as const, availableVaults: graphs.map(({ code: vaultCode, projectName }) => ({ code: vaultCode, name: projectName })), ...getProjectOntology(projectId), graph: getProjectOntologyGraph(projectId), generation: getLatestGenerationRun(projectId) };
  } catch (error) {
    console.error('온톨로지 저장 실패', error);
    return { success: false as const, error: '온톨로지를 저장하지 못했습니다.' };
  }
}

export async function startOntologyGenerationAction(projectId: string) {
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!getProject(projectId)) return { success: false as const, error: '사업을 찾을 수 없습니다.' };
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'review')) return { success: false as const, error: '이 역할에는 이 작업 권한이 없습니다.' };
  if (!isProjectPdmRegistered(projectId)) return { success: false as const, error: projectPdmExclusionReason(projectId) };
  const hasInput = listDocuments(projectId).some((doc) => doc.is_included === 1 && doc.status === '추출 완료' && getParagraphsByDocument(doc.id).length > 0);
  if (!hasInput) return { success: false as const, error: '포함·추출 완료된 문단이 없습니다.' };
  const run = startProjectOntologyGeneration(projectId, viewer.kind === 'member' ? viewer.login : 'guest');
  if (!run) return { success: false as const, error: '이 사업의 온톨로지 생성이 이미 진행 중입니다.', generation: getLatestGenerationRun(projectId) };
  return { success: true as const, generation: run };
}

export async function getOntologyGenerationAction(projectId: string) {
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!getProject(projectId)) return { success: false as const, error: '사업을 찾을 수 없습니다.' };
  if (!viewerCan(await currentViewer(), 'review') && !viewerCan(await currentViewer(), 'opinion')) return { success: false as const, error: '이 역할에는 접근 권한이 없습니다.' };
  if (!isProjectPdmRegistered(projectId)) return { success: false as const, error: projectPdmExclusionReason(projectId) };
  return { success: true as const, generation: getLatestGenerationRun(projectId) };
}

export async function getOntologyEvidenceAction(projectId: string) {
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!getProject(projectId)) return { success: false as const, error: '사업을 찾을 수 없습니다.' };
  if (!viewerCan(await currentViewer(), 'review') && !viewerCan(await currentViewer(), 'opinion')) return { success: false as const, error: '이 역할에는 접근 권한이 없습니다.' };
  if (!isProjectPdmRegistered(projectId)) return { success: false as const, error: projectPdmExclusionReason(projectId) };
  return { success: true as const, ...listProjectOntologyEvidence(projectId) };
}

export async function getOntologyEvidenceSourceAction(projectId: string, evidenceId: string) {
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!getProject(projectId)) return { success: false as const, error: '사업을 찾을 수 없습니다.' };
  if (!viewerCan(await currentViewer(), 'review') && !viewerCan(await currentViewer(), 'opinion')) return { success: false as const, error: '이 역할에는 접근 권한이 없습니다.' };
  if (!isProjectPdmRegistered(projectId)) return { success: false as const, error: projectPdmExclusionReason(projectId) };
  const source = getProjectOntologyEvidenceSource(projectId, evidenceId);
  if (!source) return { success: false as const, error: '이 사업에서 원문 위치를 찾을 수 없습니다.' };
  return { success: true as const, source };
}

'use server';

import crypto from 'node:crypto';
import { createProject, listProjectsWithCount, ProjectMetadata, ProjectWithCount, updateProjectMetadata } from '@/server/store';
import { assertProjectVisibleToCurrentViewer, filterProjectsForCurrentViewer } from '@/server/project-visibility';
import { currentViewer, GUEST_WRITE_BLOCKED_MESSAGE, ROLE_BLOCKED_MESSAGE, viewerCan } from '@/server/viewer';

export interface CreateProjectResult {
  success: boolean;
  projectId?: string;
  error?: string;
}

function cleanMetadata(input: ProjectMetadata): ProjectMetadata {
  const text = (value: string | null | undefined) => value?.trim().slice(0, 180) || null;
  return {
    project_year: input.project_year && input.project_year >= 1990 && input.project_year <= 2200 ? input.project_year : null,
    country: text(input.country), region: text(input.region), partner_ministry: text(input.partner_ministry),
    project_type: text(input.project_type), kdi_cid: text(input.kdi_cid), implementing_org: text(input.implementing_org),
    partner_government_org: text(input.partner_government_org), is_ended: input.is_ended === 1 ? 1 : input.is_ended === 0 ? 0 : null,
    pilot_label: text(input.pilot_label),
    metadata_source: input.metadata_source === '종료평가보고서' || input.metadata_source === '등록 정보' ? input.metadata_source : null,
  };
}

export async function createProjectAction(name: string, metadata: ProjectMetadata = {}): Promise<CreateProjectResult> {
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'admin') && !viewerCan(viewer, 'review')) {
    return { success: false, error: viewer.kind === 'guest' ? GUEST_WRITE_BLOCKED_MESSAGE : ROLE_BLOCKED_MESSAGE };
  }
  const trimmed = name?.trim();
  if (!trimmed || trimmed.length === 0) {
    // D47: 빈 이름 오류
    return {
      success: false,
      error: '사업 이름을 입력해 주세요.',
    };
  }

  try {
    const id = `proj-${crypto.randomUUID().slice(0, 8)}`;
    createProject({
      id,
      name: trimmed,
      created_at: new Date().toISOString(),
      ...cleanMetadata(metadata),
    });

    return {
      success: true,
      projectId: id,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function updateProjectMetadataAction(projectId: string, metadata: ProjectMetadata): Promise<{ success: boolean; error?: string }> {
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'admin') && !viewerCan(viewer, 'review')) return { success: false, error: viewer.kind === 'guest' ? GUEST_WRITE_BLOCKED_MESSAGE : ROLE_BLOCKED_MESSAGE };
  if (!projectId || typeof projectId !== 'string') return { success: false, error: '사업을 확인할 수 없습니다.' };
  try {
    await assertProjectVisibleToCurrentViewer(projectId);
    updateProjectMetadata(projectId, cleanMetadata(metadata));
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getProjectsAction(): Promise<ProjectWithCount[]> {
  return filterProjectsForCurrentViewer(listProjectsWithCount());
}

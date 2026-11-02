'use server';

import { revalidatePath } from 'next/cache';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { currentViewer, ROLE_BLOCKED_MESSAGE, viewerCan } from '@/server/viewer';
import { isProjectPdmRegistered } from '@/server/project-pdm';
import { savePortfolioLevel } from '@/server/store/portfolio';

export async function savePortfolioLevelAction(
  projectId: string,
  importId: string,
  nodeId: string,
  teamLevel: string,
) {
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!isProjectPdmRegistered(projectId))
    return { success: false as const, error: '성과관리표(PDM)를 먼저 포함 상태로 등록해야 합니다.' };
  const viewer = await currentViewer();
  if (viewer.kind !== 'member' || !viewerCan(viewer, 'portfolio'))
    return { success: false as const, error: ROLE_BLOCKED_MESSAGE };
  try {
    savePortfolioLevel(projectId, importId, nodeId, teamLevel, viewer.login);
    revalidatePath(`/projects/${projectId}/portfolio`);
    return { success: true as const };
  } catch (error) {
    const known = [
      '최신 사업 성과 노트를 찾을 수 없습니다. 화면을 새로고침해 주세요.',
      '현재 사업의 성과 노트를 찾을 수 없습니다.',
      '성과군이 확인된 성과에만 레벨을 입력할 수 있습니다.',
      '성과군에 맞지 않는 레벨입니다.',
      '평가자 정보를 확인할 수 없습니다.',
    ];
    return {
      success: false as const,
      error: error instanceof Error && known.includes(error.message)
        ? error.message
        : '평가팀 레벨을 저장하지 못했습니다.',
    };
  }
}

'use server';

import { currentViewer } from '@/server/viewer';
import { isProjectPdmRegistered } from '@/server/project-pdm';
import { getProject } from '@/server/store';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';

export async function getProjectNavigationAction(projectId: string) {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (viewer.kind !== 'member' || !getProject(projectId)) return null;
  return { role: viewer.role, hasPdm: isProjectPdmRegistered(projectId) };
}

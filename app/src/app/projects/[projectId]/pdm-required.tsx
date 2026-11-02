import { projectPdmExclusionReason } from '@/server/project-pdm';
import { redirect } from 'next/navigation';
import { currentViewer } from '@/server/viewer';
import { canAccessWorkflowScreen } from '@/lib/workflow-access';

export async function pdmRequired(projectId: string) {
  const viewer = await currentViewer();
  if (canAccessWorkflowScreen(viewer, 'documents')) redirect(`/projects/${projectId}/documents?pdm=required`);
  return <main role="status" className="p-6">{projectPdmExclusionReason(projectId)}</main>;
}

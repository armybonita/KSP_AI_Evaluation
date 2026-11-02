import { redirect } from 'next/navigation';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { currentViewer } from '@/server/viewer';
import { canAccessWorkflowScreen } from '@/lib/workflow-access';

export const dynamic = 'force-dynamic';

// Keep the old route addressable while moving the detailed ontology graph into
// the ② view switch on the initial ToC screen.
export default async function OntologyPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (canAccessWorkflowScreen(viewer, 'toc')) redirect(`/projects/${projectId}/toc?view=graph`);
  redirect(`/projects/${projectId}/result`);
}

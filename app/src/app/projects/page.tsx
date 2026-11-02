import React from 'react';
import { listProjectsWithCount } from '@/server/store';
import { filterProjectsForCurrentViewer } from '@/server/project-visibility';
import { ProjectsClientView } from './projects-client-view';
import { currentViewer, viewerCan } from '@/server/viewer';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const projects = await filterProjectsForCurrentViewer(listProjectsWithCount());

  const viewer = await currentViewer();
  const canCreate = viewerCan(viewer, 'admin') || viewerCan(viewer, 'review');
  const canRegisterDocuments = viewerCan(viewer, 'upload');
  const canManageMetadata = viewerCan(viewer, 'admin') || viewerCan(viewer, 'review');
  const canOpenInitialToc = viewerCan(viewer, 'admin') || viewerCan(viewer, 'review') || viewerCan(viewer, 'opinion');
  const isPlanningViewer = viewer.kind === 'member' && viewer.role === '기획팀';

  return <ProjectsClientView initialProjects={projects} canCreate={canCreate} canRegisterDocuments={canRegisterDocuments} canManageMetadata={canManageMetadata} canOpenInitialToc={canOpenInitialToc} isPlanningViewer={isPlanningViewer} role={viewer.kind === 'member' ? viewer.role : undefined} />;
}

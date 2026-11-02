import React from 'react';
import { notFound } from 'next/navigation';
import { pdmRequired } from '../pdm-required';
import { canAccessWorkflowScreen } from '@/lib/workflow-access';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { currentViewer, viewerCan } from '@/server/viewer';
import { isProjectPdmRegistered } from '@/server/project-pdm';
import { getPortfolioPageData } from '@/server/store/portfolio';
import { PortfolioClientView } from './portfolio-client-view';

export const dynamic = 'force-dynamic';

export default async function PortfolioPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!isProjectPdmRegistered(projectId)) return pdmRequired(projectId);
  const viewer = await currentViewer();
  if (!canAccessWorkflowScreen(viewer, 'review')) notFound();
  const data = getPortfolioPageData(projectId);
  if (!data) notFound();
  return <PortfolioClientView key={`${projectId}:${data.importId ?? ''}`} initialData={data} canEdit={viewerCan(viewer, 'portfolio')} />;
}

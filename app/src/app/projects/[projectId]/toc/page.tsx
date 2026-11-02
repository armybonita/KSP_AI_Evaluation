import { pdmRequired } from '../pdm-required';
import { canAccessWorkflowScreen } from '@/lib/workflow-access';
import React from 'react';
import { notFound } from 'next/navigation';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { isProjectPdmRegistered } from '@/server/project-pdm';
import { EvidenceQuoteCacheNotReady, getDatabase } from '@/server/store';
import { getProjectOntologyGraph } from '@/server/ontology/store';
import { getFactorNoteStatuses, getNoteReviewItemIds } from '@/server/store/note-review';
import { getOutcomeFinalResultsAction, getTocPageDataAction } from './actions';
import { TocClientView } from './toc-client-view';
import { OntologyClientView } from '../ontology/ontology-client-view';
import { currentViewer, viewerCan } from '@/server/viewer';

export const dynamic = 'force-dynamic';

export default async function TocPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ view?: string }>;
}) {
  const { projectId } = await params;
  if (!projectId || typeof projectId !== 'string') {
    notFound();
  }
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!canAccessWorkflowScreen(viewer, 'toc')) notFound();
  if (!isProjectPdmRegistered(projectId)) return pdmRequired(projectId);

  const data = await getTocPageDataAction(projectId);
  let outcomeFinalResults = null;
  let outcomeResultsPending = false;
  try {
    outcomeFinalResults = await getOutcomeFinalResultsAction(projectId);
  } catch (error) {
    if (!(error instanceof EvidenceQuoteCacheNotReady)) throw error;
    outcomeResultsPending = true;
  }
  const query = searchParams ? await searchParams : {};
  if (!data) {
    notFound();
  }

  const graph = getProjectOntologyGraph(projectId, getDatabase(), query.view === 'graph');
  const factorStatuses = getFactorNoteStatuses(projectId, getDatabase(), graph.nodes);

  return (
    <>
    {outcomeResultsPending && <p role="status">성과표의 근거 확인을 준비 중입니다.</p>}
    <TocClientView
      initialData={data}
      initialGraph={graph}
      reviewNodeIds={getNoteReviewItemIds(projectId)}
      noteItems={factorStatuses}
      projectId={projectId}
      initialGraphView={query.view === 'graph'}
      outcomeFinalResults={outcomeFinalResults}
    />
    {query.view === 'graph' && <OntologyClientView projectId={projectId} projectName={data.project.name} canImport={viewerCan(viewer, 'review')} noteItems={factorStatuses} />}
    </>
  );
}

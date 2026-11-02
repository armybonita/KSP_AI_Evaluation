import { excludedDocumentSummary } from '@/server/store/excluded-documents';
import { pdmRequired } from '../pdm-required';
import { canAccessWorkflowScreen } from '@/lib/workflow-access';
import React from 'react';
import { notFound } from 'next/navigation';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { isProjectPdmRegistered } from '@/server/project-pdm';
import { ReviewClientView } from './review-client-view';
import { getNoteReviewData } from '@/server/store/note-review';
import { getProjectCitationContext, getReviewData, isIndicatorInProject } from '@/server/store';
import { currentViewer, isGuestViewer, viewerCan } from '@/server/viewer';
import {
  resolveReviewPageState,
  getAutoOpenSnippetId,
  validateReviewParams,
  ReviewPageParams,
  ReviewPageSearchParams,
} from './review-page-state';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<ReviewPageParams>;
  searchParams?: Promise<ReviewPageSearchParams>;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const validated = validateReviewParams(resolvedParams, resolvedSearchParams);
  if (!validated) {
    notFound();
  }
  await assertProjectVisibleToCurrentViewer(validated.projectId);
  const viewer = await currentViewer();
  if (!canAccessWorkflowScreen(viewer, 'review')) notFound();
  if (!isProjectPdmRegistered(validated.projectId)) return pdmRequired(validated.projectId);

  let citationContext;
  try {
    citationContext = getProjectCitationContext(validated.projectId);
  } catch {
    notFound();
  }
  const state = resolveReviewPageState(validated, resolvedSearchParams, {
    isIndicatorInProject,
    getReviewData: (projectId) => getReviewData(projectId, undefined, citationContext),
  });
  if (state.type === 'not-found') {
    notFound();
  }
  const noteReviewData = getNoteReviewData(validated.projectId, undefined, citationContext);
  if (resolvedSearchParams?.noteStatus === 'confirmed') {
    noteReviewData.items = noteReviewData.items.filter(item => ['확정', '수정 후 확정'].includes(item.history.at(-1)?.status ?? ''));
  }
  const requestedNodeId = resolvedSearchParams?.nodeId;
  const initialSelectedNoteNodeId = typeof requestedNodeId === 'string' && noteReviewData.items.some((item) => item.id === requestedNodeId)
    ? requestedNodeId
    : undefined;

  return (
    <ReviewClientView
      exclusionSummary={excludedDocumentSummary(validated.projectId)}
      noteReviewData={noteReviewData}
      initialSelectedNoteNodeId={initialSelectedNoteNodeId}
      initialData={state.reviewData}
      initialSelectedIndicatorId={state.reviewData.indicators.some(
        (item) => item.indicator.id === state.selectedIndicatorId
      ) ? state.selectedIndicatorId : undefined}
      initialAutoOpenSnippetId={getAutoOpenSnippetId(
        new URLSearchParams(Object.entries(resolvedSearchParams ?? {}).flatMap(([key, value]) =>
          typeof value === 'string' ? [[key, value]] : []
        )).toString(),
        state.reviewData,
        state.selectedIndicatorId
      )}
      isGuest={isGuestViewer(viewer)}
      canConfirm={viewerCan(viewer, 'confirm')}
    />
  );
}

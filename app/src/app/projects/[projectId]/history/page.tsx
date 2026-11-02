import React from 'react';
import { notFound, redirect } from 'next/navigation';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { isProjectPdmRegistered } from '@/server/project-pdm';
import { HistoryClientView } from './history-client-view';
import type { HistoryPageParams, HistoryPageSearchParams } from './history-page-state';
import {
  resolveHistoryPageState,
  validateHistoryParams,
} from './history-page-state';
import { currentViewer } from '@/server/viewer';

export const dynamic = 'force-dynamic';

export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<HistoryPageParams>;
  searchParams?: Promise<HistoryPageSearchParams>;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const validated = validateHistoryParams(resolvedParams, resolvedSearchParams);
  if (!validated) {
    notFound();
  }
  await assertProjectVisibleToCurrentViewer(validated.projectId);
  if (!isProjectPdmRegistered(validated.projectId)) redirect(`/projects/${validated.projectId}/documents?pdm=required`);
  const viewer = await currentViewer();
  if (viewer.kind !== 'member' || viewer.role !== 'Admin') notFound();

  let state: ReturnType<typeof resolveHistoryPageState>;
  try {
    state = resolveHistoryPageState(
      { projectId: validated.projectId },
      { indicatorId: validated.indicatorId }
    );
  } catch (err) {
    return (
      <HistoryClientView
        projectId={validated.projectId}
        requestedIndicatorId={validated.indicatorId}
        initialData={null}
        initialLoadError={err instanceof Error ? err.message : String(err)}
      />
    );
  }

  if (state.type === 'not-found') notFound();

  return (
    <HistoryClientView
      projectId={validated.projectId}
      requestedIndicatorId={validated.indicatorId}
      initialData={state.historyData}
      initialSelectedIndicatorId={state.selectedIndicatorId}
    />
  );
}

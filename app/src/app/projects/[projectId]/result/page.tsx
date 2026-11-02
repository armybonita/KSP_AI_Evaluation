import { pdmRequired } from '../pdm-required';
import { canAccessWorkflowScreen } from '@/lib/workflow-access';
import React from 'react';
import { excludedDocumentSummary } from '@/server/store/excluded-documents';
import { notFound } from 'next/navigation';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { isProjectPdmRegistered } from '@/server/project-pdm';
import { currentViewer, viewerCan } from '@/server/viewer';
import { ResultTocPageClientView } from './result-client-view';
import type { ResultTocPageParams } from './result-page-state';
import {
  resolveResultTocPageState,
  validateResultTocParams,
} from './result-page-state';

export const dynamic = 'force-dynamic';

export default async function ResultTocPage({
  params,
}: {
  params: Promise<ResultTocPageParams>;
}) {
  const resolvedParams = await params;
  const validated = validateResultTocParams(resolvedParams);
  if (!validated) {
    notFound();
  }
  await assertProjectVisibleToCurrentViewer(validated.projectId);

  const viewer = await currentViewer();
  if (!canAccessWorkflowScreen(viewer, 'result')) notFound();
  if (!isProjectPdmRegistered(validated.projectId)) return pdmRequired(validated.projectId);
  const canViewHistory = viewerCan(viewer, 'admin');
  const exclusionSummary = excludedDocumentSummary(validated.projectId);
  let state: ReturnType<typeof resolveResultTocPageState>;
  try {
    state = resolveResultTocPageState({ projectId: validated.projectId });
  } catch (err) {
    return (
      <ResultTocPageClientView
        canViewHistory={canViewHistory}
        projectId={validated.projectId}
        exclusionSummary={exclusionSummary}
        initialData={null}
        initialLoadError={err instanceof Error ? err.message : String(err)}
      />
    );
  }

  if (state.type === 'not-found') notFound();

  return (
    <ResultTocPageClientView
      canViewHistory={canViewHistory}
      projectId={validated.projectId}
      exclusionSummary={exclusionSummary}
      initialData={state.resultData}
    />
  );
}

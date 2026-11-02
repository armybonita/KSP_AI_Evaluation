import { excludedDocumentSummary } from '@/server/store/excluded-documents';
import { pdmRequired } from '../pdm-required';
import { canAccessWorkflowScreen } from '@/lib/workflow-access';
import React from 'react';
import { getConfirmedNoteCount } from '@/server/store/note-review';
import { notFound } from 'next/navigation';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { isProjectPdmRegistered } from '@/server/project-pdm';
import { getProject, getProjectCitationContext, getReportTargetCount, getReportTargets } from '@/server/store';
import { getSavedReportDraftWithStatus, listReportDrafts } from '@/server/report';
import { currentViewer, isGuestViewer, viewerCan } from '@/server/viewer';
import { ReportClientView } from './report-client-view';

export const dynamic = 'force-dynamic';

export default async function ReportPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const resolvedParams = await params;
  const projectId = resolvedParams?.projectId;

  if (!projectId || typeof projectId !== 'string') {
    notFound();
  }
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!canAccessWorkflowScreen(viewer, 'report')) notFound();

  const project = getProject(projectId);
  if (!project) {
    notFound();
  }

  if (!isProjectPdmRegistered(projectId)) return pdmRequired(projectId);

  const versions = listReportDrafts(projectId).map(({ id, draft_number, created_at, isFinalized, finalizedAt, finalizedRole }) => ({ id, draft_number, created_at, isFinalized, finalizedAt, finalizedRole }));
  const latestReportId = versions[0]?.id;
  const saved = getSavedReportDraftWithStatus(projectId, undefined, undefined, undefined, latestReportId);
  const savedDraft = saved.draft;
  const confirmedCount = getReportTargetCount(projectId);
  const confirmedNotes = getConfirmedNoteCount(projectId);

  // Version 2 drafts predate the revision-index fast path. Keep their target
  // context available for the existing evidence panel; summary drafts never
  // receive this full source payload.
  const isLegacyDraft = Boolean(savedDraft && savedDraft.version === 2 && savedDraft.summary_format !== 1);
  const legacyCitationContext = isLegacyDraft ? getProjectCitationContext(projectId) : undefined;
  const initialTargets = legacyCitationContext ? getReportTargets(projectId, undefined, legacyCitationContext) : [];
  const isOutdated = saved.isOutdated;
  const exclusionSummary = excludedDocumentSummary(projectId);

  let draft = null;
  if (savedDraft) draft = savedDraft;
  return (
    <ReportClientView
      exclusionSummary={exclusionSummary}
      project={project}
      initialTargets={initialTargets}
      initialDraft={isOutdated ? null : draft}
      initialConfirmedCount={confirmedCount}
      initialNoteConfirmedCount={confirmedNotes}
      initialReportId={latestReportId ?? null}
      initialLatestReportId={latestReportId ?? null}
      initialVersions={versions}
      initialOutdated={isOutdated}
      initialBannedSentences={legacyCitationContext?.originalSentences ?? []}
      isGuest={isGuestViewer(viewer)}
      canGenerate={viewerCan(viewer, 'review')}
      canFinalize={viewer.kind === 'member' && viewer.role === '평가팀'}
      reportFinalizationRequired={viewer.kind === 'member' && viewer.role === '기획팀'}
    />
  );
}

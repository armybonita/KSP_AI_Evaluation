'use server';

import type { HistoryPageData } from '@/server/store/types';
import { resolveHistoryPageState } from './history-page-state';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { currentViewer } from '@/server/viewer';
import { isProjectPdmRegistered } from '@/server/project-pdm';

export type HistoryPageLoadResult =
  | { status: 'ready'; data: HistoryPageData; selectedIndicatorId?: string }
  | { status: 'not-found' }
  | { status: 'error'; error: string };

export async function loadHistoryPageAction(
  projectId: string,
  indicatorId?: string
): Promise<HistoryPageLoadResult> {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!isProjectPdmRegistered(projectId) || viewer.kind !== 'member' || viewer.role !== 'Admin') return { status: 'not-found' };
  try {
    const state = resolveHistoryPageState(
      { projectId },
      { indicatorId }
    );
    if (state.type === 'not-found') {
      return { status: 'not-found' };
    }
    return {
      status: 'ready',
      data: state.historyData,
      selectedIndicatorId: state.selectedIndicatorId,
    };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

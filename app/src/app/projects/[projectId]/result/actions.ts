'use server';

import type { ResultTocPageData } from '@/server/store/types';
import { resolveResultTocPageState } from './result-page-state';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { isProjectPdmRegistered } from '@/server/project-pdm';

export type ResultTocPageLoadResult =
  | { status: 'ready'; data: ResultTocPageData }
  | { status: 'not-found' }
  | { status: 'error'; error: string };

export async function loadResultTocPageAction(
  projectId: string
): Promise<ResultTocPageLoadResult> {
  await assertProjectVisibleToCurrentViewer(projectId);
  if (!isProjectPdmRegistered(projectId)) return { status: 'not-found' };
  try {
    const state = resolveResultTocPageState({ projectId });
    if (state.type === 'not-found') {
      return { status: 'not-found' };
    }
    return { status: 'ready', data: state.resultData };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

import { getReviewData, isIndicatorInProject, ReviewPageData } from '@/server/store';

export type ReviewPageParams = {
  projectId?: unknown;
};

export type ReviewPageSearchParams = {
  noteStatus?: string;
  indicatorId?: unknown;
  nodeId?: unknown;
  [key: string]: unknown;
};

export interface ValidatedReviewInputs {
  projectId: string;
  indicatorId?: string;
}

export interface ReviewStore {
  isIndicatorInProject: (indicatorId: string, projectId: string) => boolean;
  getReviewData: (projectId: string) => ReviewPageData | null;
}

/**
 * params 와 searchParams 의 입력 형식을 검증하는 순수 함수.
 * projectId 가 문자열이 아니거나 빈 문자열인 경우, 또는
 * indicatorId 가 제공되었으나 문자열이 아닌 경우(배열 등) null 을 반환함.
 */
export function validateReviewParams(
  params: ReviewPageParams | null | undefined,
  searchParams?: ReviewPageSearchParams | null | undefined
): ValidatedReviewInputs | null {
  if (!params || typeof params.projectId !== 'string' || params.projectId.trim() === '') {
    return null;
  }

  const indicatorId = searchParams?.indicatorId;
  if (indicatorId !== undefined && typeof indicatorId !== 'string') {
    return null;
  }

  return {
    projectId: params.projectId,
    indicatorId: indicatorId || undefined,
  };
}

export type ReviewPageState =
  | { type: 'not-found' }
  | { type: 'ready'; reviewData: ReviewPageData; selectedIndicatorId?: string };

/** Resolve source auto-open on the server, where review data has project-scoped citation status. */
export function getAutoOpenSnippetId(
  search: string,
  reviewData: ReviewPageData,
  selectedIndicatorId?: string
): string | null {
  const query = new URLSearchParams(search);
  const snippetId = query.get('open') === 'source' ? query.get('snippet') : null;
  const indicatorId = query.get('indicatorId');
  if (!snippetId || !selectedIndicatorId || indicatorId !== selectedIndicatorId) return null;

  const selected = reviewData.indicators.find((item) => item.indicator.id === selectedIndicatorId);
  const evidence = selected?.suggestion?.evidences.find((item) => item.id === snippetId);
  return evidence?.is_citation_banned === 0 ? snippetId : null;
}

/**
 * 검토 화면의 데이터 및 선택 지표 상태를 결정하는 순수 함수.
 * 배열 등 부적절한 형식이 주어지거나 존재하지 않는 사업/지표인 경우 예외 없이 not-found 상태를 반환함.
 */
export function resolveReviewPageState(
  params: ReviewPageParams | null | undefined,
  searchParams: ReviewPageSearchParams | null | undefined,
  store: ReviewStore = { isIndicatorInProject, getReviewData }
): ReviewPageState {
  const validated = validateReviewParams(params, searchParams);
  if (!validated) {
    return { type: 'not-found' };
  }

  const { projectId, indicatorId } = validated;

  if (indicatorId && !store.isIndicatorInProject(indicatorId, projectId)) {
    return { type: 'not-found' };
  }

  const reviewData = store.getReviewData(projectId);
  if (!reviewData) {
    return { type: 'not-found' };
  }

  return {
    type: 'ready',
    reviewData,
    selectedIndicatorId: indicatorId,
  };
}

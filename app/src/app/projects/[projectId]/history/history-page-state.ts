import { getHistoryPageData, HistoryPageData, isIndicatorInProject } from '@/server/store';

export type HistoryPageParams = {
  projectId?: unknown;
};

export type HistoryPageSearchParams = {
  indicatorId?: unknown;
  [key: string]: unknown;
};

export interface ValidatedHistoryInputs {
  projectId: string;
  indicatorId?: string;
}

export interface HistoryStore {
  isIndicatorInProject: (indicatorId: string, projectId: string) => boolean;
  getHistoryPageData: (projectId: string) => HistoryPageData | null;
}

/**
 * params 와 searchParams 의 입력 형식을 검증하는 순수 함수.
 * projectId 가 문자열이 아니거나 빈 문자열인 경우, 또는
 * indicatorId 가 제공되었으나 문자열이 아닌 경우(배열 등) null 을 반환함.
 */
export function validateHistoryParams(
  params: HistoryPageParams | null | undefined,
  searchParams?: HistoryPageSearchParams | null | undefined
): ValidatedHistoryInputs | null {
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

export type HistoryPageState =
  | { type: 'not-found' }
  | { type: 'ready'; historyData: HistoryPageData; selectedIndicatorId?: string };

/**
 * 이력 화면의 데이터 및 선택 지표 상태를 결정하는 순수 함수.
 * 배열 등 부적절한 형식이 주어지거나 존재하지 않는 사업/지표인 경우 예외 없이 not-found 상태를 반환함.
 */
export function resolveHistoryPageState(
  params: HistoryPageParams | null | undefined,
  searchParams: HistoryPageSearchParams | null | undefined,
  store: HistoryStore = { isIndicatorInProject, getHistoryPageData }
): HistoryPageState {
  const validated = validateHistoryParams(params, searchParams);
  if (!validated) {
    return { type: 'not-found' };
  }

  const { projectId, indicatorId } = validated;

  if (indicatorId && !store.isIndicatorInProject(indicatorId, projectId)) {
    return { type: 'not-found' };
  }

  const historyData = store.getHistoryPageData(projectId);
  if (!historyData) {
    return { type: 'not-found' };
  }

  const effectiveIndicatorId =
    indicatorId || (historyData.indicators.length > 0 ? historyData.indicators[0].indicator.id : undefined);

  return {
    type: 'ready',
    historyData,
    selectedIndicatorId: effectiveIndicatorId,
  };
}

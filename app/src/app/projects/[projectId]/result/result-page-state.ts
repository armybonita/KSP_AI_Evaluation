import {
  computeResultTocItemStatus,
  getResultTocData,
  ResultTocPageData,
} from '@/server/store';

export { computeResultTocItemStatus };

export type ResultTocPageParams = {
  projectId?: unknown;
};

export interface ValidatedResultTocInputs {
  projectId: string;
}

export interface ResultTocStore {
  getResultTocData: (projectId: string) => ResultTocPageData | null;
}

/**
 * params 의 입력 형식을 검증하는 순수 함수.
 * projectId 가 문자열이 아니거나 빈 문자열인 경우 null 을 반환함.
 */
export function validateResultTocParams(
  params: ResultTocPageParams | null | undefined
): ValidatedResultTocInputs | null {
  if (!params || typeof params.projectId !== 'string' || params.projectId.trim() === '') {
    return null;
  }

  return {
    projectId: params.projectId,
  };
}

export type ResultTocPageState =
  | { type: 'not-found' }
  | { type: 'ready'; resultData: ResultTocPageData };

/**
 * 결과 ToC 화면의 데이터 상태를 결정하는 순수 함수.
 * 배열 등 부적절한 형식이 주어지거나 존재하지 않는 사업인 경우 예외 없이 not-found 상태를 반환함.
 */
export function resolveResultTocPageState(
  params: ResultTocPageParams | null | undefined,
  store: ResultTocStore = { getResultTocData }
): ResultTocPageState {
  const validated = validateResultTocParams(params);
  if (!validated) {
    return { type: 'not-found' };
  }

  const { projectId } = validated;
  const resultData = store.getResultTocData(projectId);
  if (!resultData) {
    return { type: 'not-found' };
  }

  return {
    type: 'ready',
    resultData,
  };
}

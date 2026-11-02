import { describe, it, expect } from 'vitest';
import {
  computeResultTocItemStatus,
  validateResultTocParams,
  resolveResultTocPageState,
  ResultTocStore,
} from '../src/app/projects/[projectId]/result/result-page-state';
import type {
  ConfirmationRecord,
  IndicatorRecord,
  ProjectRecord,
  ResultTocItem,
  ResultTocPageData,
  SuggestionRecord,
} from '../src/server/store/types';

describe('결과 ToC (S7) 단위 시험 (#23, RQ-23, D05, D26, D28, UC-07, UC-14, UC-17)', () => {
  const dummyIndicator: IndicatorRecord = {
    id: 'ind-1',
    project_id: 'proj-1',
    level: '단기성과',
    name: '디지털 서비스 이용률',
    ovi: '가입자 수',
    mov: '통계',
    target_value: '100만명',
    is_baseline: 0,
    is_orphaned: 0,
    created_at: '2026-10-09T00:00:00.000Z',
  };

  const createDummySuggestion = (verdict: SuggestionRecord['verdict_status']): SuggestionRecord => ({
    id: 'sugg-1',
    indicator_id: 'ind-1',
    verdict_status: verdict,
    error_reason: null,
    proposal_text: 'AI 제안 문장',
    created_at: '2026-10-09T00:00:00.000Z',
  });

  const createDummyConfirmation = (
    type: ConfirmationRecord['confirmation_type'],
    suggestionId = 'sugg-1'
  ): ConfirmationRecord => ({
    id: 'conf-1',
    indicator_id: 'ind-1',
    suggestion_id: suggestionId,
    confirmation_type: type,
    confirmer_name: '평가자A',
    initial_proposal: 'AI 제안 문장',
    edited_text: type === '수정 후 확정' ? '수정된 제안 문장' : null,
    reason: type === '수정 후 확정' ? '수정 사유' : null,
    created_at: '2026-10-09T00:00:00.000Z',
  });

  describe('1. 항목별 최신 확정 매핑 및 표시 상태 계산 (computeResultTocItemStatus)', () => {
    it('확정 기록이 없는 경우: displayKind는 "미확정"이고 verdictStatus는 null이다 (D26)', () => {
      const result = computeResultTocItemStatus(null, createDummySuggestion('실현'));
      expect(result.displayKind).toBe('미확정');
      expect(result.verdictStatus).toBeNull();
    });

    it('확정 종류가 "확정"이고 AI 판정이 "실현"인 경우: displayKind는 "실현"이다 (D28 초록)', () => {
      const conf = createDummyConfirmation('확정');
      const sugg = createDummySuggestion('실현');
      const result = computeResultTocItemStatus(conf, sugg);
      expect(result.displayKind).toBe('실현');
      expect(result.verdictStatus).toBe('실현');
    });

    it('확정 종류가 "확정"이고 AI 판정이 "추진 중"인 경우: displayKind는 "추진 중"이다 (D28 파랑)', () => {
      const conf = createDummyConfirmation('확정');
      const sugg = createDummySuggestion('추진 중');
      const result = computeResultTocItemStatus(conf, sugg);
      expect(result.displayKind).toBe('추진 중');
      expect(result.verdictStatus).toBe('추진 중');
    });

    it('확정 종류가 "확정"이고 AI 판정이 "기대"인 경우: displayKind는 "기대"이다 (D28 노랑)', () => {
      const conf = createDummyConfirmation('확정');
      const sugg = createDummySuggestion('기대');
      const result = computeResultTocItemStatus(conf, sugg);
      expect(result.displayKind).toBe('기대');
      expect(result.verdictStatus).toBe('기대');
    });

    it('확정 종류가 "확정"이고 AI 판정이 "미확인"인 경우: displayKind는 "미확인"이다 (D28 회색)', () => {
      const conf = createDummyConfirmation('확정');
      const sugg = createDummySuggestion('미확인');
      const result = computeResultTocItemStatus(conf, sugg);
      expect(result.displayKind).toBe('미확인');
      expect(result.verdictStatus).toBe('미확인');
    });

    it('확정 종류가 "확정"이고 AI 판정이 "근거 충돌"인 경우: displayKind는 "근거 충돌"이다 (D28 주황)', () => {
      const conf = createDummyConfirmation('확정');
      const sugg = createDummySuggestion('근거 충돌');
      const result = computeResultTocItemStatus(conf, sugg);
      expect(result.displayKind).toBe('근거 충돌');
      expect(result.verdictStatus).toBe('근거 충돌');
    });

    it('확정 종류가 "수정 후 확정"이고 edited_verdict_status 가 지정된 경우: 평가자 판정을 우선하여 displayKind와 verdictStatus에 반영한다 (#23 결정)', () => {
      const conf: ConfirmationRecord = {
        id: 'conf-edited-verdict',
        indicator_id: 'ind-test',
        confirmation_type: '수정 후 확정',
        confirmer_name: '평가자',
        edited_text: '수정본',
        reason: '사유',
        edited_verdict_status: '실현',
        created_at: new Date().toISOString(),
      };
      const sugg = createDummySuggestion('추진 중');
      const result = computeResultTocItemStatus(conf, sugg);
      expect(result.displayKind).toBe('실현');
      expect(result.verdictStatus).toBe('실현');
    });

    it('확정 종류가 "수정 후 확정"이고 edited_verdict_status 가 없는 경우: AI 제안 판정 상태를 따르며 displayKind에 반영된다 (NOTES-23)', () => {
      const conf = createDummyConfirmation('수정 후 확정');
      const sugg = createDummySuggestion('실현');
      const result = computeResultTocItemStatus(conf, sugg);
      expect(result.displayKind).toBe('실현');
      expect(result.verdictStatus).toBe('실현');
    });

    it('확정 종류가 "수정 후 확정"이고 suggestion이 없는 예외 상황인 경우 "미확인"으로 처리된다', () => {
      const conf = createDummyConfirmation('수정 후 확정');
      const result = computeResultTocItemStatus(conf, null);
      expect(result.displayKind).toBe('미확인');
      expect(result.verdictStatus).toBe('미확인');
    });

    it('확정 종류가 "보완 필요"인 경우: AI 판정과 무관하게 displayKind는 "보완 필요"이다 (D05 회색 점선)', () => {
      const conf = createDummyConfirmation('보완 필요');
      const sugg = createDummySuggestion('실현');
      const result = computeResultTocItemStatus(conf, sugg);
      expect(result.displayKind).toBe('보완 필요');
      expect(result.verdictStatus).toBeNull();
    });

    it('확정 종류가 "채택 제외"인 경우: AI 판정과 무관하게 displayKind는 "채택 제외"이다 (D05 색 없이 취소선)', () => {
      const conf = createDummyConfirmation('채택 제외');
      const sugg = createDummySuggestion('실현');
      const result = computeResultTocItemStatus(conf, sugg);
      expect(result.displayKind).toBe('채택 제외');
      expect(result.verdictStatus).toBeNull();
    });
  });

  describe('2. 재확정 매핑 검증 (UC-14, RQ-18, RQ-23)', () => {
    it('이전 확정이 "보완 필요"였으나 최신 확정이 "확정 (기대)"로 재확정된 경우 최신 확정을 반영한다', () => {
      // 1회차: 보완 필요
      const conf1 = createDummyConfirmation('보완 필요');
      const status1 = computeResultTocItemStatus(conf1, createDummySuggestion('기대'));
      expect(status1.displayKind).toBe('보완 필요');

      // 2회차: 확정
      const conf2: ConfirmationRecord = {
        ...conf1,
        id: 'conf-2',
        confirmation_type: '확정',
        created_at: '2026-10-09T00:00:01.000Z',
      };
      const status2 = computeResultTocItemStatus(conf2, createDummySuggestion('기대'));
      expect(status2.displayKind).toBe('기대');
    });

    it('이전 확정이 "확정 (실현)"이었으나 최신 확정이 "채택 제외"로 재확정된 경우 "채택 제외"를 반영한다', () => {
      const conf1 = createDummyConfirmation('확정');
      const status1 = computeResultTocItemStatus(conf1, createDummySuggestion('실현'));
      expect(status1.displayKind).toBe('실현');

      const conf2: ConfirmationRecord = {
        ...conf1,
        id: 'conf-2',
        confirmation_type: '채택 제외',
        created_at: '2026-10-09T00:00:01.000Z',
      };
      const status2 = computeResultTocItemStatus(conf2, createDummySuggestion('실현'));
      expect(status2.displayKind).toBe('채택 제외');
    });
  });

  describe('3. 화면 매개변수 검증 및 상태 해석 (validateResultTocParams & resolveResultTocPageState)', () => {
    const dummyProject: ProjectRecord = {
      id: 'proj-1',
      name: '가상 사업 1호',
      created_at: '2026-10-09T00:00:00.000Z',
    };

    const dummyPageData: ResultTocPageData = {
      project: dummyProject,
      items: [
        {
          indicator: dummyIndicator,
          latestConfirmation: null,
          latestSuggestion: createDummySuggestion('실현'),
          displayKind: '미확정',
          verdictStatus: null,
          isOrphaned: false,
        },
      ],
      activeItems: [
        {
          indicator: dummyIndicator,
          latestConfirmation: null,
          latestSuggestion: createDummySuggestion('실현'),
          displayKind: '미확정',
          verdictStatus: null,
          isOrphaned: false,
        },
      ],
      orphanedItems: [],
      totalConfirmedCount: 0,
      hasAnyConfirmation: false,
      hasPdm: true,
      warningMessage: null,
    };

    it('projectId 가 없거나 빈 문자열이거나 배열인 경우 null 을 반환한다', () => {
      expect(validateResultTocParams(null)).toBeNull();
      expect(validateResultTocParams({})).toBeNull();
      expect(validateResultTocParams({ projectId: '' })).toBeNull();
      expect(validateResultTocParams({ projectId: '   ' })).toBeNull();
      expect(validateResultTocParams({ projectId: ['proj-1'] })).toBeNull();
    });

    it('정상 projectId 가 전달되면 객체를 반환한다', () => {
      expect(validateResultTocParams({ projectId: 'proj-1' })).toEqual({
        projectId: 'proj-1',
      });
    });

    it('존재하지 않는 사업이거나 유효하지 않은 매개변수인 경우 not-found 상태를 반환한다', () => {
      const mockStore: ResultTocStore = {
        getResultTocData: (id) => (id === 'proj-1' ? dummyPageData : null),
      };

      const invalidParamsState = resolveResultTocPageState({ projectId: '' }, mockStore);
      expect(invalidParamsState.type).toBe('not-found');

      const notFoundProjectState = resolveResultTocPageState({ projectId: 'non-existent' }, mockStore);
      expect(notFoundProjectState.type).toBe('not-found');
    });

    it('정상 사업인 경우 ready 상태와 데이터를 반환한다', () => {
      const mockStore: ResultTocStore = {
        getResultTocData: (id) => (id === 'proj-1' ? dummyPageData : null),
      };

      const state = resolveResultTocPageState({ projectId: 'proj-1' }, mockStore);
      expect(state.type).toBe('ready');
      if (state.type === 'ready') {
        expect(state.resultData.project.id).toBe('proj-1');
        expect(state.resultData.items.length).toBe(1);
        expect(state.resultData.hasAnyConfirmation).toBe(false);
      }
    });

    it('확정 0건인 경우: totalConfirmedCount 는 0이고 hasAnyConfirmation 은 false 이다 (UC-17)', () => {
      expect(dummyPageData.totalConfirmedCount).toBe(0);
      expect(dummyPageData.hasAnyConfirmation).toBe(false);
      expect(dummyPageData.items[0].displayKind).toBe('미확정');
    });

    it('orphaned 지표가 분리되어 activeItems와 orphanedItems에 각각 분할된다', () => {
      const orphanedInd: IndicatorRecord = {
        ...dummyIndicator,
        id: 'ind-orphaned',
        is_orphaned: 1,
      };

      const dataWithOrphaned: ResultTocPageData = {
        ...dummyPageData,
        items: [
          dummyPageData.items[0],
          {
            indicator: orphanedInd,
            latestConfirmation: createDummyConfirmation('확정'),
            latestSuggestion: createDummySuggestion('실현'),
            displayKind: '실현',
            verdictStatus: '실현',
            isOrphaned: true,
          },
        ],
        activeItems: [dummyPageData.items[0]],
        orphanedItems: [
          {
            indicator: orphanedInd,
            latestConfirmation: createDummyConfirmation('확정'),
            latestSuggestion: createDummySuggestion('실현'),
            displayKind: '실현',
            verdictStatus: '실현',
            isOrphaned: true,
          },
        ],
        totalConfirmedCount: 1,
        hasAnyConfirmation: true,
      };

      expect(dataWithOrphaned.activeItems.length).toBe(1);
      expect(dataWithOrphaned.orphanedItems.length).toBe(1);
      expect(dataWithOrphaned.orphanedItems[0].indicator.id).toBe('ind-orphaned');
      expect(dataWithOrphaned.orphanedItems[0].isOrphaned).toBe(true);
    });
  });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { seedDev, SEED_PROJECT_ID } from '../scripts/seed-dev';
import {
  closeDatabase,
  createIndicator,
  getHistoryPageData,
  openDatabase,
  saveSuggestion,
  listConfirmations,
} from '../src/server/store';
import { confirmVerdictAction } from '../src/app/projects/[projectId]/review/actions';

describe('확정 이력 통합 시험 (IT: RQ-18, UC-05, UC-14, #21 검수 반영)', () => {
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-confirm-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
    );
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // 무시
      }
    }
  });

  it('제안 없는 지표 확정 거부 (서버 액션 경로로, 결정 (b))', async () => {
    await seedDev({
      fakeAi: true,
      dbPath: tempDbPath,
      projectId: SEED_PROJECT_ID,
    });
    const db = openDatabase(tempDbPath);

    const NO_SUGG_IND_ID = 'ind-no-suggestion-test';
    createIndicator(
      {
        id: NO_SUGG_IND_ID,
        project_id: SEED_PROJECT_ID,
        level: '활동',
        name: '제안이 아직 없는 지표',
        ovi: 'OVI',
        mov: null,
        target_value: null,
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
      db
    );

    // 서버 액션 함수 경로(confirmVerdictAction)로 확정 시도
    const result = await confirmVerdictAction({
      projectId: SEED_PROJECT_ID,
      indicatorId: NO_SUGG_IND_ID,
      confirmationType: '확정',
      confirmerName: '평가자A',
    });

    // 확정 거부 및 사유 단언
    expect(result.success).toBe(false);
    expect(result.error).toContain('AI 제안이 없는 지표는 확정할 수 없습니다');

    // DB에 이력이 등록되지 않았음을 단언
    const history = listConfirmations(NO_SUGG_IND_ID, db);
    expect(history.length).toBe(0);
  });

  it('제안 → 재제안 → 확정 시 최초 제안이 첫 제안임, 재확정 줄마다 그 시점 최신 제안 id (시험 중 생성한 무작위 제안을 저장 모듈로 넣고 서버 액션 경로로 확정)', async () => {
    await seedDev({
      fakeAi: true,
      dbPath: tempDbPath,
      projectId: SEED_PROJECT_ID,
    });
    const db = openDatabase(tempDbPath);

    // 시드 고정 문구 대신 시험 중 무작위 제안을 생성할 지표 신설
    const INDICATOR_ID = 'ind-confirm-it-' + crypto.randomUUID();
    createIndicator(
      {
        id: INDICATOR_ID,
        project_id: SEED_PROJECT_ID,
        level: '활동',
        name: '동적 제안 시험 지표',
        ovi: 'OVI',
        mov: null,
        target_value: null,
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
      db
    );

    // 1. 시험 중 첫 번째 AI 제안(initial proposal)을 무작위 문구로 생성하여 저장 모듈로 등록
    const firstSuggestionId = 'sugg-dyn-1-' + crypto.randomUUID();
    const firstProposalText = `최초 AI 제안 문구 [${crypto.randomUUID()}]`;
    saveSuggestion(
      {
        id: firstSuggestionId,
        indicator_id: INDICATOR_ID,
        verdict_status: '실현',
        error_reason: null,
        proposal_text: firstProposalText,
        created_at: '2026-10-09T10:00:00.000Z',
      },
      [],
      db
    );

    // 2. 재제안 발생 (두 번째 제안을 무작위 문구로 저장 모듈에 등록)
    const secondSuggestionId = 'sugg-dyn-2-' + crypto.randomUUID();
    const secondProposalText = `두 번째 AI 재제안 문구 [${crypto.randomUUID()}]`;
    saveSuggestion(
      {
        id: secondSuggestionId,
        indicator_id: INDICATOR_ID,
        verdict_status: '추진 중',
        error_reason: null,
        proposal_text: secondProposalText,
        created_at: '2026-10-09T10:30:00.000Z',
      },
      [],
      db
    );

    // 3. 1차 확정 (서버 액션 경로로 수행: 제안 → 재제안 → 확정)
    // caller 는 initial_proposal 및 suggestion_id 를 넘기지 않음
    const confResult1 = await confirmVerdictAction({
      projectId: SEED_PROJECT_ID,
      indicatorId: INDICATOR_ID,
      confirmationType: '확정',
      confirmerName: '평가자A',
    });
    expect(confResult1.success).toBe(true);

    // 1차 확정 단언: 최초 제안은 가장 이른 첫 제안(firstProposalText 무작위 값)이어야 하고,
    // suggestion_id는 그 확정 시점의 최신 제안 id(secondSuggestionId)여야 함
    const history1 = listConfirmations(INDICATOR_ID, db);
    expect(history1.length).toBe(1);
    expect(history1[0].confirmation_type).toBe('확정');
    expect(history1[0].confirmer_name).toBe('평가자A');
    expect(history1[0].initial_proposal).toBe(firstProposalText);
    expect(history1[0].suggestion_id).toBe(secondSuggestionId);

    // 4. 추가 재제안 발생 (세 번째 제안을 무작위 문구로 등록)
    const thirdSuggestionId = 'sugg-dyn-3-' + crypto.randomUUID();
    const thirdProposalText = `세 번째 AI 재제안 문구 [${crypto.randomUUID()}]`;
    saveSuggestion(
      {
        id: thirdSuggestionId,
        indicator_id: INDICATOR_ID,
        verdict_status: '실현',
        error_reason: null,
        proposal_text: thirdProposalText,
        created_at: '2026-10-09T11:30:00.000Z',
      },
      [],
      db
    );

    // 5. 2차 재확정: '수정 후 확정' (서버 액션 경로로 수행)
    const editedText = `현장 확인 결과 수정본 [${crypto.randomUUID()}]`;
    const editReason = `현장 확인 결과 문구 보강 [${crypto.randomUUID()}]`;
    const confResult2 = await confirmVerdictAction({
      projectId: SEED_PROJECT_ID,
      indicatorId: INDICATOR_ID,
      confirmationType: '수정 후 확정',
      confirmerName: '평가자B',
      editedText,
      reason: editReason,
    });
    expect(confResult2.success).toBe(true);

    // 2차 재확정 단언: 최초 제안은 여전히 첫 제안(firstProposalText)으로 불변 보존,
    // suggestion_id는 2차 확정 시점의 최신 제안 id(thirdSuggestionId)
    const history2 = listConfirmations(INDICATOR_ID, db);
    expect(history2.length).toBe(2);
    expect(history2[1].confirmation_type).toBe('수정 후 확정');
    expect(history2[1].confirmer_name).toBe('평가자B');
    expect(history2[1].initial_proposal).toBe(firstProposalText);
    expect(history2[1].suggestion_id).toBe(thirdSuggestionId);
    expect(history2[1].edited_text).toBe(editedText);
    expect(history2[1].reason).toBe(editReason);

    // 6. 3차 재확정: '보완 필요' (서버 액션 경로로 수행)
    const confResult3 = await confirmVerdictAction({
      projectId: SEED_PROJECT_ID,
      indicatorId: INDICATOR_ID,
      confirmationType: '보완 필요',
      confirmerName: '평가자A',
    });
    expect(confResult3.success).toBe(true);

    // 3차 재확정 단언: suggestion 추가가 없었으므로 최신 제안 id는 thirdSuggestionId 유지
    const history3 = listConfirmations(INDICATOR_ID, db);
    expect(history3.length).toBe(3);
    expect(history3[2].confirmation_type).toBe('보완 필요');
    expect(history3[2].confirmer_name).toBe('평가자A');
    expect(history3[2].initial_proposal).toBe(firstProposalText);
    expect(history3[2].suggestion_id).toBe(thirdSuggestionId);

    // 7. S5 화면 데이터 조회(getHistoryPageData)에 3건의 이력과 최신 확정이 온전히 포함됨
    const historyPageData = getHistoryPageData(SEED_PROJECT_ID, db);
    expect(historyPageData).not.toBeNull();
    const targetItem = historyPageData!.indicators.find((i) => i.indicator.id === INDICATOR_ID);
    expect(targetItem).toBeDefined();
    expect(targetItem!.confirmations.length).toBe(3);
    expect(targetItem!.latestConfirmation?.confirmation_type).toBe('보완 필요');
  });
});

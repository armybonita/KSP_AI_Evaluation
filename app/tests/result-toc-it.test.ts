import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  openDatabase,
  closeDatabase,
  createProject,
  createDocument,
  createIndicator,
  saveSuggestion,
  createConfirmation,
  getResultTocData,
  IndicatorRecord,
  SuggestionRecord,
} from '../src/server/store';
import type Database from 'better-sqlite3';

describe('결과 ToC 저장소 연동 통합 시험 (IT) (#23, RQ-23, RQ-26, UC-07, UC-14, UC-17)', () => {
  let dbPath: string;
  let db: Database.Database;
  const projectId = 'proj-result-toc-it';

  beforeEach(() => {
    const tmpDir = process.env.AIEAS_TEST_TMP_DIR || '/tmp';
    dbPath = path.join(tmpDir, `aieas-result-toc-it-${Date.now()}-${crypto.randomUUID().slice(0, 5)}.db`);
    db = openDatabase(dbPath);

    createProject(
      {
        id: projectId,
        name: '결과 ToC IT 테스트 사업',
        created_at: '2026-10-09T00:00:00.000Z',
      },
      db
    );

    // 성과관리표 PDM 등록
    createDocument(
      {
        id: 'doc-pdm-it',
        project_id: projectId,
        file_name: '02_pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null,
        created_at: '2026-10-09T00:00:00.000Z',
      },
      db
    );
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch {
      // 무시
    }
    if (fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath);
      } catch {
        // 무시
      }
    }
  });

  it('실제 성과 경로, 제안 및 확정 이력에서 결과 ToC 데이터가 정확히 산출된다', () => {
    // 1. 5개 지표 생성
    const indicatorsData: Omit<IndicatorRecord, 'project_id' | 'created_at'>[] = [
      {
        id: 'ind-act',
        level: '활동',
        name: '직무 교육 운영',
        ovi: '수료생 수',
        mov: '수료 대장',
        target_value: '500명',
        sort_order: 1,
        is_baseline: 0,
        is_orphaned: 0,
      },
      {
        id: 'ind-out',
        level: '산출물',
        name: '시스템 구축',
        ovi: '인수 여부',
        mov: '검사 확인서',
        target_value: '1식',
        sort_order: 2,
        is_baseline: 0,
        is_orphaned: 0,
      },
      {
        id: 'ind-short',
        level: '단기성과',
        name: '포털 가입자 확대',
        ovi: '가입자 수',
        mov: '통계',
        target_value: '100만명',
        sort_order: 3,
        is_baseline: 0,
        is_orphaned: 0,
      },
      {
        id: 'ind-mid',
        level: '중기성과',
        name: '행정 처리 시간 단축',
        ovi: '단축률',
        mov: '로그 분석',
        target_value: '30%',
        sort_order: 4,
        is_baseline: 0,
        is_orphaned: 0,
      },
      {
        id: 'ind-imp',
        level: '영향',
        name: '대국민 편의 증진',
        ovi: '만족도',
        mov: '설문조사',
        target_value: '5점 척도 3.5점',
        sort_order: 5,
        is_baseline: 0,
        is_orphaned: 0,
      },
    ];

    for (const ind of indicatorsData) {
      createIndicator(
        {
          ...ind,
          project_id: projectId,
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );
    }

    // 2. 각 지표에 AI 제안 생성
    const suggestions: SuggestionRecord[] = [
      {
        id: 'sugg-act',
        indicator_id: 'ind-act',
        verdict_status: '실현',
        error_reason: null,
        proposal_text: '직무 교육 500명 달성',
        created_at: '2026-10-09T00:00:00.000Z',
      },
      {
        id: 'sugg-out',
        indicator_id: 'ind-out',
        verdict_status: '추진 중',
        error_reason: null,
        proposal_text: '시스템 구축 진행 중',
        created_at: '2026-10-09T00:00:00.000Z',
      },
      {
        id: 'sugg-short',
        indicator_id: 'ind-short',
        verdict_status: '기대',
        error_reason: null,
        proposal_text: '포털 가입자 확대 전망',
        created_at: '2026-10-09T00:00:00.000Z',
      },
      {
        id: 'sugg-mid',
        indicator_id: 'ind-mid',
        verdict_status: '근거 충돌',
        error_reason: null,
        proposal_text: '처리 시간 단축 수치 불일치',
        created_at: '2026-10-09T00:00:00.000Z',
      },
      {
        id: 'sugg-imp',
        indicator_id: 'ind-imp',
        verdict_status: '미확인',
        error_reason: null,
        proposal_text: '만족도 조사 결과 부재',
        created_at: '2026-10-09T00:00:00.000Z',
      },
    ];

    for (const sugg of suggestions) {
      saveSuggestion(sugg, [], db);
    }

    // 3. 지표별 확정 수행:
    // ind-act: 확정 (실현)
    createConfirmation(
      {
        indicator_id: 'ind-act',
        confirmation_type: '확정',
        confirmer_name: '평가자A',
      },
      db
    );

    // ind-out: 수정 후 확정 (추진 중)
    createConfirmation(
      {
        indicator_id: 'ind-out',
        confirmation_type: '수정 후 확정',
        edited_text: '시스템 구축 1식 검사 진행 중으로 확인됨',
        reason: '검사 확인서 보완 반영',
        confirmer_name: '평가자A',
      },
      db
    );

    // ind-short: 보완 필요
    createConfirmation(
      {
        indicator_id: 'ind-short',
        confirmation_type: '보완 필요',
        confirmer_name: '평가자A',
      },
      db
    );

    // ind-mid: 채택 제외
    createConfirmation(
      {
        indicator_id: 'ind-mid',
        confirmation_type: '채택 제외',
        confirmer_name: '평가자A',
      },
      db
    );

    // ind-imp: 확정하지 않음 (미확정)

    // 4. getResultTocData 호출 및 검증
    const resultData = getResultTocData(projectId, db);
    expect(resultData).not.toBeNull();
    if (!resultData) return;

    expect(resultData.project.id).toBe(projectId);
    expect(resultData.items.length).toBe(5);
    expect(resultData.activeItems.length).toBe(5);
    expect(resultData.orphanedItems.length).toBe(0);
    expect(resultData.totalConfirmedCount).toBe(4);
    expect(resultData.hasAnyConfirmation).toBe(true);

    const itemAct = resultData.items.find((i) => i.indicator.id === 'ind-act');
    expect(itemAct?.displayKind).toBe('실현');
    expect(itemAct?.verdictStatus).toBe('실현');

    const itemOut = resultData.items.find((i) => i.indicator.id === 'ind-out');
    expect(itemOut?.displayKind).toBe('추진 중');
    expect(itemOut?.verdictStatus).toBe('추진 중');

    const itemShort = resultData.items.find((i) => i.indicator.id === 'ind-short');
    expect(itemShort?.displayKind).toBe('보완 필요');
    expect(itemShort?.verdictStatus).toBeNull();

    const itemMid = resultData.items.find((i) => i.indicator.id === 'ind-mid');
    expect(itemMid?.displayKind).toBe('채택 제외');
    expect(itemMid?.verdictStatus).toBeNull();

    const itemImp = resultData.items.find((i) => i.indicator.id === 'ind-imp');
    expect(itemImp?.displayKind).toBe('미확정');
    expect(itemImp?.verdictStatus).toBeNull();

    // 5. 재확정 검증 (UC-14): ind-short (보완 필요) -> 확정(기대)로 재확정
    createConfirmation(
      {
        indicator_id: 'ind-short',
        confirmation_type: '확정',
        confirmer_name: '평가자B',
      },
      db
    );

    const reconfirmedData = getResultTocData(projectId, db);
    expect(reconfirmedData).not.toBeNull();
    const updatedShort = reconfirmedData?.items.find((i) => i.indicator.id === 'ind-short');
    expect(updatedShort?.displayKind).toBe('기대');
    expect(updatedShort?.verdictStatus).toBe('기대');
    expect(updatedShort?.latestConfirmation?.confirmation_type).toBe('확정');
    expect(updatedShort?.latestConfirmation?.confirmer_name).toBe('평가자B');

    // 6. orphaned 지표 분리 검증
    db.prepare(`UPDATE indicators SET is_orphaned = 1 WHERE id = 'ind-imp'`).run();
    const dataWithOrphaned = getResultTocData(projectId, db);
    expect(dataWithOrphaned?.activeItems.length).toBe(4);
    expect(dataWithOrphaned?.orphanedItems.length).toBe(1);
    expect(dataWithOrphaned?.orphanedItems[0].indicator.id).toBe('ind-imp');
  });

  it('확정이 하나도 없는 경우: 모든 항목이 "미확정"이고 hasAnyConfirmation이 false이다 (UC-17)', () => {
    // 지표 1개 등록
    createIndicator(
      {
        id: 'ind-single',
        project_id: projectId,
        level: '산출물',
        name: '단일 산출물 지표',
        ovi: '산출물 확인',
        mov: '증빙',
        target_value: '1건',
        sort_order: 1,
        is_baseline: 0,
        is_orphaned: 0,
        created_at: '2026-10-09T00:00:00.000Z',
      },
      db
    );

    saveSuggestion(
      {
        id: 'sugg-single',
        indicator_id: 'ind-single',
        verdict_status: '실현',
        error_reason: null,
        proposal_text: '산출물 1건 완료',
        created_at: '2026-10-09T00:00:00.000Z',
      },
      [],
      db
    );

    const resultData = getResultTocData(projectId, db);
    expect(resultData).not.toBeNull();
    expect(resultData?.totalConfirmedCount).toBe(0);
    expect(resultData?.hasAnyConfirmation).toBe(false);
    expect(resultData?.items.length).toBe(1);
    expect(resultData?.items[0].displayKind).toBe('미확정');
  });
});

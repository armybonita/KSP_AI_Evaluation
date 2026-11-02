import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ReviewClientView, getVerdictBadgeClass } from '../src/app/projects/[projectId]/review/review-client-view';
import { seedDev, SEED_PROJECT_ID } from '../scripts/seed-dev';
import { closeDatabase, getReviewData, openDatabase } from '../src/server/store';
import { resuggestIndicatorAction } from '../src/app/projects/[projectId]/review/actions';
import {
  validateReviewParams,
  resolveReviewPageState,
} from '../src/app/projects/[projectId]/review/review-page-state';
import ReviewPage from '../src/app/projects/[projectId]/review/page';

describe('S4 AI 제안 검토 화면 데이터 및 배지 검증 단위 시험 (D28, D30, RQ-06, RQ-10, RQ-27)', () => {
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-review-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
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

  it('getVerdictBadgeClass 는 D28 권장 색상과 상태 글자를 항상 함께 반환한다', () => {
    const statuses = [
      { status: '실현', expectedColor: 'emerald', label: '실현' },
      { status: '추진 중', expectedColor: 'blue', label: '추진 중' },
      { status: '기대', expectedColor: 'amber', label: '기대' },
      { status: '미확인', expectedColor: 'slate', label: '미확인' },
      { status: '근거 충돌', expectedColor: 'orange', label: '근거 충돌' },
    ];

    for (const { status, expectedColor, label } of statuses) {
      const badge = getVerdictBadgeClass(status);
      expect(badge.label).toBe(label);
      expect(badge.container).toContain(expectedColor);
      expect(badge.dot).toContain(expectedColor);
    }

    // 제안 없는 경우 기본 스타일
    const emptyBadge = getVerdictBadgeClass(null);
    expect(emptyBadge.label).toBe('제안 없음');
  });

  it('--fake-ai 시드 데이터베이스로부터 S4 화면 요구사항 (a)~(d) 가 온전히 구성된다', async () => {
    await seedDev({
      fakeAi: true,
      dbPath: tempDbPath,
      projectId: SEED_PROJECT_ID,
    });

    const db = openDatabase(tempDbPath);
    const reviewData = getReviewData(SEED_PROJECT_ID, db);
    expect(reviewData).not.toBeNull();

    // ------------------------------------------------------------------------
    // (d) 배지 글자가 다섯 상태 이름 중 하나이며 다섯 상태 모두 존재
    // ------------------------------------------------------------------------
    const statuses = reviewData!.indicators.map((i) => i.suggestion?.verdict_status);
    const validStatuses = ['실현', '추진 중', '기대', '미확인', '근거 충돌'];
    for (const s of statuses) {
      expect(validStatuses).toContain(s);
    }
    for (const expected of validStatuses) {
      expect(statuses).toContain(expected);
    }

    // ------------------------------------------------------------------------
    // (a) 근거 있는 지표: 근거 네 항목과 [원문 위치 열기] 문맥
    // ------------------------------------------------------------------------
    const supported = reviewData!.indicators.find((i) => i.indicator.id === 'ind-activity');
    expect(supported).toBeDefined();
    expect(supported!.suggestion?.verdict_status).toBe('실현');
    expect(supported!.suggestion?.evidences.length).toBe(1);

    const ev = supported!.suggestion!.evidences[0];
    // 근거 네 항목 (RQ-10)
    expect(ev.quote).toBe(
      '교육 훈련 실적: 핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.'
    );
    expect(ev.document_name).toBe('03_trip_report.pdf');
    expect(ev.location).toBe('2쪽 ¶2');
    expect(ev.speaker).toBe('수행기관');

    // [원문 위치 열기] 문맥
    expect(ev.paragraph_context).toBeDefined();
    expect(ev.paragraph_context!.target.content).toContain(ev.quote);
    expect(ev.paragraph_context!.surroundings.length).toBeGreaterThanOrEqual(1);

    // ------------------------------------------------------------------------
    // (b) "근거 없는 판단" 지표는 "미확인"과 사유
    // ------------------------------------------------------------------------
    const unsupported = reviewData!.indicators.find((i) => i.indicator.id === 'ind-unsupported');
    expect(unsupported).toBeDefined();
    expect(unsupported!.suggestion?.verdict_status).toBe('미확인');
    expect(unsupported!.suggestion?.evidences.length).toBe(0);

    // ------------------------------------------------------------------------
    // (c) 스키마 위반 고정 응답 지표는 "미확인"+오류 사유
    // ------------------------------------------------------------------------
    const schemaViolation = reviewData!.indicators.find(
      (i) => i.indicator.id === 'ind-schema-violation'
    );
    expect(schemaViolation).toBeDefined();
    expect(schemaViolation!.suggestion?.verdict_status).toBe('미확인');
    expect(schemaViolation!.suggestion?.error_reason).toBeTruthy();
    expect(schemaViolation!.suggestion?.error_reason).toContain('AI 응답 스키마 검증 실패');
    expect(schemaViolation!.suggestion?.error_reason).not.toContain('invalid_enum_value');

    // ------------------------------------------------------------------------
    // '미확인'인데 근거가 있는 경우 (ind-midterm)
    // ------------------------------------------------------------------------
    const midterm = reviewData!.indicators.find((i) => i.indicator.id === 'ind-midterm');
    expect(midterm).toBeDefined();
    expect(midterm!.suggestion?.verdict_status).toBe('미확인');
    expect(midterm!.suggestion?.evidences.length).toBe(1);

    // ------------------------------------------------------------------------
    // 읽지 못한 파일 알림 (07_empty.pdf) (RQ-06)
    // ------------------------------------------------------------------------
    expect(reviewData!.unreadableDocuments.length).toBe(1);
    expect(reviewData!.unreadableDocuments[0].file_name).toBe('07_empty.pdf');
    expect(reviewData!.unreadableDocuments[0].status).toBe('읽지 못함');
  });

  it('S4 화면의 각 근거 카드에 id="evidence-<근거 id>" 속성이 존재한다 (#22 검수 반영 1차, Item 2)', async () => {
    await seedDev({
      fakeAi: true,
      dbPath: tempDbPath,
      projectId: SEED_PROJECT_ID,
    });
    const reviewData = getReviewData(SEED_PROJECT_ID, openDatabase(tempDbPath));
    expect(reviewData).toBeDefined();

    const activityItem = reviewData!.indicators.find((i) => i.indicator.id === 'ind-activity')!;
    const ev = activityItem.suggestion!.evidences[0];
    expect(ev.id).toBeDefined();

    const clientViewSource = fs.readFileSync(
      path.resolve(__dirname, '../src/app/projects/[projectId]/review/review-client-view.tsx'),
      'utf8'
    );
    expect(clientViewSource).toContain('id={`evidence-${ev.id}`}');
  });

  it('D30: resuggestIndicatorAction 은 특정 지표의 제안을 다시 실행하여 갱신한다', async () => {
    await seedDev({
      fakeAi: true,
      dbPath: tempDbPath,
      projectId: SEED_PROJECT_ID,
    });

    process.env.AIEAS_DB_PATH = tempDbPath;

    // 1. AI 모듈에 주입 가능한 fake client 설정
    const { AiClient, setAiClient } = await import('../src/server/ai');
    const fakeClient = new AiClient({
      baseUrl: 'https://example.com/v1',
      // public-safety-allow: dummy key for unit test
      apiKey: 'dummy',
      model: 'aieas-default',
      reasoningEffort: 'xhigh',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict_status: '실현',
                    sentence:
                      '교육 훈련 실적에서 핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.',
                    evidences: [
                      {
                        quote:
                          '교육 훈련 실적: 핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.',
                        document_id: 'doc-03_trip_report.pdf',
                        location: '2쪽 ¶2',
                        speaker: '수행기관',
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });

    Object.defineProperty(fakeClient, 'provider', { value: 'solar' });
    setAiClient(fakeClient);

    try {
      const res = await resuggestIndicatorAction(SEED_PROJECT_ID, 'ind-activity');
      expect(res.success).toBe(true);
      expect(res.data).toBeDefined();

      const indItem = res.data!.indicators.find((i) => i.indicator.id === 'ind-activity');
      expect(indItem).toBeDefined();
      expect(indItem!.suggestion?.verdict_status).toBe('실현');
    } finally {
      setAiClient(null);
    }

    // 2. AI 호출 실패 시에는 성공으로 표시하지 않고 "미확인"과 오류 사유를 돌려준다 (D30)
    const failingClient = new AiClient({
      baseUrl: 'https://example.com/v1',
      // public-safety-allow: dummy key for unit test
      apiKey: 'dummy',
      model: 'aieas-default',
      reasoningEffort: 'xhigh',
      fetchFn: async () => {
        throw new Error('AI 게이트웨이 타임아웃 오류');
      },
    });
    Object.defineProperty(failingClient, 'provider', { value: 'solar' });
    setAiClient(failingClient);

    try {
      const failRes = await resuggestIndicatorAction(SEED_PROJECT_ID, 'ind-activity');
      expect(failRes.success).toBe(false);
      expect(failRes.data).toBeDefined();
      expect(failRes.error).toContain('AI 게이트웨이 타임아웃 오류');

      const indItem = failRes.data!.indicators.find((i) => i.indicator.id === 'ind-activity');
      expect(indItem).toBeDefined();
      expect(indItem!.suggestion?.verdict_status).toBe('미확인');
      expect(indItem!.suggestion?.error_reason).toContain('AI 게이트웨이 타임아웃 오류');
    } finally {
      setAiClient(null);
    }
  });

  it('사업 경계 확인: 다른 사업의 지표 id 로 액션 호출 시 거부한다 (데이터를 돌려주지 않음)', async () => {
    await seedDev({
      fakeAi: true,
      dbPath: tempDbPath,
      projectId: SEED_PROJECT_ID,
    });

    process.env.AIEAS_DB_PATH = tempDbPath;
    const db = openDatabase(tempDbPath);

    // 다른 사업 및 해당 사업의 지표 생성
    const OTHER_PROJECT_ID = 'proj-other-domain';
    const { createProject, createIndicator, isIndicatorInProject } = await import(
      '../src/server/store'
    );
    createProject(
      {
        id: OTHER_PROJECT_ID,
        name: '타 사업',
        created_at: new Date().toISOString(),
      },
      db
    );
    createIndicator(
      {
        id: 'ind-other-999',
        project_id: OTHER_PROJECT_ID,
        level: '활동',
        name: '타 사업 활동 지표',
        ovi: '타 사업 지표',
        mov: '보고서',
        target_value: '100',
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
      db
    );

    const { createDocument } = await import('../src/server/store');
    createDocument({ id: 'other-pdm', project_id: OTHER_PROJECT_ID, file_name: 'pdm.pdf', file_type: 'pdf', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: new Date().toISOString() }, db);

    // 1. isIndicatorInProject 함수 검증
    expect(isIndicatorInProject('ind-activity', SEED_PROJECT_ID, db)).toBe(true);
    expect(isIndicatorInProject('ind-other-999', OTHER_PROJECT_ID, db)).toBe(true);
    expect(isIndicatorInProject('ind-other-999', SEED_PROJECT_ID, db)).toBe(false);
    expect(isIndicatorInProject('ind-activity', OTHER_PROJECT_ID, db)).toBe(false);

    // 2. 서버 액션 호출 시: 다른 사업의 지표 ID를 전달하면 거부되고 데이터를 돌려주지 않음
    const crossRes1 = await resuggestIndicatorAction(SEED_PROJECT_ID, 'ind-other-999');
    expect(crossRes1.success).toBe(false);
    expect(crossRes1.data).toBeUndefined();
    expect(crossRes1.error).toContain('해당 사업에 속한 지표가 아닙니다');

    const crossRes2 = await resuggestIndicatorAction(OTHER_PROJECT_ID, 'ind-activity');
    expect(crossRes2.success).toBe(false);
    expect(crossRes2.data).toBeUndefined();
    expect(crossRes2.error).toContain('해당 사업에 속한 지표가 아닙니다');
  });
});

describe('ReviewPage 및 searchParams indicatorId 쿼리 형식 검증 단위 시험 (#17)', () => {
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-review-page-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
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

  describe('validateReviewParams 순수 함수 검증', () => {
    it('searchParams.indicatorId 가 배열이면 null 을 반환한다', () => {
      const res = validateReviewParams(
        { projectId: 'proj-1' },
        { indicatorId: ['ind-1', 'ind-2'] as any }
      );
      expect(res).toBeNull();
    });

    it('searchParams.indicatorId 가 단일 요소 배열이어도 문자열이 아니므로 null 을 반환한다', () => {
      const res = validateReviewParams(
        { projectId: 'proj-1' },
        { indicatorId: ['ind-1'] as any }
      );
      expect(res).toBeNull();
    });

    it('searchParams.indicatorId 가 객체나 숫자 등 비문자열이면 null 을 반환한다', () => {
      expect(
        validateReviewParams({ projectId: 'proj-1' }, { indicatorId: 123 as any })
      ).toBeNull();
      expect(
        validateReviewParams({ projectId: 'proj-1' }, { indicatorId: { id: 'ind-1' } as any })
      ).toBeNull();
    });

    it('params.projectId 가 배열이면 null 을 반환한다', () => {
      const res = validateReviewParams(
        { projectId: ['proj-1', 'proj-2'] as any },
        { indicatorId: 'ind-1' }
      );
      expect(res).toBeNull();
    });

    it('params.projectId 가 문자열이 아니거나 빈 문자열이면 null 을 반환한다', () => {
      expect(validateReviewParams({ projectId: undefined }, {})).toBeNull();
      expect(validateReviewParams({ projectId: '' }, {})).toBeNull();
      expect(validateReviewParams({ projectId: '   ' }, {})).toBeNull();
      expect(validateReviewParams(null, {})).toBeNull();
    });

    it('올바른 문자열 입력 시 검증된 매개변수 객체를 반환한다', () => {
      const withInd = validateReviewParams(
        { projectId: 'proj-1' },
        { indicatorId: 'ind-1' }
      );
      expect(withInd).toEqual({ projectId: 'proj-1', indicatorId: 'ind-1' });

      const withoutInd = validateReviewParams(
        { projectId: 'proj-1' },
        {}
      );
      expect(withoutInd).toEqual({ projectId: 'proj-1', indicatorId: undefined });

      const noSearchParams = validateReviewParams(
        { projectId: 'proj-1' },
        undefined
      );
      expect(noSearchParams).toEqual({ projectId: 'proj-1', indicatorId: undefined });
    });
  });

  describe('resolveReviewPageState 순수 함수 검증', () => {
    it('indicatorId 가 배열로 입력되면 예외 없이 not-found 상태를 반환한다', () => {
      const mockStore = {
        isIndicatorInProject: () => {
          throw new Error('스토어 함수가 호출되면 안 됨');
        },
        getReviewData: () => {
          throw new Error('스토어 함수가 호출되면 안 됨');
        },
      };

      const state = resolveReviewPageState(
        { projectId: 'proj-1' },
        { indicatorId: ['ind-1', 'ind-2'] as any },
        mockStore
      );
      expect(state).toEqual({ type: 'not-found' });
    });

    it('projectId 가 배열로 입력되면 예외 없이 not-found 상태를 반환한다', () => {
      const mockStore = {
        isIndicatorInProject: () => {
          throw new Error('스토어 함수가 호출되면 안 됨');
        },
        getReviewData: () => {
          throw new Error('스토어 함수가 호출되면 안 됨');
        },
      };

      const state = resolveReviewPageState(
        { projectId: ['proj-1', 'proj-2'] as any },
        { indicatorId: 'ind-1' },
        mockStore
      );
      expect(state).toEqual({ type: 'not-found' });
    });

    it('존재하지 않는 지표 id 가 주어지면 not-found 상태를 반환한다', () => {
      const mockStore = {
        isIndicatorInProject: () => false,
        getReviewData: () => null,
      };

      const state = resolveReviewPageState(
        { projectId: 'proj-1' },
        { indicatorId: 'ind-non-existent' },
        mockStore
      );
      expect(state).toEqual({ type: 'not-found' });
    });

    it('유효한 입력과 데이터가 존재하면 ready 상태와 데이터를 반환한다', () => {
      const mockData: any = {
        project: { id: 'proj-1', name: '사업' },
        indicators: [],
        unreadableDocuments: [],
      };
      const mockStore = {
        isIndicatorInProject: () => true,
        getReviewData: () => mockData,
      };

      const state = resolveReviewPageState(
        { projectId: 'proj-1' },
        { indicatorId: 'ind-1' },
        mockStore
      );
      expect(state).toEqual({
        type: 'ready',
        reviewData: mockData,
        selectedIndicatorId: 'ind-1',
      });
    });
  });

  describe('ReviewPage 비동기 컴포넌트 404 경로 단언', () => {
    it('searchParams.indicatorId 가 배열로 전달되면 예외(RangeError 등) 없이 notFound() 경로를 탄다', async () => {
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      process.env.AIEAS_DB_PATH = tempDbPath;
      openDatabase(tempDbPath);

      // 배열 입력 시 better-sqlite3 의 RangeError 가 발생하지 않고 Next.js notFound(404)를 호출해야 함
      let caughtError: any = null;
      try {
        await ReviewPage({
          params: Promise.resolve({ projectId: SEED_PROJECT_ID }),
          searchParams: Promise.resolve({ indicatorId: ['ind-activity', 'ind-unsupported'] as any }),
        });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      // Next.js notFound()의 digest 규격: NEXT_HTTP_ERROR_FALLBACK;404
      expect(caughtError.digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    });

    it('params.projectId 가 배열로 전달되면 예외 없이 notFound() 경로를 탄다', async () => {
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      process.env.AIEAS_DB_PATH = tempDbPath;
      openDatabase(tempDbPath);

      let caughtError: any = null;
      try {
        await ReviewPage({
          params: Promise.resolve({ projectId: [SEED_PROJECT_ID, 'other'] as any }),
          searchParams: Promise.resolve({ indicatorId: 'ind-activity' }),
        });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError.digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    });

    it('정상적인 단일 문자열 indicatorId 전달 시 페이지 컴포넌트가 정상 반환된다', async () => {
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      process.env.AIEAS_DB_PATH = tempDbPath;
      openDatabase(tempDbPath);

      const pageElement = await ReviewPage({
        params: Promise.resolve({ projectId: SEED_PROJECT_ID }),
        searchParams: Promise.resolve({ indicatorId: 'ind-activity' }),
      });

      expect(pageElement).toBeDefined();
      expect(pageElement.props.initialSelectedIndicatorId).toBe('ind-activity');
    });

    it('문서에서 사라진 지표(is_orphaned=1)가 있을 때 S4 컴포넌트에 정상 전달된다 (#19)', async () => {
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      process.env.AIEAS_DB_PATH = tempDbPath;
      const db = openDatabase(tempDbPath);

      db.prepare('UPDATE indicators SET is_orphaned = 1 WHERE id = ?').run('ind-activity');

      const pageElement = await ReviewPage({
        params: Promise.resolve({ projectId: SEED_PROJECT_ID }),
        searchParams: Promise.resolve({ indicatorId: 'ind-activity' }),
      });

      expect(pageElement).toBeDefined();
      const orphanedInd = pageElement.props.initialData.indicators.find(
        (i: any) => i.indicator.id === 'ind-activity'
      );
      expect(orphanedInd).toBeDefined();
      expect(orphanedInd.indicator.is_orphaned).toBe(1);
    });
  });
});



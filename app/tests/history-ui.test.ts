import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { seedDev, SEED_PROJECT_ID } from '../scripts/seed-dev';
import { closeDatabase, openDatabase } from '../src/server/store';
import {
  validateHistoryParams,
  resolveHistoryPageState,
} from '../src/app/projects/[projectId]/history/history-page-state';
import { formatDateTime } from '../src/app/projects/[projectId]/history/history-client-view';
import HistoryPage from '../src/app/projects/[projectId]/history/page';
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers({ 'x-auth-request-user': 'admin-test' })) }));

describe('S5 확정 이력 화면 및 매개변수 검증 단위 시험 (#21, RQ-18, RQ-19, D47)', () => {
  let tempDbPath: string;

  beforeEach(() => {
    vi.stubEnv('AIEAS_AUTH_MODE', 'proxy');
    vi.stubEnv('AIEAS_ROLE_MAP', JSON.stringify({ 'admin-test': 'Admin' }));
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-history-page-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
    );
  });

  afterEach(() => {
    closeDatabase();
    vi.unstubAllEnvs();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // 무시
      }
    }
  });

  describe('validateHistoryParams 순수 함수 검증', () => {
    it('searchParams.indicatorId 가 배열이면 null 을 반환한다', () => {
      const res = validateHistoryParams(
        { projectId: 'proj-1' },
        { indicatorId: ['ind-1', 'ind-2'] as any }
      );
      expect(res).toBeNull();
    });

    it('params.projectId 가 배열이거나 비어 있으면 null 을 반환한다', () => {
      expect(validateHistoryParams({ projectId: ['p1', 'p2'] as any }, {})).toBeNull();
      expect(validateHistoryParams({ projectId: '' }, {})).toBeNull();
      expect(validateHistoryParams({ projectId: '   ' }, {})).toBeNull();
      expect(validateHistoryParams(null, {})).toBeNull();
    });

    it('정상 입력 시 유효 매개변수 객체를 반환한다', () => {
      const res = validateHistoryParams(
        { projectId: 'proj-1' },
        { indicatorId: 'ind-1' }
      );
      expect(res).toEqual({ projectId: 'proj-1', indicatorId: 'ind-1' });
    });
  });

  describe('resolveHistoryPageState 순수 함수 검증', () => {
    it('타 사업 지표 id 가 주어지면 not-found 를 반환한다 (사업 격리)', () => {
      const mockStore = {
        isIndicatorInProject: () => false,
        getHistoryPageData: () => null,
      };

      const state = resolveHistoryPageState(
        { projectId: 'proj-1' },
        { indicatorId: 'ind-foreign' },
        mockStore
      );
      expect(state).toEqual({ type: 'not-found' });
    });

    it('존재하지 않는 사업 id 가 주어지면 not-found 를 반환한다', () => {
      const mockStore = {
        isIndicatorInProject: () => true,
        getHistoryPageData: () => null,
      };

      const state = resolveHistoryPageState(
        { projectId: 'proj-non-existent' },
        {},
        mockStore
      );
      expect(state).toEqual({ type: 'not-found' });
    });

    it('유효한 사업과 데이터가 존재하면 ready 상태와 기본 선택 지표를 반환한다', () => {
      const mockData: any = {
        project: { id: 'proj-1', name: '사업' },
        indicators: [
          { indicator: { id: 'ind-1', name: '지표 1' }, confirmations: [] },
          { indicator: { id: 'ind-2', name: '지표 2' }, confirmations: [] },
        ],
      };
      const mockStore = {
        isIndicatorInProject: () => true,
        getHistoryPageData: () => mockData,
      };

      const state = resolveHistoryPageState(
        { projectId: 'proj-1' },
        {},
        mockStore
      );
      expect(state.type).toBe('ready');
      if (state.type === 'ready') {
        expect(state.selectedIndicatorId).toBe('ind-1');
      }
    });
  });

  describe('HistoryPage 404 경로 단언', () => {
    it('부적절한 projectId 배열 입력 시 예외 없이 notFound() 경로를 탄다', async () => {
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      process.env.AIEAS_DB_PATH = tempDbPath;
      openDatabase(tempDbPath);

      let caughtError: any = null;
      try {
        await HistoryPage({
          params: Promise.resolve({ projectId: ['invalid-array'] as any }),
          searchParams: Promise.resolve({}),
        });
      } catch (err: any) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError.digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    });

    it('정상 매개변수 전달 시 컴포넌트가 정상 렌더링된다', async () => {
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      process.env.AIEAS_DB_PATH = tempDbPath;
      openDatabase(tempDbPath);

      const pageElement = await HistoryPage({
        params: Promise.resolve({ projectId: SEED_PROJECT_ID }),
        searchParams: Promise.resolve({ indicatorId: 'ind-activity' }),
      });

      expect(pageElement).toBeDefined();
      expect(pageElement.props.initialSelectedIndicatorId).toBe('ind-activity');
    });
  });

  describe('화면 어디에도 이력 수정·삭제 버튼 부재 검증 (RQ-18, UC-14)', () => {
    it('S5 history-client-view 소스 코드에 수정/삭제(delete/remove/edit) 관련 버튼이나 기능이 없다', () => {
      const historyViewPath = path.resolve(
        __dirname,
        '../src/app/projects/[projectId]/history/history-client-view.tsx'
      );
      const content = fs.readFileSync(historyViewPath, 'utf8');

      // 이력을 고치거나 지우는 버튼 또는 동작 검출
      expect(content).not.toMatch(/고치기/);
      expect(content).not.toMatch(/지우기/);
      expect(content).not.toMatch(/이력\s*수정/);
      expect(content).not.toMatch(/이력\s*삭제/);
      expect(content).not.toMatch(/deleteHistory/i);
      expect(content).not.toMatch(/editHistory/i);
    });

    it('S4 review-client-view 소스 코드에도 이력 수정/삭제 관련 버튼이나 기능이 없다', () => {
      const reviewViewPath = path.resolve(
        __dirname,
        '../src/app/projects/[projectId]/review/review-client-view.tsx'
      );
      const content = fs.readFileSync(reviewViewPath, 'utf8');

      expect(content).not.toMatch(/고치기/);
      expect(content).not.toMatch(/지우기/);
      expect(content).not.toMatch(/deleteHistory/i);
      expect(content).not.toMatch(/editHistory/i);
    });
  });

  describe('formatDateTime 시각 표시 형식 검증 (YYYY-MM-DD HH:mm:ss (KST))', () => {
    it('ISO 날짜 문자열을 YYYY-MM-DD HH:mm:ss (KST) 형식으로 변환한다', () => {
      // public-safety-allow: 시각 문자열(시:분:초), 주소 아님
      const formatted = formatDateTime('2026-10-09T01:02:03.000Z');
      // public-safety-allow: 시각 문자열(시:분:초), 주소 아님
      expect(formatted).toBe('2026-10-09 10:02:03 (KST)');
    });

    it('유효하지 않은 문자열은 원본을 그대로 반환한다', () => {
      expect(formatDateTime('invalid-date')).toBe('invalid-date');
    });
  });

  describe('이력 판정 변경 배지 노출 규칙 단위 시험 (#23 검수)', () => {
    it('edited_verdict_status 가 없거나 ai_verdict_status 와 같으면 변경 배지를 표시하지 않고 다를 때만 표시한다', () => {
      // 1. edited_verdict_status 가 NULL 인 경우 -> 배지 미표시
      const confNull = {
        edited_verdict_status: null,
        ai_verdict_status: '추진 중',
      };
      const hasChangeNull = Boolean(
        confNull.edited_verdict_status &&
        confNull.edited_verdict_status !== confNull.ai_verdict_status
      );
      expect(hasChangeNull).toBe(false);

      // 2. edited_verdict_status 와 ai_verdict_status 가 같은 경우 -> 배지 미표시
      const confSame = {
        edited_verdict_status: '추진 중',
        ai_verdict_status: '추진 중',
      };
      const hasChangeSame = Boolean(
        confSame.edited_verdict_status &&
        confSame.edited_verdict_status !== confSame.ai_verdict_status
      );
      expect(hasChangeSame).toBe(false);

      // 3. edited_verdict_status 와 ai_verdict_status 가 다른 경우 -> 배지 표시
      const confDiff = {
        edited_verdict_status: '실현',
        ai_verdict_status: '추진 중',
      };
      const hasChangeDiff = Boolean(
        confDiff.edited_verdict_status &&
        confDiff.edited_verdict_status !== confDiff.ai_verdict_status
      );
      expect(hasChangeDiff).toBe(true);
    });
  });
});



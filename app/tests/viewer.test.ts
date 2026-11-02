import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { headers } from 'next/headers';
import {
  backupDatabase,
  closeDatabase,
  createConfirmation,
  createProject,
  getLatestSuggestion,
  getDatabase,
  getReviewData,
  listIndicators,
  openDatabase,
  openReadonlyDatabase,
  replaceIndicatorSuggestions,
  saveSuggestion,
} from '../src/server/store';
import { setAiClient } from '../src/server/ai';

(globalThis as unknown as { React: typeof React }).React = React;
import {
  generateReportDownloadAction,
  generateReportDraftAction,
} from '../src/app/projects/[projectId]/report/actions';
import { GET as downloadReport } from '../src/app/projects/[projectId]/report/download/route';
import { resuggestIndicatorAction } from '../src/app/projects/[projectId]/review/actions';
import { ReviewClientView } from '../src/app/projects/[projectId]/review/review-client-view';
import ReviewPage from '../src/app/projects/[projectId]/review/page';
import { ReportClientView } from '../src/app/projects/[projectId]/report/report-client-view';
import ReportPage from '../src/app/projects/[projectId]/report/page';
import {
  buildSeedIndicatorSuggestion,
  SEED_PROJECT_ID,
  seedDev,
} from '../scripts/seed-dev';
import {
  viewerFromHeaders,
} from '../src/server/viewer';
import * as reportService from '../src/server/report';

vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/projects/proj-dev-seed/review',
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

const originalAuthMode = process.env.AIEAS_AUTH_MODE;

function getTestTempDir(): string {
  return os.tmpdir();
}

describe('뷰어 판별과 손님 AI 호출 제한', () => {
  beforeEach(() => {
    process.env.AIEAS_AUTH_MODE = 'proxy';
    vi.mocked(headers).mockImplementation(async () => new Headers() as never);
  });

  afterEach(() => {
    closeDatabase();
    setAiClient(null);
    vi.restoreAllMocks();
    if (originalAuthMode === undefined) {
      delete process.env.AIEAS_AUTH_MODE;
    } else {
      process.env.AIEAS_AUTH_MODE = originalAuthMode;
    }
  });

  it('proxy 모드에서 로그인 헤더를 trim 하여 member 로 판별한다', () => {
    expect(
      viewerFromHeaders(new Headers({ 'x-auth-request-user': '  professor  ' }), {
        AIEAS_AUTH_MODE: 'proxy',
      })
    ).toEqual({ kind: 'member', login: 'professor', role: '평가팀' });
  });

  it('서버 설정에 등록한 네 역할만 로그인 사용자에게 적용한다', () => {
    const roleMap = JSON.stringify({ admin: 'Admin', evaluator: '평가팀', po: 'PO', planner: '기획팀' });
    for (const [login, role] of Object.entries({ admin: 'Admin', evaluator: '평가팀', po: 'PO', planner: '기획팀' })) {
      expect(viewerFromHeaders(new Headers({ 'x-auth-request-user': login }), {
        AIEAS_AUTH_MODE: 'proxy', AIEAS_ROLE_MAP: roleMap,
      })).toEqual({ kind: 'member', login, role });
    }
  });

  it('proxy 모드에서 헤더가 없거나 공백이면 guest 로 판별한다', () => {
    const env = { AIEAS_AUTH_MODE: 'proxy' };
    expect(viewerFromHeaders(new Headers(), env)).toEqual({
      kind: 'guest',
      label: '손님 평가자',
    });
    expect(
      viewerFromHeaders(new Headers({ 'x-auth-request-user': '  \t ' }), env)
    ).toEqual({ kind: 'guest', label: '손님 평가자' });
  });

  it('인증 모드가 없으면 닫히고 local 우회는 명시 설정에만 열린다', () => {
    expect(viewerFromHeaders(new Headers(), {})).toEqual({
      kind: 'guest', label: '손님 평가자',
    });
    expect(viewerFromHeaders(new Headers(), { AIEAS_AUTH_MODE: 'local' })).toEqual({
      kind: 'member',
      login: 'local',
      role: '평가팀',
    });
  });

  it('손님은 보고서와 재제안 액션에서 AI 호출 없이 차단된다', async () => {
    openDatabase(':memory:');
    createProject({ id: 'guest-ai', name: '가상 사업', created_at: new Date().toISOString() });
    const generateSuggestion = vi.fn();
    const generateReportDraft = vi.fn();
    setAiClient({ generateSuggestion, generateReportDraft } as never);
    await expect(generateReportDraftAction('guest-ai')).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(resuggestIndicatorAction('guest-ai', 'indicator')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(generateSuggestion).not.toHaveBeenCalled();
    expect(generateReportDraft).not.toHaveBeenCalled();
  });

  it('손님은 보고서 다운로드와 화면에도 접근하지 못한다', async () => {
    openDatabase(':memory:');
    createProject({ id: 'guest-download-project', name: '가상 사업', created_at: new Date().toISOString() });
    const createReportDraft = vi.spyOn(reportService, 'createReportDraft');
    const response = await downloadReport(new Request('http://localhost/projects/guest-download-project/report/download') as never, { params: Promise.resolve({ projectId: 'guest-download-project' }) });
    expect(response.status).toBe(404);
    await expect(generateReportDownloadAction('guest-download-project')).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(ReviewPage({ params: Promise.resolve({ projectId: 'guest-download-project' }), searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(ReportPage({ params: Promise.resolve({ projectId: 'guest-download-project' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(createReportDraft).not.toHaveBeenCalled();
  });

  it('저장된 초안이 있어도 PO의 route와 액션 다운로드는 거부한다', async () => {
    openDatabase(':memory:');
    createProject({ id: 'po-report', name: '가상 사업', created_at: '2026-01-01' });
    getDatabase().prepare("INSERT INTO documents (id, project_id, file_name, file_type, status, doc_type, is_included, is_past_final_report, created_at) VALUES ('pdm', 'po-report', 'plan.xlsx', 'xlsx', '추출 완료', '성과관리표', 1, 0, '2026-01-01')").run();
    vi.stubEnv('AIEAS_ROLE_MAP', JSON.stringify({ po: 'PO' }));
    vi.spyOn(reportService, 'getSavedReportDraft').mockReturnValue({ fingerprint: 'saved' } as never);
    const requestHeaders = new Headers({ 'x-auth-request-user': 'po' });
    vi.mocked(headers).mockResolvedValue(requestHeaders as never);
    const response = await downloadReport(new Request('http://localhost/report', { headers: requestHeaders }) as never, { params: Promise.resolve({ projectId: 'po-report' }) });
    expect(response.status).toBe(403);
    expect(await generateReportDownloadAction('po-report')).toMatchObject({ success: false, error: expect.stringContaining('권한') });
    vi.unstubAllEnvs();
  });

  it('로그인 평가팀은 검토와 보고서 화면에 접근한다', async () => {
    const tempDbPath = path.join(getTestTempDir(), `aieas-viewer-member-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`);
    try {
      await seedDev({ fakeAi: true, dbPath: tempDbPath, projectId: SEED_PROJECT_ID });
      openDatabase(tempDbPath);
      vi.mocked(headers).mockImplementation(async () => new Headers({ 'x-auth-request-user': 'member-user' }) as never);
      const reviewPage = await ReviewPage({ params: Promise.resolve({ projectId: SEED_PROJECT_ID }), searchParams: Promise.resolve({ indicatorId: 'ind-output' }) });
      expect(reviewPage.props.isGuest).toBe(false);
      const reviewHtml = renderToStaticMarkup(React.createElement(ReviewClientView, reviewPage.props));
      expect(reviewHtml).not.toMatch(/data-testid="resuggest-button"[^>]*disabled=""/);
      const reportPage = await ReportPage({ params: Promise.resolve({ projectId: SEED_PROJECT_ID }) });
      expect(reportPage.props.isGuest).toBe(false);
      const reportHtml = renderToStaticMarkup(React.createElement(ReportClientView, reportPage.props));
      expect(reportHtml).not.toMatch(/data-testid="generate-draft-button"[^>]*disabled=""/);
    } finally {
      closeDatabase();
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    }
  });

  it('proj-dev-seed ind-output 되돌리기: 실현으로 바뀐 제안을 기대 판정·2쪽 ¶3 인용 금지 알림으로 복원하고 다른 행은 보존한다', async () => {
    const tempDbPath = path.join(
      getTestTempDir(),
      `aieas-seed-reset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
    );
    const backupPath = `${tempDbPath}.bak-test`;
    try {
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      const db = openDatabase(tempDbPath);

      // 다른 지표(ind-activity)에 확정 이력 추가
      createConfirmation(
        {
          indicator_id: 'ind-activity',
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      // ind-output 을 '실현' 판정으로 덮어쓰기 (10/13 재제안 재현)
      saveSuggestion(
        {
          id: 'sug-mutated-realized',
          indicator_id: 'ind-output',
          verdict_status: '실현',
          proposal_text: '현지 점검 결과 산출물 목표가 실현됨.',
          error_reason: null,
          created_at: new Date().toISOString(),
        },
        [
          {
            id: 'ev-mutated-1',
            suggestion_id: 'sug-mutated-realized',
            document_id: 'doc-03_trip_report.pdf',
            location: '2쪽 ¶1',
            speaker: '수행기관',
            quote: '현지 점검 결과: 통합 플랫폼 1식 개발 완료 및 검수 통과 확인됨.',
            is_citation_banned: 0,
          },
        ],
        db
      );

      expect(
        getReviewData(SEED_PROJECT_ID, db)!.indicators.find((i) => i.indicator.id === 'ind-output')
          ?.suggestion?.verdict_status
      ).toBe('실현');

      // 백업 생성 및 seed-dev 기반 초기 제안 복원
      await backupDatabase(backupPath, db);
      expect(fs.existsSync(backupPath)).toBe(true);

      const seedSuggestion = await buildSeedIndicatorSuggestion({
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
        indicatorId: 'ind-output',
      });
      replaceIndicatorSuggestions(
        'ind-output',
        seedSuggestion.suggestion,
        seedSuggestion.evidences,
        db
      );

      const afterData = getReviewData(SEED_PROJECT_ID, db)!;
      const outputItem = afterData.indicators.find((i) => i.indicator.id === 'ind-output')!;
      expect(outputItem.suggestion?.verdict_status).toBe('기대');
      expect(outputItem.suggestion?.proposal_text).toBe(
        '통합 플랫폼 구축에 따른 성과가 기대됩니다.'
      );
      expect(outputItem.suggestion?.evidences).toHaveLength(2);
      const bannedEv = outputItem.suggestion?.evidences.find((e) => e.is_citation_banned === 1);
      expect(bannedEv).toBeDefined();
      expect(bannedEv?.document_id).toBe('doc-03_trip_report.pdf');
      expect(bannedEv?.location).toBe('2쪽 ¶3');
      expect(bannedEv?.quote).toBe('인용 금지 문장 있음');

      // 다른 지표 및 확정 이력 보존 확인
      const activityItem = afterData.indicators.find((i) => i.indicator.id === 'ind-activity')!;
      expect(activityItem.suggestion?.verdict_status).toBe('실현');
      expect(activityItem.latestConfirmation?.confirmer_name).toBe('평가자A');
    } finally {
      closeDatabase();
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    }
  });

  it('reset-seed-indicator.mjs CLI: (a) --dry-run 전후 DB·-wal 해시 불변, (b) 백업이 변경 전(실현) 보존, (c) 다른 사업·지표·확정 이력 보존, (d) --project-id 등 인자 거부', async () => {
    const tmpDir = getTestTempDir();
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const sourceDbPath = path.join(tmpDir, `aieas-cli-src-${runId}.db`);
    const targetDbPath = path.join(tmpDir, `aieas-cli-target-${runId}.db`);
    const scriptPath = path.resolve(__dirname, '../scripts/reset-seed-indicator.mjs');

    const sha256File = (filePath: string) =>
      crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

    try {
      // 1. 시드 생성 (proj-dev-seed + proj-multi-conflict 모두 포함)
      await seedDev({
        fakeAi: true,
        dbPath: sourceDbPath,
      });
      const db = openDatabase(sourceDbPath);

      // 다른 지표(ind-activity)에 확정 이력 추가
      createConfirmation(
        {
          id: 'conf-cli-keep-1',
          indicator_id: 'ind-activity',
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      // 다른 사업(proj-multi-conflict)에 미가림 인용 금지 근거를 넣어 openDatabase() 호출 시 이관되는지 감시
      const mcIndicators = listIndicators('proj-multi-conflict', db);
      const mcIndId = mcIndicators[0]!.id;
      saveSuggestion(
        {
          id: 'sug-mc-unmasked',
          indicator_id: mcIndId,
          verdict_status: '기대',
          proposal_text: '연계 사업 만족도 기대.',
          error_reason: null,
          created_at: '2026-10-13T23:00:00.000Z',
        },
        [
          {
            id: 'ev-mc-unmasked-1',
            suggestion_id: 'sug-mc-unmasked',
            document_id: 'doc-mc-plan-1',
            location: '¶1',
            speaker: '수행기관',
            quote: '익명을 요청한 관계자 의견입니다.',
            is_citation_banned: 0,
          },
        ],
        db
      );

      // WAL 체크포인트 후 ind-output 을 '실현' 으로 덮어써서 '실현' 변경분이 -wal 파일에 남도록 구성
      db.pragma('wal_checkpoint(TRUNCATE)');
      saveSuggestion(
        {
          id: 'sug-cli-mutated-realized',
          indicator_id: 'ind-output',
          verdict_status: '실현',
          proposal_text: '현지 점검 결과 산출물 목표가 실현됨.',
          error_reason: null,
          created_at: '2026-10-13T23:54:51.073Z',
        },
        [
          {
            id: 'ev-cli-mutated-1',
            suggestion_id: 'sug-cli-mutated-realized',
            document_id: 'doc-03_trip_report.pdf',
            location: '2쪽 ¶1',
            speaker: '수행기관',
            quote: '현지 점검 결과: 통합 플랫폼 1식 개발 완료 및 검수 통과 확인됨.',
            is_citation_banned: 0,
          },
        ],
        db
      );

      // 연결을 닫기 전에 .db 와 .db-wal 을 targetDbPath 로 복사하여 미체크포인트 WAL 상태를 재현
      fs.copyFileSync(sourceDbPath, targetDbPath);
      fs.copyFileSync(`${sourceDbPath}-wal`, `${targetDbPath}-wal`);
      closeDatabase();

      expect(fs.existsSync(targetDbPath)).toBe(true);
      expect(fs.existsSync(`${targetDbPath}-wal`)).toBe(true);
      expect(fs.statSync(`${targetDbPath}-wal`).size).toBeGreaterThan(0);

      const dbHashBefore = sha256File(targetDbPath);
      const walHashBefore = sha256File(`${targetDbPath}-wal`);

      // (d) --project-id, --indicator-id 등 허용되지 않는 인자를 주면 오류로 끝나는지 확인
      expect(() =>
        execFileSync(process.execPath, [scriptPath, targetDbPath, '--project-id', 'other-proj'], {
          stdio: 'pipe',
        })
      ).toThrow();
      expect(() =>
        execFileSync(
          process.execPath,
          [scriptPath, targetDbPath, '--project-id=proj-dev-seed'],
          { stdio: 'pipe' }
        )
      ).toThrow();
      expect(() =>
        execFileSync(
          process.execPath,
          [scriptPath, targetDbPath, '--indicator-id', 'ind-activity'],
          { stdio: 'pipe' }
        )
      ).toThrow();

      // (a) --dry-run 실행 전후로 DB 및 -wal 파일 해시가 동일한지 확인
      const dryRunStdout = execFileSync(
        process.execPath,
        [scriptPath, targetDbPath, '--dry-run'],
        { encoding: 'utf8' }
      );
      expect(dryRunStdout).toContain('[DRY-RUN]');
      const dryRunJson = JSON.parse(dryRunStdout.slice(dryRunStdout.indexOf('{')));
      expect(dryRunJson.mode).toBe('dry-run');
      expect(dryRunJson.target.project_id).toBe('proj-dev-seed');
      expect(dryRunJson.target.indicator_id).toBe('ind-output');
      expect(dryRunJson.before.verdict_status).toBe('실현');
      expect(dryRunJson.after.verdict_status).toBe('기대');

      const dbHashAfterDryRun = sha256File(targetDbPath);
      const walHashAfterDryRun = sha256File(`${targetDbPath}-wal`);
      expect(dbHashAfterDryRun).toBe(dbHashBefore);
      expect(walHashAfterDryRun).toBe(walHashBefore);

      // (b) 일반 실행: 백업 파일이 바뀌기 전 값('실현')을 담고 있고, 본 DB 는 '기대' 로 복원되는지 확인
      const applyStdout = execFileSync(process.execPath, [scriptPath, targetDbPath], {
        encoding: 'utf8',
      });
      expect(applyStdout).toContain('[백업 완료]');
      const applyJson = JSON.parse(applyStdout.slice(applyStdout.indexOf('{')));
      const backupFilePath = applyJson.backupPath as string;
      expect(fs.existsSync(backupFilePath)).toBe(true);

      const roBackup = openReadonlyDatabase(backupFilePath);
      try {
        const backupLatest = getLatestSuggestion('ind-output', roBackup);
        expect(backupLatest?.id).toBe('sug-cli-mutated-realized');
        expect(backupLatest?.verdict_status).toBe('실현');

        // 백업은 openDatabase()(인용 금지 근거 이관)가 실행되기 전 상태여야 함
        const mcIndicatorsInBackup = listIndicators('proj-multi-conflict', roBackup);
        const backupMcLatest = getLatestSuggestion(mcIndicatorsInBackup[0]!.id, roBackup);
        expect(backupMcLatest?.evidences[0]?.is_citation_banned).toBe(0);
        expect(backupMcLatest?.evidences[0]?.quote).toBe('익명을 요청한 관계자 의견입니다.');
      } finally {
        roBackup.close();
      }

      // (c) 본 DB 의 복원 결과 및 다른 사업·지표·확정 이력 보존 확인
      const roTarget = openReadonlyDatabase(targetDbPath);
      try {
        const afterData = getReviewData(SEED_PROJECT_ID, roTarget)!;
        const outputItem = afterData.indicators.find((i) => i.indicator.id === 'ind-output')!;
        expect(outputItem.suggestion?.verdict_status).toBe('기대');
        expect(outputItem.suggestion?.proposal_text).toBe(
          '통합 플랫폼 구축에 따른 성과가 기대됩니다.'
        );
        const bannedEv = outputItem.suggestion?.evidences.find((e) => e.is_citation_banned === 1);
        expect(bannedEv?.document_id).toBe('doc-03_trip_report.pdf');
        expect(bannedEv?.location).toBe('2쪽 ¶3');
        expect(bannedEv?.quote).toBe('인용 금지 문장 있음');

        const activityItem = afterData.indicators.find((i) => i.indicator.id === 'ind-activity')!;
        expect(activityItem.suggestion?.verdict_status).toBe('실현');
        expect(activityItem.latestConfirmation?.id).toBe('conf-cli-keep-1');
        expect(activityItem.latestConfirmation?.confirmer_name).toBe('평가자A');

        const otherProjectData = getReviewData('proj-multi-conflict', roTarget);
        expect(otherProjectData).not.toBeNull();
        expect(otherProjectData?.project.name).toBe('복수 충돌 테스트 사업');
        expect(otherProjectData?.indicators.length).toBeGreaterThan(0);

        // 대상 밖 사업의 미가림 근거는 인용 금지 이관으로 바뀌지 않아야 한다.
        const unmaskedEv = roTarget
          .prepare('SELECT speaker, quote, is_citation_banned FROM evidences WHERE id = ?')
          .get('ev-mc-unmasked-1') as { speaker: string; quote: string; is_citation_banned: number };
        expect(unmaskedEv).toEqual({
          speaker: '수행기관',
          quote: '익명을 요청한 관계자 의견입니다.',
          is_citation_banned: 0,
        });
      } finally {
        roTarget.close();
      }
    } finally {
      closeDatabase();
      for (const f of fs.readdirSync(tmpDir)) {
        if (f.includes(runId)) {
          fs.rmSync(path.join(tmpDir, f), { force: true });
        }
      }
    }
  });
});

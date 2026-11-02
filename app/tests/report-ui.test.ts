import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { seedDev, SEED_PROJECT_ID } from '../scripts/seed-dev';
import { closeDatabase, createConfirmation, createDocument, createProject, openDatabase, insertParagraphs, insertSentences, saveIndicatorAttribution, saveReportDraft } from '../src/server/store';
import {
  generateReportDownloadAction,
  generateReportDraftAction,
} from '../src/app/projects/[projectId]/report/actions';
import {
  EvidencePanel,
  getStatusBadgeClass,
  ReportClientView,
  TemplateMismatchNotice,
} from '../src/app/projects/[projectId]/report/report-client-view';
import { sourceSnippetFromSearch } from '../src/app/projects/[projectId]/review/review-client-view';
import { getAutoOpenSnippetId } from '../src/app/projects/[projectId]/review/review-page-state';
import { TemplateSections } from '../src/app/projects/[projectId]/report/template-sections';
import { prepareTemplate } from '../src/server/report/templates';
import { createReportDraft } from '../src/server/report';
import ReportPage from '../src/app/projects/[projectId]/report/page';
import { AiClient } from '../src/server/ai';
import * as ontologyStore from '../src/server/store/ontology';
import * as toc from '../src/server/toc';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('../src/app/projects/[projectId]/project-tabs', () => ({
  ProjectTabs: () => null,
}));

describe('S6 보고서 초안 화면 및 서버 액션 단위 시험 (RQ-20, UC-06, UC-17, D47)', () => {
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-report-ui-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
    );
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {}
    }
  });

  describe('1. ReportPage 404 및 렌더링 검증', () => {
    it('존재하지 않는 projectId 전달 시 notFound() 예외가 발생한다', async () => {
      openDatabase(tempDbPath);
      await expect(
        ReportPage({ params: Promise.resolve({ projectId: 'non-existent-proj' }) })
      ).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('정상 사업이 존재하면 ReportPage 가 정상 렌더링 요소를 반환한다', async () => {
      const db = openDatabase(tempDbPath);
      createProject(
        {
          id: 'proj-ui-1',
          name: '보고서 UI 시험 사업',
          created_at: new Date().toISOString(),
        },
        db
      );

      createDocument({ id: 'pdm-ui-1', project_id: 'proj-ui-1', file_name: 'pdm.pdf', file_type: 'pdf', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: new Date().toISOString() }, db);
      const pageElement = await ReportPage({
        params: Promise.resolve({ projectId: 'proj-ui-1' }),
      });
      expect(pageElement).toBeDefined();
      expect(pageElement.props.project.id).toBe('proj-ui-1');
    });

    it('legacy 저장판은 금지 문장의 원래 순서와 중복을 보존해 전달한다', async () => {
      const db = openDatabase(tempDbPath);
      createProject({ id: 'duplicate-ban', name: '보고서 시험 사업', created_at: '2026-11-02' }, db);
      createDocument({ id: 'duplicate-ban-doc', project_id: 'duplicate-ban', file_name: 'pdm.pdf', file_type: 'pdf', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-11-02' }, db);
      insertParagraphs([{ id: 'duplicate-ban-para', document_id: 'duplicate-ban-doc', sequence_no: 1, location: '1', content: '가상의 금지 문장입니다.' }], db);
      insertSentences([1, 2].map(sequence_no => ({ id: `duplicate-ban-${sequence_no}`, document_id: 'duplicate-ban-doc', paragraph_id: 'duplicate-ban-para', sequence_no, location: '1', content: '가상의 금지 문장입니다.', is_citation_banned: 1 })), db);
      saveReportDraft('duplicate-ban', JSON.stringify({ project_id: 'duplicate-ban', project_name: '보고서 시험 사업', version: 2, created_at: '2026-11-02', confirmed_count: 0, sections: {} }), db);
      const page = await ReportPage({ params: Promise.resolve({ projectId: 'duplicate-ban' }) });
      expect(page.props.initialBannedSentences).toEqual(['가상의 금지 문장입니다.', '가상의 금지 문장입니다.']);
      expect(page.props.initialTargets).toEqual([]);
    });

    it('summary 저장판은 금지 문장과 전체 대상 데이터를 초기 props에 넣지 않는다', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      await seedDev({ fakeAi: true, dbPath: tempDbPath, projectId: SEED_PROJECT_ID });
      const db = openDatabase(tempDbPath);
      createConfirmation({ indicator_id: 'ind-activity', confirmation_type: '확정', confirmer_name: '가상 평가자' }, db);
      await createReportDraft(SEED_PROJECT_ID, { db });
      const page = await ReportPage({ params: Promise.resolve({ projectId: SEED_PROJECT_ID }) });
      expect(page.props.initialBannedSentences).toEqual([]);
      expect(page.props.initialTargets).toEqual([]);
      delete process.env.AIEAS_E2E_FAKE_AI;
    });

    it('저장된 초안이 무효화된 상태이면 ReportPage 가 initialDraft: null 및 initialOutdated: true 를 넘긴다', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      const db = openDatabase(tempDbPath);

      // 확정 후 초안 생성
      createConfirmation(
        {
          indicator_id: 'ind-activity',
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );
      const saved = await createReportDraft(SEED_PROJECT_ID, { db });

      // 보완 필요로 재확정 -> 초안 무효화
      createConfirmation(
        {
          indicator_id: 'ind-activity',
          confirmation_type: '보완 필요',
          confirmer_name: '평가자A',
          reason: '재검토',
        },
        db
      );

      const pageElement = await ReportPage({
        params: Promise.resolve({ projectId: SEED_PROJECT_ID }),
      });
      expect(saved.fingerprint).toBeTruthy();
      expect(pageElement.props.initialDraft).toBeNull();
      expect(pageElement.props.initialOutdated).toBe(true);
      delete process.env.AIEAS_E2E_FAKE_AI;
    });

    it('기여 귀속 변경 시 저장된 초안과 다시 만들기 안내 상태를 함께 넘긴다', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      const db = openDatabase(tempDbPath);

      createConfirmation(
        {
          indicator_id: 'ind-activity',
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );
      saveIndicatorAttribution(
        SEED_PROJECT_ID,
        'ind-activity',
        '초기 기여 귀속 내용',
        db
      );
      const saved = await createReportDraft(SEED_PROJECT_ID, { db });

      // 기여 귀속 수정
      saveIndicatorAttribution(
        SEED_PROJECT_ID,
        'ind-activity',
        '수정된 기여 귀속 내용 (평가자 수정)',
        db
      );

      const pageElement = await ReportPage({
        params: Promise.resolve({ projectId: SEED_PROJECT_ID }),
      });
      expect(saved.fingerprint).toBeTruthy();
      expect(pageElement.props.initialDraft).toBeNull();
      expect(pageElement.props.initialOutdated).toBe(true);
      delete process.env.AIEAS_E2E_FAKE_AI;
    });

    it('초안에 excluded_notice 가 있으면 ReportPage initialDraft 의 3절에 정상 포함된다 (#22 마지막 검수 Item 2)', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      const db = openDatabase(tempDbPath);

      // ind-unsupported(근거 0건 지표) 확정 및 기여 귀속 저장
      createConfirmation(
        {
          indicator_id: 'ind-unsupported',
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );
      saveIndicatorAttribution(
        SEED_PROJECT_ID,
        'ind-unsupported',
        '근거 없는 지표 기여 귀속',
        db
      );

      await createReportDraft(SEED_PROJECT_ID, { db });

      const pageElement = await ReportPage({
        params: Promise.resolve({ projectId: SEED_PROJECT_ID }),
      });
      expect(pageElement.props.initialDraft).toBeDefined();
      const draft = pageElement.props.initialDraft;
      expect(draft.sections.contributing_factors.excluded_notice).toContain(
        '근거가 없어 기여요인 절에서 뺀 기여 귀속 1건'
      );
      delete process.env.AIEAS_E2E_FAKE_AI;
    });

    it('legacy 저장판에서는 사라진 지표(is_orphaned=1)를 initialTargets 에 보존한다 (#19, #22)', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      const db = openDatabase(tempDbPath);

      // ind-activity 확정 등록 및 사라진 지표로 변경
      createConfirmation(
        {
          indicator_id: 'ind-activity',
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );
      db.prepare('UPDATE indicators SET is_orphaned = 1 WHERE id = ?').run('ind-activity');
      saveReportDraft(SEED_PROJECT_ID, JSON.stringify({ project_id: SEED_PROJECT_ID, project_name: '가상 사업', version: 2, created_at: '2026-11-02', confirmed_count: 1, sections: {} }), db);

      const pageElement = await ReportPage({
        params: Promise.resolve({ projectId: SEED_PROJECT_ID }),
      });
      expect(pageElement).toBeDefined();
      const orphanedTarget = pageElement.props.initialTargets.find(
        (t: any) => t.indicator.id === 'ind-activity'
      );
      expect(orphanedTarget).toBeDefined();
      expect(orphanedTarget.indicator.is_orphaned).toBe(1);
      delete process.env.AIEAS_E2E_FAKE_AI;
    });
  });

  describe('2. generateReportDraftAction 서버 액션 및 사업 격리', () => {
    it('저장본 화면 렌더와 Word는 실제 지문 검사 중에도 AI와 지식 지도를 조립하지 않는다', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      await seedDev({ fakeAi: true, dbPath: tempDbPath, projectId: SEED_PROJECT_ID });
      const db = openDatabase(tempDbPath);
      createConfirmation({ indicator_id: 'ind-activity', confirmation_type: '확정', confirmer_name: '가상 평가자' }, db);
      await createReportDraft(SEED_PROJECT_ID, { db });
      const ai = vi.spyOn(AiClient.prototype, 'generateReportDraft');
      const graph = vi.spyOn(ontologyStore, 'getProjectOntologyGraph');
      const sync = vi.spyOn(toc, 'syncTocForProject');
      try {
        const element = await ReportPage({ params: Promise.resolve({ projectId: SEED_PROJECT_ID }) });
        expect(element.props.initialDraft).not.toBeNull();
        expect(element.props.initialOutdated).toBe(false);
        expect(renderToStaticMarkup(element)).toContain('보고서 초안');
        const word = await generateReportDownloadAction(SEED_PROJECT_ID);
        expect(word.success).toBe(true);
        expect(Buffer.from(word.contentBase64 ?? '', 'base64').length).toBeGreaterThan(0);
        expect(ai).not.toHaveBeenCalled();
        expect(graph).not.toHaveBeenCalled();
        expect(sync).not.toHaveBeenCalled();
      } finally {
        ai.mockRestore(); graph.mockRestore(); sync.mockRestore();
        delete process.env.AIEAS_E2E_FAKE_AI;
      }
    });
    it('존재하지 않는 사업 식별자 요청 시 오류를 반환한다', async () => {
      openDatabase(tempDbPath);
      const res = await generateReportDraftAction('invalid-proj-id');
      expect(res.success).toBe(false);
      expect(res.error).toContain('찾을 수 없습니다');
    });

    it('정상 사업에 대해 초안 생성 결과를 반환한다', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });

      const res = await generateReportDraftAction(SEED_PROJECT_ID);
      expect(res.success).toBe(true);
      expect(res.draft).toBeDefined();
      delete process.env.AIEAS_E2E_FAKE_AI;
    });

    it('Word 내려받기 서버 액션이 실패 메시지 또는 DOCX 내용을 반환한다', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      await seedDev({
        fakeAi: true,
        dbPath: tempDbPath,
        projectId: SEED_PROJECT_ID,
      });
      const db = openDatabase(tempDbPath);
      createConfirmation(
        {
          indicator_id: 'ind-activity',
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      const before = await generateReportDownloadAction(SEED_PROJECT_ID);
      expect(before.success).toBe(false);
      expect(before.error).toContain('저장된 초안이 없습니다');
      await createReportDraft(SEED_PROJECT_ID, { db });
      const result = await generateReportDownloadAction(SEED_PROJECT_ID);
      expect(result.success).toBe(true);
      expect(result.fileName).toBe(`report_${SEED_PROJECT_ID}.docx`);
      const content = Buffer.from(result.contentBase64 ?? '', 'base64');
      expect(content.subarray(0, 2).toString()).toBe('PK');
      delete process.env.AIEAS_E2E_FAKE_AI;
    });
  });

  describe('3. getStatusBadgeClass 뱃지 스타일 매핑 검증', () => {
    it('실현, 추진 중, 기대, 근거 충돌, 근거 미확인에 대한 스타일을 반환한다', () => {
      expect(getStatusBadgeClass('실현').container).toContain('emerald');
      expect(getStatusBadgeClass('추진 중').container).toContain('blue');
      expect(getStatusBadgeClass('기대').container).toContain('amber');
      expect(getStatusBadgeClass('근거 충돌').container).toContain('orange');
      expect(getStatusBadgeClass('근거 미확인').container).toContain('slate');
      expect(getStatusBadgeClass('미확인').container).toContain('slate');
      expect(getStatusBadgeClass('기타').container).toContain('gray');
    });
  });

  it('원문 자동 열기는 open=source와 스니펫이 함께 있을 때만 해당 카드를 지정한다', () => {
    expect(sourceSnippetFromSearch('?indicatorId=ind&snippet=ev%2F1&open=source')).toBe('ev/1');
    expect(sourceSnippetFromSearch('?snippet=ev&open=other')).toBeNull();
    expect(sourceSnippetFromSearch('?open=source')).toBeNull();
  });

  it('원문 자동 열기는 선택 지표에 귀속된 인용 가능 근거만 연다', () => {
    const selectedIndicator = {
      indicator: { id: 'ind-a' },
      suggestion: {
        evidences: [
          { id: 'ev-a', is_citation_banned: 0 },
          { id: 'ev-banned', is_citation_banned: 1 },
        ],
      },
    } as any;

    const getFromServer = (search: string, selected: typeof selectedIndicator | undefined) =>
      getAutoOpenSnippetId(search, { indicators: selected ? [selected] : [] } as any, selected?.indicator.id);

    expect(getFromServer('?indicatorId=ind-a&snippet=ev-a&open=source', selectedIndicator)).toBe('ev-a');
    expect(getFromServer('?indicatorId=ind-a&snippet=ev-b&open=source', {
      ...selectedIndicator,
      indicator: { id: 'ind-b' },
      suggestion: { evidences: [{ id: 'ev-b', is_citation_banned: 0 }] },
    })).toBeNull();
    expect(getFromServer('?indicatorId=ind-b&snippet=ev-b&open=source', {
      ...selectedIndicator,
      indicator: { id: 'ind-b' },
      suggestion: { evidences: [{ id: 'ev-b', is_citation_banned: 0 }] },
    })).toBe('ev-b');
    expect(getFromServer('?indicatorId=ind-a&snippet=ev-b&open=source', selectedIndicator)).toBeNull();
    expect(getFromServer('?indicatorId=ind-a&snippet=ev-banned&open=source', selectedIndicator)).toBeNull();
    expect(getFromServer('?snippet=ev-a&open=other', selectedIndicator)).toBeNull();
    expect(getFromServer('?snippet=ev-a&open=source', undefined)).toBeNull();
  });

  it('새 서식 화면은 문장 각주와 출처 목록을 함께 표시한다', async () => {
    const db = openDatabase(tempDbPath);
    createProject({ id: 'template-ui', name: '가상 사업', created_at: new Date().toISOString() }, db);
    const draft = await createReportDraft('template-ui', { db, template: 'eipp' });
    draft.sections.performance_analysis.sentences = [{ indicator_id: 'ind', indicator_name: '가상 지표', sentence: '가상 문장', evidence_id: 'ev', evidence_ids: ['ev'], evidences: [{ id: 'ev', quote: '가상 인용', location: '2쪽', document_name: '가상 문서', speaker: '가상 평가자' }] }];
    prepareTemplate(draft, 'eipp');
    const html = renderToStaticMarkup(createElement(TemplateSections, { draft, onSelect: () => {} }));
    expect(html).toContain('2. 사업별 모니터링 및 평가 결과');
    expect(html).toContain('가상 문장');
    expect(html).toContain('aria-label="근거: 가상 지표"');
    expect(html).toContain('aria-describedby="sentence-description-eipp-unclassified-0"');
    expect(html).toContain('<sup>[1]</sup>');
    expect(html).toContain('data-testid="report-footnote-entry-1">[1] 가상 문서 · 2쪽</button>');
    expect(html).not.toContain('[1] ev ·');
    expect(html.indexOf('<sup>[1]</sup>')).toBeLessThan(html.indexOf('[1] 가상 문서 · 2쪽'));
  });

  it('새 서식의 문장과 달성표 행에 원문 대조 제외 사유를 표시한다', () => {
    const html = renderToStaticMarkup(createElement(TemplateSections, {
      draft: {
        footnotes: [],
        report_sections: [{
          id: 'warning-test', title: '가상 절', level: 1,
          rows: [{ indicator_id: 'row', indicator_name: '가상 지표', target_value: '1', status_display: '확정', evidence_match_warning: '원문 대조 실패: 인용문이 원문 문단과 일치하지 않아 근거를 인용에서 제외했습니다.' }],
          sentences: [{ indicator_id: 'sentence', indicator_name: '가상 지표', sentence: '가상 문장', evidence_id: '', evidence_ids: [], evidence_match_warning: '원문 문단 미확인으로 근거를 인용에서 제외했습니다.' }],
        }],
      } as any,
      onSelect: () => {},
    }));
    expect(html).toContain('evidence-match-warning-row');
    expect(html).toContain('원문 대조 실패: 인용문이 원문 문단과 일치하지 않아 근거를 인용에서 제외했습니다.');
    expect(html).toContain('evidence-match-warning-sentence-0');
    expect(html).toContain('원문 문단 미확인으로 근거를 인용에서 제외했습니다.');
  });

  describe('4. 기존 일곱 절의 문장 근거 패널', () => {
    const sentence = {
      indicator_id: 'fixture-indicator',
      indicator_name: '가상 지표',
      sentence: '가상 협력국의 등록 인원이 증가했다.',
      evidence_id: 'fixture-evidence',
      evidence_ids: ['fixture-evidence'],
      evidences: [
        {
          id: 'fixture-evidence',
          quote: '등록 인원이 12명 늘었다.',
          location: '3쪽 2문단',
          speaker: 'KDI',
          document_name: '가상 성과보고서',
        },
      ],
    };
    const target = (paragraphContent?: string, citationBanned = 0) => ({
      indicator: { id: 'fixture-indicator', name: '가상 지표' },
      latestConfirmation: {
        confirmation_type: '수정 후 확정',
        confirmer_name: '가상 평가자',
        created_at: '2026-01-02T03:04:05.000Z',
      },
      evidences: [
        {
          id: 'fixture-evidence',
          is_citation_banned: citationBanned,
          paragraph_context: paragraphContent
            ? { target: { content: paragraphContent } }
            : undefined,
        },
      ],
    });

    it('선택한 보고서 문장의 연결 근거와 확인 가능한 원문 대조·확정 정보를 표시한다', () => {
      const html = renderToStaticMarkup(
        createElement(EvidencePanel, {
          projectId: 'fixture-project',
          sentence,
          target: target('가상 자료에는 “등록 인원이 12명 늘었다.”고 기록되어 있다.') as any,
          isGuest: true,
        })
      );

      expect(html).toContain('등록 인원이 12명 늘었다.');
      expect(html).toContain('가상 성과보고서 · 3쪽 2문단 · 협력기관');
      expect(html).toContain('신뢰 수준');
      expect(html).toContain('미확인');
      expect(html).toContain('원문 일치도');
      expect(html).toContain('일치 확인');
      expect(html).toContain('수정 후 확정');
      expect(html).toContain('가상 평가자');
      expect(html).toContain('2026-01-02T03:04:05.000Z');
      expect(html).toContain('/review?indicatorId=fixture-indicator&amp;snippet=fixture-evidence&amp;open=source#evidence-fixture-evidence');
    });

    it('원문 문단은 있으나 연결 인용과 다르면 불일치, 원문 위치 정보가 없으면 미확인이다', () => {
      const renderWithTarget = (context?: string) => renderToStaticMarkup(
        createElement(EvidencePanel, {
          projectId: 'fixture-project',
          sentence,
          target: target(context) as any,
        })
      );

          expect(renderWithTarget('이 문단에는 다른 내용만 있다.')).toContain('불일치');
      expect(renderWithTarget()).toContain('원문 일치도</dt><dd>미확인</dd>');
    });

    it('인용 금지 근거는 패널에서 원문을 노출하지 않는다', () => {
      const bannedSentence = {
        ...sentence,
        evidences: [{ ...sentence.evidences[0], quote: '가상 제보자의 보호 요청 인용문' }],
      };
      const html = renderToStaticMarkup(
        createElement(EvidencePanel, {
          projectId: 'fixture-project',
          sentence: bannedSentence,
          target: target('가상 제보자의 보호 요청 인용문', 1) as any,
        })
      );

      expect(html).not.toContain('가상 제보자의 보호 요청 인용문');
      expect(html).toContain('근거 미확인');
    });

    it('사업 금지문과 겹치는 초안 인용도 패널에서 가리고 근거 미확인으로 표시한다', () => {
      const overlapQuote = '가상 지원자는 별도 보호 조치가 필요합니다';
      const html = renderToStaticMarkup(
        createElement(EvidencePanel, {
          projectId: 'fixture-project',
          sentence: {
            ...sentence,
            evidences: [{ ...sentence.evidences[0], quote: overlapQuote, is_citation_banned: 0 } as any],
          },
          target: target(overlapQuote, 0) as any,
          bannedSentences: ['가상 지원자는 별도 보호 조치가 필요합니다.'],
        })
      );
      expect(html).not.toContain(overlapQuote);
      expect(html).toContain('근거 미확인');
    });

    it('오래된 초안의 패널은 연결 근거 인용을 숨기고 갱신 안내를 표시한다', () => {
      const html = renderToStaticMarkup(
        createElement(EvidencePanel, {
          projectId: 'fixture-project',
          sentence,
          target: target('가상 자료에는 “등록 인원이 12명 늘었다.”고 기록되어 있다.') as any,
          isOutdated: true,
        })
      );
      expect(html).toContain('outdated-evidence-panel-notice');
      expect(html).toContain('새 초안을 만드세요');
      expect(html).not.toContain('등록 인원이 12명 늘었다.');
    });

    it('연결 지표 근거를 찾지 못한 패널은 인용 대신 오래된 초안 안내를 표시한다', () => {
      const html = renderToStaticMarkup(createElement(EvidencePanel, {
        projectId: 'fixture-project', sentence, target: undefined,
      }));
      expect(html).toContain('outdated-evidence-panel-notice');
      expect(html).not.toContain('등록 인원이 12명 늘었다.');
    });

    it('초안과 현재 근거 플래그 중 하나라도 금지면 패널에서 인용을 가린다', () => {
      const html = renderToStaticMarkup(createElement(EvidencePanel, {
        projectId: 'fixture-project',
        sentence: { ...sentence, evidences: [{ ...sentence.evidences[0], is_citation_banned: 0 }] } as any,
        target: target('등록 인원이 12명 늘었다.', 1) as any,
      }));
      expect(html).not.toContain('등록 인원이 12명 늘었다.');
      expect(html).toContain('근거 미확인');
    });

    it('선택 서식이 저장 초안과 다르면 Word가 저장 서식 기준임을 알린다', () => {
      const html = renderToStaticMarkup(
        createElement(TemplateMismatchNotice, { hasDraft: true, savedTemplate: 'ksp', selectedTemplate: 'eipp' })
      );
      expect(html).toContain('report-template-mismatch-notice');
      expect(html).toContain('저장된 초안은 KSP 서식');
      expect(html).toContain('현재 Word 파일은 저장된 초안 기준');
      expect(renderToStaticMarkup(createElement(TemplateMismatchNotice, { hasDraft: true, savedTemplate: 'eipp', selectedTemplate: 'eipp' }))).toBe('');
      expect(renderToStaticMarkup(createElement(TemplateMismatchNotice, { hasDraft: true, savedTemplate: undefined, selectedTemplate: 'ksp' }))).toContain('저장된 초안은 기존 7절 서식');
      expect(renderToStaticMarkup(createElement(TemplateMismatchNotice, { hasDraft: true, savedTemplate: 'legacy7', selectedTemplate: 'eipp' }))).toContain('저장된 초안은 기존 7절 서식');
      expect(renderToStaticMarkup(createElement(TemplateMismatchNotice, { hasDraft: false, savedTemplate: undefined, selectedTemplate: 'ksp' }))).toBe('');
    });

    it('오래된 기존 일곱 절 본문을 숨기고 최신 본문에서는 일곱 절과 문장 선택을 유지한다', () => {
      const emptyContent = { content: '' };
      const initialDraft = {
        project_id: 'fixture-project',
        project_name: '가상 사업',
        confirmed_count: 1,
        created_at: '2026-01-02T03:04:05.000Z',
        sections: {
          achievement_table: { title: '성과지표 달성표', rows: [] },
          performance_analysis: { title: '성과 분석', sentences: [sentence] },
          contributing_factors: { title: '기여요인', sentences: [sentence] },
          constraints_and_responses: { title: '제약요인과 대응', ...emptyContent },
          lessons_learned: { title: '교훈', ...emptyContent },
          monitoring_plan: { title: '모니터링 계획', ...emptyContent },
          overall_evaluation: { title: '종합평가', ...emptyContent },
        },
      } as any;
      const html = renderToStaticMarkup(
        createElement(ReportClientView, {
          project: { id: 'fixture-project', name: '가상 사업' } as any,
          initialTargets: [target('등록 인원이 12명 늘었다고 가상 자료가 기록했다.') as any],
          initialOutdated: true,
          initialDraft,
        })
      );

      expect(html).not.toContain('data-testid="section-achievement-table"');
      expect(html).not.toContain('data-testid="section-performance-analysis"');
      expect(html).not.toContain('data-testid="section-overall-evaluation"');
      expect(html).not.toContain('data-testid="select-sentence-fixture-indicator-0"');
      expect(html).not.toContain('data-testid="report-evidence-sidebar"');
      expect(html).not.toContain('등록 인원이 12명 늘었다고 가상 자료가 기록했다.');
      expect(html).toContain('data-testid="outdated-draft-notice"');
      const currentHtml = renderToStaticMarkup(createElement(ReportClientView, {
        project: { id: 'fixture-project', name: '가상 사업' } as any,
        initialTargets: [target('등록 인원이 12명 늘었다고 가상 자료가 기록했다.') as any],
        initialDraft,
        initialOutdated: false,
      }));
      expect(currentHtml).not.toContain('data-testid="outdated-draft-notice"');
      expect(currentHtml).toContain('data-testid="section-achievement-table"');
      expect(currentHtml).toContain('data-testid="section-performance-analysis"');
      expect(currentHtml).toContain('data-testid="section-overall-evaluation"');
      expect(currentHtml).toContain('data-testid="select-sentence-fixture-indicator-0"');
      expect(currentHtml).toContain('data-testid="report-evidence-sidebar"');
      expect(currentHtml).toContain('aria-label="보고서 서식"');
    });
  });
});

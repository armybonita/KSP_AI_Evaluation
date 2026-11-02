import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, createDocument, createProject, getDatabase, getProjectCitationContext, openDatabase } from '@/server/store/db';
import { NextRequest } from 'next/server';

const spies = vi.hoisted(() => ({ graph: vi.fn(), toc: vi.fn(), ai: vi.fn(), saved: vi.fn(), targets: vi.fn(), citation: vi.fn(), review: vi.fn(), notes: vi.fn() }));
vi.mock('@/server/project-visibility', () => ({ assertProjectVisibleToCurrentViewer: vi.fn(), isProjectHiddenFromViewer: vi.fn(() => false) }));
vi.mock('@/server/project-pdm', () => ({ isProjectPdmRegistered: vi.fn(() => true) }));
vi.mock('@/server/store', () => ({ getProject: vi.fn(() => ({ id: 'virtual', name: '가상 사업' })), getLatestReportDraft: vi.fn(() => ({ id: 'version-1' })), getReportTargetCount: vi.fn(() => 1), getReportTargets: spies.targets, getProjectCitationContext: spies.citation, getBannedSentencesByProject: vi.fn(() => []), getProjectOntologyGraph: spies.graph, getReviewData: spies.review, getNoteReviewData: spies.notes, isIndicatorInProject: vi.fn(() => true) }));
vi.mock('@/server/store/ontology', () => ({ getProjectOntologyGraph: spies.graph }));
vi.mock('@/server/store/note-review', () => ({ getNoteReviewData: spies.notes, getConfirmedNoteCount: vi.fn(() => 0) }));
vi.mock('@/server/toc', () => ({ syncTocForProject: spies.toc }));
vi.mock('@/server/ai', () => ({ getAiClient: spies.ai, getAiProvider: vi.fn() }));
vi.mock('@/server/viewer', () => ({ currentViewer: vi.fn(async () => ({ kind: 'member', role: '평가팀' })), viewerFromHeaders: vi.fn(() => ({ kind: 'member', role: '평가팀' })), viewerCan: vi.fn(() => true), isGuestViewer: vi.fn(() => false), GUEST_AI_BLOCKED_MESSAGE: '로그인 필요' }));
vi.mock('@/server/report', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/server/report')>()), getSavedReportDraftWithStatus: vi.fn(() => ({ draft: spies.saved(), isOutdated: false })), listReportDrafts: vi.fn(() => [{ id: 'version-1', draft_number: 1, created_at: '2026-01-01', isFinalized: false }]) }));

import ReportPage from '@/app/projects/[projectId]/report/page';
import ReviewPage from '@/app/projects/[projectId]/review/page';
import { GET } from '@/app/projects/[projectId]/report/download/route';

const savedDraft = {
  project_id: 'virtual', project_name: '가상 사업', confirmed_count: 1, created_at: '2026-01-01',
  summary_format: 1, version: 3, template: 'eipp', report_sections: [{ id: 'overview', title: '저장된 사업 개요', level: 1, empty_message: '※ 근거 자료 미확보' }], footnotes: [],
  sections: {
    achievement_table: { title: '성과지표 달성표', rows: [] }, performance_analysis: { title: '성과 분석', sentences: [] },
    contributing_factors: { title: '기여요인' }, constraints_and_responses: { title: '제약요인과 대응' },
    lessons_learned: { title: '교훈' }, monitoring_plan: { title: '모니터링 계획' }, overall_evaluation: { title: '종합평가' },
  },
};

describe('저장본 읽기 성능 경계', () => {
  beforeEach(() => {
    const db = openDatabase(':memory:');
    createProject({ id: 'virtual', name: '가상 사업', created_at: '2026-01-01' }, db);
    spies.citation.mockImplementation((projectId: string) => getProjectCitationContext(projectId, db));
  });
  afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });
  it('서버 렌더와 Word 다운로드에서 AI와 지식 지도 조립을 호출하지 않는다', async () => {
    spies.saved.mockReturnValue(savedDraft);
    const db = getDatabase();
    createDocument({ id: 'current', project_id: 'virtual', file_name: '가상.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-01-01' }, db);
    const statements = vi.spyOn(db, 'prepare');
    const rendered = renderToStaticMarkup(await ReportPage({ params: Promise.resolve({ projectId: 'virtual' }) }));
    expect(rendered).toContain('저장된 사업 개요');
    expect(statements.mock.calls.filter(([sql]) => /FROM (?:json_each\(\?\) ids|paragraphs p)/i.test(sql))).toHaveLength(0);
    const response = await GET(new NextRequest('http://localhost/projects/virtual/report/download'), { params: Promise.resolve({ projectId: 'virtual' }) });
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(spies.ai).not.toHaveBeenCalled();
    expect(spies.graph).not.toHaveBeenCalled();
    expect(spies.toc).not.toHaveBeenCalled();
    expect(spies.targets).not.toHaveBeenCalled();
    expect(spies.citation).not.toHaveBeenCalled();
  });

  it('저장 보고서 각주에 실제 사용된 지표·문단·지도 근거만 중복 없이 표시한다', async () => {
    const db = getDatabase();
    for (const [id, past] of [['unknown', null], ['past', true], ['current', false]] as const) {
      createDocument({ id, project_id: 'virtual', file_name: `${id}.docx`, file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, is_past_final_report: past, created_at: '2026-01-01' }, db);
    }
    db.prepare("INSERT INTO indicators (id, project_id, level, name, ovi, source_doc_id, created_at) VALUES ('report-indicator', 'virtual', '산출물', '가상 지표', '가상 성과', 'current', '2026-01-01')").run();
    db.prepare("INSERT INTO suggestions (id, indicator_id, verdict_status, proposal_text, created_at) VALUES ('confirmed-older-suggestion', 'report-indicator', '실현', '확정된 이전 제안', '2026-01-01')").run();
    db.prepare("INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES ('ordinary-paragraph', 'unknown', 1, '3쪽 2문단', '참여자들은 정기 교육을 진행했다.')").run();
    db.prepare("INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker) VALUES ('ordinary-evidence', 'confirmed-older-suggestion', '일반 문단에 있는 기존 저장 근거', 'unknown', '3쪽 2문단', '수행기관')").run();
    db.prepare("INSERT INTO suggestions (id, indicator_id, verdict_status, proposal_text, created_at) VALUES ('newer-unconfirmed-suggestion', 'report-indicator', '미확인', '더 최신이지만 미확인 제안', '2026-01-02')").run();
    db.prepare("INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker) VALUES ('newer-evidence', 'newer-unconfirmed-suggestion', '새 제안 근거', 'past', '4쪽', '수행기관')").run();
    db.prepare("INSERT INTO indicators (id, project_id, level, name, ovi, source_doc_id, created_at) VALUES ('unconfirmed-indicator', 'virtual', '산출물', '미확인 지표', '가상 성과', 'current', '2026-01-01')").run();
    db.prepare("INSERT INTO suggestions (id, indicator_id, verdict_status, created_at) VALUES ('unconfirmed-suggestion', 'unconfirmed-indicator', '실현', '2026-01-03')").run();
    db.prepare("INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker) VALUES ('unconfirmed-evidence', 'unconfirmed-suggestion', '미확정 지표 근거', 'past', '5쪽', '수행기관')").run();
    db.prepare("INSERT INTO confirmations (id, indicator_id, suggestion_id, confirmation_type, confirmer_name, created_at) VALUES ('report-confirmation', 'report-indicator', 'confirmed-older-suggestion', '확정', '가상 평가자', '2026-01-04')").run();
    db.prepare("INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor) VALUES ('saved-report-map', 'virtual', 'fake', '2025-01-01', 0, 0, 1, 1, 0, 0, 'test')").run();
    db.prepare("INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor) VALUES ('newer-map', 'virtual', 'fake', '2026-01-01', 0, 0, 0, 0, 0, 0, 'test')").run();
    db.prepare('INSERT INTO ontology_sources VALUES (?, ?, ?, ?)').run('saved-report-source', 'virtual', 'saved-report-map', JSON.stringify({ document_id: 'unknown' }));
    db.prepare('INSERT INTO ontology_snippets VALUES (?, ?, ?, ?)').run('saved-report-snippet', 'virtual', 'saved-report-map', JSON.stringify({ source: 'saved-report-source', quote: '저장 보고서 지도 근거' }));
    db.prepare('INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES (?, ?, 2, ?, ?)').run('saved-report-paragraph', 'past', '6쪽', '저장 보고서 개요 문단');
    db.prepare('INSERT INTO reports (id, project_id, content_json, created_at) VALUES (?, ?, ?, ?)').run('version-1', 'virtual', JSON.stringify({ ...savedDraft, footnotes: [
      { number: 1, evidence_id: 'ordinary-evidence' },
      { number: 2, evidence_id: 'paragraph-saved-report-paragraph' },
      { number: 3, evidence_id: 'saved-report-snippet' },
      { number: 4, evidence_id: 'ordinary-evidence' },
    ] }), '2026-01-01');
    const statements = vi.spyOn(db, 'prepare');
    spies.saved.mockReturnValue(savedDraft);
    const rendered = renderToStaticMarkup(await ReportPage({ params: Promise.resolve({ projectId: 'virtual' }) }));
    expect(rendered).toContain('과거 종료평가보고서 1개·과거 여부 미확인 1개 문서는 분석과 근거에서 빠집니다');
    expect(rendered).not.toContain('기존 보고서 근거');
    expect(statements.mock.calls.filter(([sql]) => /FROM reports WHERE id/i.test(sql))).toHaveLength(0);
    expect(statements.mock.calls.filter(([sql]) => /FROM\s+documents/i.test(sql))).toHaveLength(1);
    expect(statements.mock.calls.filter(([sql]) => /\b(ontology_nodes|ontology_snippets|evidences)\b/i.test(sql))).toHaveLength(0);
    expect(statements.mock.calls.filter(([sql]) => /\b(paragraphs|sentences)\b/i.test(sql))).toHaveLength(0);
  });

  it('검토·보고서 페이지의 문서 전용 제외 안내가 20ms 안이며 20k 지도 자료를 읽지 않는다', async () => {
    const db = getDatabase();
    for (let index = 0; index < 30; index++) {
      const id = `perf-${index}`;
      createDocument({ id, project_id: 'virtual', file_name: index === 0 ? '공통 금지 이름.docx' : `${id}.docx`, file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, is_past_final_report: index === 0 ? null : false, created_at: '2026-01-01' }, db);
    }
    db.prepare('INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES (?, ?, 1, ?, ?)').run('foreign-ban-paragraph', 'perf-1', '1쪽', '공통 금지 이름');
    db.prepare('INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned) VALUES (?, ?, ?, 1, ?, ?, 1)').run('foreign-ban', 'perf-1', 'foreign-ban-paragraph', '1쪽', '공통 금지 이름');
    db.prepare(`INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
      VALUES ('large-notice-map', 'virtual', 'fake', '2026-02-01', 20000, 0, 0, 20000, 0, 0, 'test')`).run();
    const insertNode = db.prepare('INSERT INTO ontology_nodes (id, project_id, import_id, node_type, title, data_json) VALUES (?, ?, ?, ?, ?, ?)');
    const insertSnippet = db.prepare('INSERT INTO ontology_snippets (id, project_id, import_id, data_json) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (let index = 0; index < 20_000; index++) {
        insertNode.run(`notice-node-${index}`, 'virtual', 'large-notice-map', 'output', `가상 노드 ${index}`, '{}');
        insertSnippet.run(`notice-snippet-${index}`, 'virtual', 'large-notice-map', '{}');
      }
    })();
    spies.saved.mockReturnValue(savedDraft);
    spies.review.mockReturnValue({ project: { id: 'virtual', name: '가상 사업' }, indicators: [], unreadableDocuments: [], latestConfirmerName: null });
    spies.notes.mockReturnValue({ importId: null, items: [] });

    const reportStatements = vi.spyOn(db, 'prepare');
    const reportStarted = performance.now();
    const rendered = renderToStaticMarkup(await ReportPage({ params: Promise.resolve({ projectId: 'virtual' }) }));
    expect(rendered).toContain('과거 여부 미확인 1개');
    expect(rendered).not.toContain('공통 금지 이름.docx');
    expect(performance.now() - reportStarted).toBeLessThanOrEqual(20);
    expect(reportStatements.mock.calls.filter(([sql]) => /FROM\s+documents/i.test(sql))).toHaveLength(1);
    expect(reportStatements.mock.calls.filter(([sql]) => /\b(paragraphs|sentences)\b/i.test(sql))).toHaveLength(0);
    expect(reportStatements.mock.calls.filter(([sql]) => /\b(ontology_nodes|ontology_snippets|evidences)\b/i.test(sql))).toHaveLength(0);

    reportStatements.mockClear();
    const reviewStarted = performance.now();
    const review = renderToStaticMarkup(await ReviewPage({ params: Promise.resolve({ projectId: 'virtual' }), searchParams: Promise.resolve({}) }));
    expect(review).toContain('과거 여부 미확인 1개 문서는 분석과 근거에서 빠집니다');
    expect(review).not.toContain('공통 금지 이름.docx');
    expect(performance.now() - reviewStarted).toBeLessThanOrEqual(20);
    expect(reportStatements.mock.calls.filter(([sql]) => /FROM\s+documents/i.test(sql))).toHaveLength(1);
    expect(reportStatements.mock.calls.filter(([sql]) => /FROM\s+sentences s[\s\S]*JOIN paragraphs p[\s\S]*JOIN documents d/i.test(sql))).toHaveLength(1);
    expect(reportStatements.mock.calls.filter(([sql]) => /\b(ontology_nodes|ontology_snippets|evidences)\b/i.test(sql))).toHaveLength(0);
  });

  it('기존 20k 문단·10개 금지 문장 포함 보고서 페이지 준비는 300ms 안이다', async () => {
    const db = getDatabase();
    for (let index = 0; index < 30; index++) {
      const id = `paragraph-perf-${index}`;
      createDocument({ id, project_id: 'virtual', file_name: index === 0 ? '금지 문장 표본 0.docx' : `${id}.docx`, file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, is_past_final_report: index === 0 ? null : false, created_at: '2026-01-01' }, db);
    }
    const insertParagraph = db.prepare('INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES (?, ?, ?, ?, ?)');
    const insertSentence = db.prepare('INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned) VALUES (?, ?, ?, 1, ?, ?, 1)');
    db.transaction(() => {
      for (let index = 0; index < 20_000; index++) {
        const documentId = `paragraph-perf-${index % 30}`;
        const paragraphId = `paragraph-perf-row-${index}`;
        insertParagraph.run(paragraphId, documentId, index, `${index}쪽`, `가상 문단 ${index}`);
        if (index < 10) insertSentence.run(`banned-perf-${index}`, documentId, paragraphId, `${index}쪽`, `금지 문장 표본 ${index}`);
      }
    })();
    spies.saved.mockReturnValue(savedDraft);
    const started = performance.now();
    const rendered = renderToStaticMarkup(await ReportPage({ params: Promise.resolve({ projectId: 'virtual' }) }));
    expect(rendered).toContain('과거 여부 미확인 1개');
    expect(rendered).not.toContain('금지 문장 표본 0.docx');
    expect(performance.now() - started).toBeLessThanOrEqual(300);
  }, 10_000);
});

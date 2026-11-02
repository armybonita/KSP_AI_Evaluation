import React from 'react';
import Database from 'better-sqlite3';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createDocument, createProject, getResultTocData, insertParagraphs } from './db';
import { CREATE_TABLES_SQL } from './schema';
import { getProjectOntologyGraph, replaceProjectOntology } from './ontology';
import { getConfirmedNoteCount, getFactorNoteStatuses, getNoteReviewData, saveNoteReview } from './note-review';
import { getReportTargetCount } from './report-input';
import { ResultTocClientView } from '@/app/projects/[projectId]/result/result-client-view';
import { ReportClientView } from '@/app/projects/[projectId]/report/report-client-view';
import { InitialTocTable } from '@/app/projects/[projectId]/ontology/ontology-views';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('가상 사업의 확정 노트', () => {
  it('지표 없이 요인만 확정해도 결과, 보고서와 경로에 표시한다', () => {
    vi.stubEnv('AIEAS_AI_PROVIDER', 'solar');
    const db = new Database(':memory:');
    try {
      db.exec(CREATE_TABLES_SQL);
      createProject({ id: 'virtual', name: '가상 사업', created_at: '2026-01-01' }, db);
      createDocument({ id: 'doc', project_id: 'virtual', file_name: '가상 자료', file_type: 'txt', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-01' }, db);
      insertParagraphs([{ id: 'para', document_id: 'doc', sequence_no: 1, location: '¶1', content: '가상의 기여 근거입니다.' }], db);
      const graph = { code: 'virtual', projectName: '가상 사업', project: {}, sources: { source: { title: '가상 자료', document_id: 'doc' } }, snippets: { snippet: { source: 'source', locator: '¶1', quote: '가상의 기여 근거입니다.', proves: ['factor'] } }, nodes: { factor: { type: 'enabler', title: '가상 요인', description: '가상 판단' }, target: { type: 'outcome-short', title: '가상 연결 성과' } }, edges: [{ source: 'factor', target: 'target', relation: 'promotes' }], reports: {}, report_status: {}, issues: [] };
      const imported = replaceProjectOntology('virtual', graph, '가상 시험', db);
      saveNoteReview('virtual', imported.id, 'factor', { status: '수정 후 확정', text: '확정한 가상 수정본', outcomeState: '관측됨', reason: '가상 사유', errorType: '기타' }, '가상 평가자', db);
      const data = getResultTocData('virtual', db)!;
      expect(data.indicatorConfirmedCount).toBe(0);
      expect(data.noteConfirmedCount).toBe(1);
      const result = renderToStaticMarkup(<ResultTocClientView initialData={data} exclusionSummary={{ unconfirmed: 0, past: 0 }} />);
      expect(result).toContain('노트 확정 1');
      expect(result).not.toContain('확정한 가상 수정본');
      expect(result).not.toContain('가상 연결 성과');
      const report = renderToStaticMarkup(<ReportClientView project={data.project} initialTargets={[]} initialDraft={null} initialConfirmedCount={getReportTargetCount('virtual', db)} initialNoteConfirmedCount={getConfirmedNoteCount('virtual', db)} />);
      expect(report).toContain('노트 확정 1');
      expect(report).not.toContain('확정한 판단이 없습니다');
      expect(renderToStaticMarkup(<InitialTocTable nodes={getProjectOntologyGraph('virtual', db).nodes} selectedId={null} onSelect={() => {}} noteItems={getFactorNoteStatuses('virtual', db)} />)).toContain('<span data-testid="toc-factor-name">가상 요인</span>: <span data-testid="toc-factor-status">수정 후 확정</span>');
    } finally { db.close(); vi.unstubAllEnvs(); }
  });



});

import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { CREATE_TABLES_SQL } from './schema';
import { getPortfolioPageData, getPortfolioSummaries, savePortfolioLevel } from './portfolio';
import { saveNoteReview } from './note-review';

// Synthetic workload: 200 projects, 100 current outcomes per project, and
// five review records per outcome. Every outcome has a real, eligible source
// and a verifiable quotation, so the timing includes the evidence gate.
function createWorkload(projectCount = 200, outcomesPerProject = 100, reviewsPerOutcome = 5) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_TABLES_SQL);
  const project = db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)');
  const imported = db.prepare(`INSERT INTO ontology_imports
    (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
    VALUES (?, ?, ?, ?, ?, 0, 1, ?, 0, 0, ?)`);
  const document = db.prepare(`INSERT INTO documents
    (id, project_id, file_name, file_type, status, doc_type, is_included, masked, approved_ai, is_past_final_report, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, 0, ?)`);
  const paragraph = db.prepare('INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES (?, ?, 1, ?, ?)');
  const source = db.prepare('INSERT INTO ontology_sources (id, project_id, import_id, data_json) VALUES (?, ?, ?, ?)');
  const snippet = db.prepare('INSERT INTO ontology_snippets (id, project_id, import_id, data_json) VALUES (?, ?, ?, ?)');
  const node = db.prepare('INSERT INTO ontology_nodes (id, project_id, import_id, node_type, title, data_json) VALUES (?, ?, ?, ?, ?, ?)');
  const key = db.prepare('INSERT INTO ontology_review_node_keys (project_id, import_id, node_id, node_type) VALUES (?, ?, ?, ?)');
  const review = db.prepare(`INSERT INTO ontology_note_reviews
    (id, project_id, import_id, node_id, status, text, original_text, outcome_state, reason, error_type, reviewer, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const date = '2026-01-01';
  const quote = '가상 사업의 성과가 확인된 문장입니다.';
  db.transaction(() => {
    for (let p = 0; p < projectCount; p++) {
      const projectId = `performance-project-${p}`;
      const importId = `performance-import-${p}`;
      const documentId = `performance-document-${p}`;
      const sourceId = `performance-source-${p}`;
      project.run(projectId, `가상 사업 ${p}`, date);
      imported.run(importId, projectId, 'fiction', date, outcomesPerProject, outcomesPerProject, 'fixture');
      document.run(documentId, projectId, '가상 문서', 'txt', '추출 완료', '기타', 'solar', date);
      paragraph.run(`performance-paragraph-${p}`, documentId, '가상 위치', quote);
      source.run(sourceId, projectId, importId, JSON.stringify({ document_id: documentId, title: '가상 자료' }));
      for (let n = 0; n < outcomesPerProject; n++) {
        const nodeId = `performance-outcome-${p}-${n}`;
        const snippetId = `performance-snippet-${p}-${n}`;
        const policy = n % 2 === 0;
        node.run(nodeId, projectId, importId, 'outcome-mid', '가상 성과', JSON.stringify({
          description: '가상 성과 설명',
          outcome_family: policy ? '협력국 정책 반영' : '개발협력 촉진',
          level: policy ? 'K4' : 'Lv3',
          outcome_state_ai: '관측됨',
          evidence: [snippetId],
        }));
        snippet.run(snippetId, projectId, importId, JSON.stringify({
          source: sourceId, locator: '가상 위치', quote, evidence_level: '관측', supports: [nodeId],
        }));
        key.run(projectId, importId, nodeId, 'outcome-mid');
        for (let h = 0; h < reviewsPerOutcome; h++) {
          review.run(`performance-review-${p}-${n}-${h}`, projectId, importId, nodeId,
            '확정', '가상 검토', '가상 원문', '관측됨', '', '', '가상 평가자', date);
        }
      }
    }
  })();
  return db;
}

describe('대규모 포트폴리오 성능', () => {
  it('문서의 현재 자격과 인용 변경을 상세와 전체 표에 같이 반영한다', () => {
    const db = createWorkload(1, 2, 1);
    try {
      const check = (eligible: boolean) => {
        const detail = getPortfolioPageData('performance-project-0', db)!;
        const summary = getPortfolioSummaries(1, 50, db).rows[0].summary!;
        expect(summary.knowledge).toEqual(detail.summary.knowledge);
        expect(summary.cooperation).toEqual(detail.summary.cooperation);
        if (eligible) {
          expect(summary.knowledge.level).toBe('K4');
          expect(summary.cooperation.level).toBe('Lv3');
        } else {
          expect(summary.knowledge).toEqual({ level: null, emptyReason: 'ineligible_evidence' });
          expect(summary.cooperation).toEqual({ level: null, emptyReason: 'ineligible_evidence' });
        }
      };
      check(true);
      for (const [column, ineligible, restored] of [
        ['is_included', 0, 1],
        ['masked', 0, 1],
        ['approved_ai', 'none', 'solar'],
        ['is_past_final_report', 1, 0],
        ['is_past_final_report', null, 0],
      ] as const) {
        const update = db.prepare(`UPDATE documents SET ${column}=? WHERE id=?`);
        update.run(ineligible, 'performance-document-0');
        expect(getPortfolioSummaries(1, 50, db).rows[0].summary).toBeNull();
        check(false);
        update.run(restored, 'performance-document-0');
        check(true);
      }
      const updateParagraph = db.prepare('UPDATE paragraphs SET content=? WHERE id=?');
      updateParagraph.run('인용과 다른 가상의 새로운 문장입니다.', 'performance-paragraph-0');
      expect(getPortfolioSummaries(1, 50, db).rows[0].summary).toBeNull();
      check(false);
      updateParagraph.run('가상 사업의 성과가 확인된 문장입니다.', 'performance-paragraph-0');
      check(true);
    } finally {
      db.close();
    }
  });

  it('단계 저장과 검토 확정 변경 뒤에는 해당 사업 스냅샷이 즉시 갱신된다', () => {
    const db = createWorkload(1, 2, 1);
    try {
      expect(getPortfolioSummaries(1, 50, db).rows[0].summary).toBeNull();
      getPortfolioPageData('performance-project-0', db);
      savePortfolioLevel('performance-project-0', 'performance-import-0', 'performance-outcome-0-0', 'K3', '가상 평가자', db);
      expect(getPortfolioSummaries(1, 50, db).rows[0].summary?.knowledge.level).toBe('K3');
      const input = { status: '수정 중', text: '가상 검토', outcomeState: '관측됨', reason: '가상 사유', errorType: '기타' };
      saveNoteReview('performance-project-0', 'performance-import-0', 'performance-outcome-0-0', input, '가상 평가자', db);
      expect(getPortfolioSummaries(1, 50, db).rows[0].summary?.knowledge.emptyReason).toBe('no_confirmed_outcomes');
      saveNoteReview('performance-project-0', 'performance-import-0', 'performance-outcome-0-0', { ...input, status: '확정' }, '가상 평가자', db);
      expect(getPortfolioSummaries(1, 50, db).rows[0].summary?.knowledge.level).toBe('K3');
    } finally {
      db.close();
    }
  });

  it('사업 상세와 전체 표를 각각 제한 시간에 준비한다', () => {
    const db = createWorkload();
    try {
      const detailStart = performance.now();
      const detail = getPortfolioPageData('performance-project-0', db);
      const detailMs = performance.now() - detailStart;
      db.prepare(`INSERT OR REPLACE INTO ontology_portfolio_snapshots
        (project_id, knowledge_level, cooperation_level, quadrant, knowledge_empty_reason, cooperation_empty_reason, calculated_at, input_revision)
        SELECT p.id, 'K4', 'Lv3', '확장 및 선도형 (1사분면)', NULL, NULL, '2026-01-01', r.revision
        FROM projects p JOIN report_input_revisions r ON r.project_id=p.id`).run();
      const summaryStart = performance.now();
      const summaries = getPortfolioSummaries(1, 50, db);
      const summaryMs = performance.now() - summaryStart;
      console.info(`가상 사업 200·성과 20000·검토 100000: 상세 ${detailMs.toFixed(1)}ms, 전체 ${summaryMs.toFixed(1)}ms`);
      expect(detail?.outcomes).toHaveLength(100);
      expect(detail?.summary.knowledge.level).toBe('K4');
      expect(detail?.summary.cooperation.level).toBe('Lv3');
      expect(summaries.rows).toHaveLength(50);
      expect(summaries.hasNext).toBe(true);
      expect(summaries.rows.every((row) => row.summary?.knowledge.level === 'K4' && row.summary?.cooperation.level === 'Lv3')).toBe(true);
      expect(getPortfolioSummaries(4, 50, db).hasNext).toBe(false);
      expect(detailMs).toBeLessThanOrEqual(200);
      expect(summaryMs).toBeLessThanOrEqual(50);
    } finally {
      db.close();
    }
  }, 120_000);
});

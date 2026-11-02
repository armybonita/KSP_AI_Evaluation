import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import type { AiClient } from '../ai';
import { createConfirmation, createDocument, createIndicator, createProject, getReportTargets, insertParagraphs, insertSentences, saveIndicatorAttribution, saveReportDraft, saveSuggestion, updateDocumentAiMetadata } from './db';
import { CREATE_TABLES_SQL } from './schema';
import { getNoteReviewData, saveNoteReview } from './note-review';
import { getProjectOntologyEvidenceSource, listProjectOntologyEvidence, replaceProjectOntology } from './ontology';
import { generateReportDocx } from '../report/docx';
import { computeJudgmentFingerprint, createReportDraft, getSavedReportDraftWithStatus } from '../report/service';
import { buildReportSections } from '../report/templates';
import type { ReportSection } from '../report/types';

const quote = '가상 교육 참여자는 5명으로 기록되었다. N+1 이후 확인 예정이다.';
const forbidden = '비공개 면담 내용은 외부 공개를 금지한다.';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_TABLES_SQL);
  createProject({ id: 'virtual', name: 'EIPP 가상 사업', created_at: '2026-01-01' }, db);
  createDocument({ id: 'doc', project_id: 'virtual', file_name: '가상 근거.docx', file_type: 'docx', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-01' }, db);
  insertParagraphs([
    { id: 'para', document_id: 'doc', sequence_no: 1, location: '¶1', content: quote },
    { id: 'ban-para', document_id: 'doc', sequence_no: 2, location: '¶2', content: forbidden },
    { id: 'overview-country', document_id: 'doc', sequence_no: 3, location: '¶3', content: '협력국: 가상 협력국' },
    { id: 'overview-ministry', document_id: 'doc', sequence_no: 4, location: '¶4', content: '협력부처: 가상 부처' },
    { id: 'overview-budget', document_id: 'doc', sequence_no: 5, location: '¶5', content: '사업예산: 가상 예산' },
  ], db);
  insertSentences([{ id: 'ban', document_id: 'doc', paragraph_id: 'ban-para', sequence_no: 1, location: '¶2', content: forbidden, is_citation_banned: 1 }], db);
  for (const [id, name, confirmation] of [['approved', '가상 확정 지표', '확정'], ['human', '가상 수정 지표', '수정 후 확정'], ['excluded', '가상 채택 제외 표식', '채택 제외']] as const) {
    createIndicator({ id, project_id: 'virtual', name, level: '활동', ovi: '가상 목표', mov: null, target_value: '5명', source_doc_id: 'doc', is_baseline: 0, created_at: '2026-01-01' }, db);
    saveSuggestion({ id: `suggestion-${id}`, indicator_id: id, verdict_status: '실현', error_reason: null, proposal_text: '가상 평가 문장', created_at: '2026-01-01' }, [{ id: `evidence-${id}`, suggestion_id: `suggestion-${id}`, quote, document_id: 'doc', location: '¶1', speaker: '수행기관', is_citation_banned: 0 }], db);
    createConfirmation({ indicator_id: id, confirmation_type: confirmation, confirmer_name: '가상 평가자', ...(confirmation === '수정 후 확정' ? { edited_text: '평가자가 확정한 가상 서술.', reason: '가상 사유' } : {}) }, db);
  }
  saveIndicatorAttribution('virtual', 'approved', '가상 협력이 성과에 기여했다.', db);
  const nodes = {
    outcome: { type: 'outcome-mid', title: '가상 성과 노드', description: '가상 성과 판단', outcome_family: '개발협력', level_ai: '4', confidence_ai: '높음' },
    factor: { type: 'enabler', title: '가상 기여요인', description: '가상 기여 판단' },
    constraint: { type: 'constraint', title: '가상 제약요인', description: '가상 제약 판단' },
    excludedNode: { type: 'outcome-short', title: '가상 제외 노드 표식', description: '가상 제외 판단' },
  };
  const graph = {
    code: 'virtual', projectName: 'EIPP 가상 사업', project: {},
    sources: { source: { title: '가상 근거.docx', document_id: 'doc' } },
    snippets: { snippet: { source: 'source', locator: '¶1', quote, evidence_level: '입증', speaker: '수행기관', proves: Object.keys(nodes) } },
    nodes, edges: [], reports: {}, report_status: {}, issues: [],
  };
  const imported = replaceProjectOntology('virtual', graph, '가상 시험', db);
  for (const [id, node] of Object.entries(nodes)) {
    saveNoteReview('virtual', imported.id, id, {
      status: id === 'excludedNode' ? '채택 제외' : '확정', text: node.description,
      outcomeState: '관측됨', reason: id === 'excludedNode' ? '가상 제외 사유' : '',
      errorType: id === 'excludedNode' ? '기타' : '',
    }, '가상 평가자', db);
  }
  return db;
}

function flatten(sections: ReportSection[]): ReportSection[] {
  return sections.flatMap((section) => [section, ...flatten(section.children ?? [])]);
}

describe('저장 초안 근거 및 Word 통합', () => {
  it('구형 초안의 지문이 과거 보고서 지정으로 달라지면 원본 각주를 반환하지 않는다', async () => {
    const db = setup();
    try {
      const aiClient = { provider: 'solar', generateReportDraft: vi.fn(async () => ({ meta: { duration_ms: 1 }, report: { sentences: [] } })) } as unknown as AiClient;
      const draft = await createReportDraft('virtual', { db, aiClient });
      delete draft.summary_format;
      draft.version = 2;
      draft.fingerprint = computeJudgmentFingerprint('virtual', db, getReportTargets('virtual', db));
      draft.footnotes = [{ number: 1, evidence_id: 'evidence-approved', document_id: 'doc', quote }];
      const record = saveReportDraft('virtual', JSON.stringify(draft), db);
      expect(getSavedReportDraftWithStatus('virtual', db, undefined, undefined, record.id).isOutdated).toBe(false);
      db.prepare('UPDATE documents SET is_past_final_report = 1 WHERE id = ?').run('doc');
      const stale = getSavedReportDraftWithStatus('virtual', db, undefined, undefined, record.id);
      expect(stale).toMatchObject({ draft: { version: 2, footnotes: [] }, isOutdated: true });
      expect(JSON.stringify(stale.draft)).not.toContain(quote);
      expect((db.prepare('SELECT content_json FROM reports WHERE id = ?').get(record.id) as { content_json: string }).content_json).toContain(quote);
    } finally { db.close(); }
  });

  it('과거 보고서로 변경하면 저장된 근거와 각주를 숨기고 원본 행은 보존한다', async () => {
    const db = setup();
    try {
      createDocument({ id: 'safe-doc', project_id: 'virtual', file_name: '가상 정상 자료.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-01' }, db);
      insertParagraphs([{ id: 'safe-para', document_id: 'safe-doc', sequence_no: 1, location: '¶1', content: '가상 정상 자료의 근거 문장입니다.' }], db);
      const importId = getNoteReviewData('virtual', db).importId!;
      db.prepare('INSERT INTO ontology_sources VALUES (?, ?, ?, ?)').run('safe-source', 'virtual', importId, JSON.stringify({ document_id: 'safe-doc', title: '가상 정상 자료', evidence_metadata: { 'safe-snippet': { proves: ['outcome'], evidence_level: '입증' } } }));
      db.prepare('INSERT INTO ontology_snippets VALUES (?, ?, ?, ?)').run('safe-snippet', 'virtual', importId, JSON.stringify({ source: 'safe-source', locator: '¶1', quote: '가상 정상 자료의 근거 문장입니다.' }));
      const aiClient = { provider: 'solar', generateReportDraft: vi.fn(async (messages: Array<{ role: string; content: string }>) => {
        const input = JSON.parse(messages.find(message => message.role === 'user')!.content);
        const node = input.indicators?.[0];
        return { meta: { duration_ms: 1 }, report: { sentences: node ? [{ indicator_id: node.id, sentence: '가상 성과에 관한 제안이다.', evidence_ids: [node.evidences[0].id] }] : [] } };
      }) } as unknown as AiClient;
      expect(listProjectOntologyEvidence('virtual', db).evidence.map(e => e.id)).toContain('snippet');
      expect(getProjectOntologyEvidenceSource('virtual', 'snippet', db)).not.toBeNull();
      expect(getNoteReviewData('virtual', db).items.find(item => item.id === 'outcome')?.evidence).toHaveLength(2);
      const draft = await createReportDraft('virtual', { db, aiClient, template: 'eipp' });
      expect(draft.footnotes?.some(note => note.evidence_id === 'snippet')).toBe(true);

      db.prepare('UPDATE documents SET is_past_final_report = 1 WHERE id = ?').run('doc');
      const evidence = listProjectOntologyEvidence('virtual', db);
      expect(evidence.evidence.map(item => item.id)).toEqual(['safe-snippet']);
      expect(evidence.statements.find(statement => statement.id === 'factor')?.evidenceIds).toEqual([]);
      expect(getProjectOntologyEvidenceSource('virtual', 'snippet', db)).toBeNull();
      expect(getNoteReviewData('virtual', db).items.find(item => item.id === 'factor')?.evidence).toEqual([]);
      expect(getNoteReviewData('virtual', db).items.find(item => item.id === 'outcome')?.evidence.map(item => item.id)).toEqual(['safe-snippet']);
      const saved = getSavedReportDraftWithStatus('virtual', db);
      expect(saved.isOutdated).toBe(true);
      expect(saved.draft?.footnotes).toEqual([]);
      const next = await createReportDraft('virtual', { db, aiClient, template: 'eipp' });
      expect(next.footnotes?.some(note => note.evidence_id === 'snippet')).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_snippets WHERE id = ?').get('snippet')).toEqual({ n: 1 });

      // 과거 여부 미확인 + 종료평가보고서 종류는 과거 보고서로 보고 가린다.
      db.prepare("UPDATE documents SET is_past_final_report = NULL, doc_type = '종료평가보고서' WHERE id = ?").run('doc');
      expect(listProjectOntologyEvidence('virtual', db).evidence.map(item => item.id)).toEqual(['safe-snippet']);
      // 사람이 '이번 사업의 자료'로 정하면 종류가 종료평가보고서여도 보인다.
      db.prepare("UPDATE documents SET is_past_final_report = 0 WHERE id = ?").run('doc');
      expect(listProjectOntologyEvidence('virtual', db).evidence.map(e => e.id)).toContain('snippet');
      db.prepare("UPDATE documents SET doc_type = '성과관리표' WHERE id = ?").run('doc');
      expect(listProjectOntologyEvidence('virtual', db).evidence.map(e => e.id)).toContain('snippet');
    } finally { db.close(); }
  });

  it('허용 근거만 수용하고 출처·목차·각주를 실제 Word에 기록한다', async () => {
    const db = setup();
    try {
      const generateReportDraft = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
        const input = JSON.parse(messages.find((message) => message.role === 'user')!.content);
        if (input.section) {
          const node = input.indicators[0];
          const text = input.section === 'eipp-monitoring' ? 'N+1 이후 가상 성과 추이를 확인한다.'
            : input.section === 'eipp-factors' ? '가상 기여요인에 관한 제안이다.'
            : input.section === 'eipp-constraints' ? '가상 제약요인에 관한 제안이다.'
              : input.section === 'eipp-lessons' ? '가상 교훈 후보를 검토할 필요가 있다.'
                : '가상 성과에 관한 제안이다.';
          return { meta: { duration_ms: 1 }, report: { sentences: [
            { indicator_id: node.id, sentence: text, evidence_ids: [node.evidences[0].id] },
            { indicator_id: node.id, sentence: '근거 없는 노드 문장.', evidence_ids: [] },
            { indicator_id: node.id, sentence: '외부 노드 근거 문장.', evidence_ids: [node.evidences[0].id, 'unapproved'] },
            { indicator_id: node.id, sentence: '참여자는 7명이다.', evidence_ids: [node.evidences[0].id] },
            { indicator_id: node.id, sentence: forbidden, evidence_ids: [node.evidences[0].id] },
            { indicator_id: 'excludedNode', sentence: '가상 제외 노드 표식', evidence_ids: [node.evidences[0].id] },
          ] } };
        }
        return { meta: { duration_ms: 1 }, report: { sentences: [
        { indicator_id: 'approved', sentence: '가상 교육 참여자는 5명이다.', evidence_ids: ['evidence-approved'] },
        { indicator_id: 'approved', sentence: '근거 없는 가상 문장.', evidence_ids: [] },
        { indicator_id: 'approved', sentence: '외부 근거를 섞은 가상 문장.', evidence_ids: ['evidence-approved', 'unapproved'] },
        { indicator_id: 'approved', sentence: '가상 교육 참여자는 7명이다.', evidence_ids: ['evidence-approved'] },
        { indicator_id: 'approved', sentence: forbidden, evidence_ids: ['evidence-approved'] },
        { indicator_id: 'excluded', sentence: '가상 채택 제외 표식', evidence_ids: ['evidence-excluded'] },
        ] } };
      });
      const aiClient = { provider: 'solar', generateReportDraft } as unknown as AiClient;
      const draft = await createReportDraft('virtual', { db, aiClient, template: 'eipp' });
      expect(generateReportDraft).toHaveBeenCalled();
      const serialized = JSON.stringify(draft);
      expect(serialized).toContain('가상 교육 참여자는 5명이다.');
      for (const value of ['근거 없는 가상 문장', '외부 근거를 섞은 가상 문장', '근거 없는 노드 문장', '외부 노드 근거 문장', '7명이다', forbidden, '가상 채택 제외 표식', '가상 제외 노드 표식']) expect(serialized).not.toContain(value);
      const sections = flatten(draft.report_sections ?? []);
      const ids = sections.map((section) => section.id);
      let previous = -1;
      for (const id of ['eipp-overview', 'eipp-results', 'eipp-indicators', 'eipp-analysis', 'eipp-financing', 'eipp-policy', 'eipp-trade', 'eipp-incidental', 'eipp-factors', 'eipp-constraints', 'eipp-lessons', 'eipp-monitoring', 'eipp-evaluation']) {
        const index = ids.indexOf(id);
        expect(index).toBeGreaterThan(previous);
        previous = index;
      }
      const sources = new Set(sections.flatMap((section) => [section.source, ...(section.sentences ?? []).map((sentence) => sentence.source), ...(section.table?.rows ?? []).flat().map((cell) => cell.source)]).filter(Boolean));
      expect(sources).toEqual(new Set(['human', 'ai', 'document', 'missing']));
      const overview = sections.find((section) => section.id === 'eipp-overview')!;
      const overviewRows = overview.table!.rows;
      expect(overviewRows.find((row) => row[0].text === '협력국·협력부처')?.[1]).toEqual(expect.objectContaining({ text: '가상 협력국 / 가상 부처', source: 'document' }));
      expect(overviewRows.find((row) => row[0].text === '사업예산')?.[1].text).toContain('※ 확인 필요');
      const financing = sections.find((section) => section.id === 'eipp-financing')!;
      expect(financing.title).toContain('outcome (개발협력 Lv4 제안, 신뢰도 높음 제안)');
      const monitoring = sections.find((section) => section.id === 'eipp-monitoring')!;
      expect(monitoring.title).toBe('향후 성과 모니터링 계획');
      expect(monitoring.table?.rows[0][0].text).toBe('N+1');
      for (const [id, expected] of [['eipp-financing', '가상 성과에 관한 제안이다.'], ['eipp-factors', '가상 기여요인에 관한 제안이다.'], ['eipp-constraints', '가상 제약요인에 관한 제안이다.'], ['eipp-lessons', '가상 교훈 후보를 검토할 필요가 있다.']] as const) {
        expect(sections.find((section) => section.id === id)?.sentences).toContainEqual(expect.objectContaining({ sentence: expected, source: 'ai', evidence_ids: ['snippet'] }));
      }
      const saved = db.prepare('SELECT content_json FROM reports WHERE project_id = ? ORDER BY rowid DESC LIMIT 1').get('virtual') as { content_json: string };
      expect(JSON.parse(saved.content_json).footnotes.length).toBeGreaterThan(0);
      const zip = await JSZip.loadAsync(await generateReportDocx(draft));
      const body = await zip.file('word/document.xml')!.async('text');
      const footnotes = await zip.file('word/footnotes.xml')!.async('text');
      expect(body).toContain('가상 교육 참여자는 5명이다.');
      for (const value of ['가상 성과에 관한 제안이다.', '가상 기여요인에 관한 제안이다.', '가상 제약요인에 관한 제안이다.', '가상 교훈 후보를 검토할 필요가 있다.']) expect(body).toContain(value);
      expect(body).toContain('AI 제안');
      expect(body).toContain('문서 원문');
      expect(body).toContain('T 종료평가보고서 EIPP');
      expect(body).toContain('사람 확정');
      expect(body).toContain('근거 미확보');
      expect(body).toContain('footnoteReference');
      expect(footnotes).toContain('가상 근거.docx');
      expect(footnotes).not.toContain('paragraph-overview-country');
      expect(footnotes).not.toContain('snippet');
      for (const value of ['근거 없는 가상 문장', '외부 근거를 섞은 가상 문장', '근거 없는 노드 문장', '외부 노드 근거 문장', '7명이다', forbidden, '가상 채택 제외 표식', '가상 제외 노드 표식']) expect(body).not.toContain(value);
    } finally {
      db.close();
    }
  });

  it('보고서 뒤 절 요청 전에 자격 변경을 발견하면 초안 전체를 실패시키고 저장하지 않는다', async () => {
    const db = setup();
    try {
      const calls: Array<Array<{ role: string; content: string }>> = [];
      const generateReportDraft = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
        calls.push(messages);
        const input = JSON.parse(messages.find((message) => message.role === 'user')!.content);
        const indicator = input.indicators?.[0];
        if (calls.length === 2) {
          // The first summary section has been sent; invalidate its source while
          // the response is in flight. The next section must not be sent.
          updateDocumentAiMetadata('virtual', 'doc', { is_past_final_report: null }, db);
        }
        return { meta: { duration_ms: 1 }, report: { sentences: indicator ? [{ indicator_id: indicator.id, sentence: '가상 성과에 관한 제안이다.', evidence_ids: [indicator.evidences?.[0]?.id ?? 'evidence-approved'] }] : [] } };
      });
      const aiClient = { provider: 'solar', generateReportDraft } as unknown as AiClient;
      await expect(createReportDraft('virtual', { db, aiClient, template: 'eipp' })).rejects.toMatchObject({
        message: '자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요',
      });

      expect(generateReportDraft).toHaveBeenCalledTimes(2);
      expect(calls.map((messages) => JSON.parse(messages.find((message) => message.role === 'user')!.content).section).filter(Boolean)).toEqual(['eipp-financing']);
      expect(db.prepare('SELECT COUNT(*) AS n FROM reports WHERE project_id = ?').get('virtual')).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('KSP 개요에 빈 하위 절을 중복 생성하지 않는다', () => {
    const sections = flatten(buildReportSections('ksp', [], [], []));
    expect(sections.some((section) => ['ksp-country', 'ksp-implementation', 'ksp-other'].includes(section.id))).toBe(false);
    expect(sections.some((section) => section.id === 'ksp-project')).toBe(true);
  });
});

import { confirmNoteLink, rejectNoteLink, getNoteReviewData, saveNoteReview } from './note-review';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AiClient } from '@/server/ai/client';
import type { OntologyGenerationResponse } from '../ontology/generator-types';
import { createDocument, createProject, insertParagraphs, markInterruptedOntologyRunsFailed } from '@/server/store/db';
import type { DocumentRecord } from '@/server/store/types';
import { CREATE_TABLES_SQL } from '@/server/store/schema';
import { getActiveGenerationRun, getGenerationRun, startGenerationRun, updateGenerationRun } from '../ontology/generation-store';
import { getProjectOntology, getProjectOntologyGraph, listProjectOntologyEvidence, replaceProjectOntology } from '../ontology/store';
import { generateProjectOntology } from '../ontology/generator';
import { checkOntologyGraph } from '../ontology/checker';
import type { OntologyGraph } from '../ontology/types';
import { finalizeFailedGenerationRun, finishGenerationRun, generationResultJson, shouldPreserveOntology } from '../ontology/generation-service';
import { safeOntologyError } from '../ontology/error-safety';
import { AiEligibilityChangedError } from '../documents/eligibility-fingerprint';

const stage3Fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'fixtures', 'w17-stage3', 'source-document.json'), 'utf8')) as {
  paragraphs: Array<{ location: string; content: string }>;
  quote: string;
  manualSentence: string;
};

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_TABLES_SQL);
  createProject({ id: 'project-a', name: '가상 사업 A', created_at: '2026-10-30' }, db);
  createProject({ id: 'project-b', name: '가상 사업 B', created_at: '2026-10-30' }, db);
  return db;
}

function addDocument(db: Database.Database, id: string, projectId: string, content = '가상 기관은 3건의 교육을 진행했다.', included = true, status: DocumentRecord['status'] = '추출 완료', eligibility: { masked: boolean; approved_ai: string; is_past_final_report: boolean | null } = { masked: true, approved_ai: 'solar', is_past_final_report: false }) {
  const doc: DocumentRecord = { id, project_id: projectId, file_name: `${id}.docx`, file_type: 'docx', status, doc_type: '사업계획서', is_included: included ? 1 : 0, excluded_reason: null, ...eligibility, created_at: id };
  createDocument(doc, db);
  insertParagraphs([{ id: `${id}-p1`, document_id: id, sequence_no: 1, location: '¶1', content }], db);
}

function response(name = '가상 교육 활동'): OntologyGenerationResponse {
  return {
    snippets: [{ paragraph_id: 'replace-p1', quote: '가상 기관은 3건의 교육을 진행했다.', speaker: '수행기관', evidence_kind: '활동결과보고서', evidence_level: '관측', category: '산출물', fact: '교육 3건 진행', interpretation: '', uncertainty: '', observed_date: '', proves_indices: [0], supports_indices: [], contradicts_indices: [] }],
    nodes: [{ type: 'activity', name, description: '교육 3건 진행', evidence_indices: [0], outcome_family: '', outcome_type: '', outcome_state_ai: '미확인', timing: '', pdm_stage: '', factor_scope: '', factor_class: '', response: '', output_type: '', institution_type: '', date_start: '', date_end: '', place: '', baseline: null, target: null, actual: null, verification_source: '' }],
    edges: [],
  };
}

function finish(result: Parameters<typeof finishGenerationRun>[1], db: Database.Database) {
  const run = startGenerationRun('project-a', 1, db)!;
  finishGenerationRun('project-a', result, 'tester', run.id, db);
  return getGenerationRun(run.id, db)!;
}

describe('uploaded document ontology generation', () => {
  it('E2E 모드의 기본 분석은 외부 호출 없이 가짜 AI를 사용한다', async () => {
    const db = database();
    const previous = process.env.AIEAS_E2E_FAKE_AI;
    const network = vi.fn(() => { throw new Error('외부 호출 금지'); });
    try {
      addDocument(db, 'fake-doc', 'project-a');
      process.env.AIEAS_E2E_FAKE_AI = '1';
      vi.stubGlobal('fetch', network);
      const result = await generateProjectOntology('project-a', { db });
      expect(result.documentSuccessCount).toBe(1);
      expect(Object.values(result.graph.nodes).map((node) => node.type)).toContain('outcome-short');
      expect(network).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.AIEAS_E2E_FAKE_AI;
      else process.env.AIEAS_E2E_FAKE_AI = previous;
      vi.unstubAllGlobals();
      db.close();
    }
  });

  it('reuses quote checks and invalidates them when the source paragraph changes', async () => {
    const db = database();
    addDocument(db, 'a-doc', 'project-a');
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return { ...response(), snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }] };
    } } });
    finish(result, db);
    const first = listProjectOntologyEvidence('project-a', db);
    expect(first.evidence[0].quoteStatus).toBe('verified');
    const cached = db.prepare('SELECT input_hash FROM ontology_quote_verification_cache_v3').get() as { input_hash: string };
    expect(listProjectOntologyEvidence('project-a', db)).toEqual(first);
    expect(db.prepare('SELECT input_hash FROM ontology_quote_verification_cache_v3').get()).toEqual(cached);
    db.prepare('UPDATE paragraphs SET content = ? WHERE id = ?').run('완전히 다른 가상 문단입니다.', 'a-doc-p1');
    const changed = listProjectOntologyEvidence('project-a', db);
    expect(changed.evidence[0].quoteStatus).toBe('unverified');
    expect((db.prepare('SELECT input_hash FROM ontology_quote_verification_cache_v3').get() as { input_hash: string }).input_hash).not.toBe(cached.input_hash);
    db.close();
  });

  it('preserves the stored ontology when all document chunks fail and replaces it after partial success', async () => {
    const db = database();
    addDocument(db, 'a-doc', 'project-a');
    const success = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return { ...response('기존 활동'), snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }] };
    } } });
    expect(finish(success, db).state).toBe('completed');
    const before = getProjectOntology('project-a', db);
    const beforeGraph = getProjectOntologyGraph('project-a', db);
    const beforeEvidence = listProjectOntologyEvidence('project-a', db);
    expect(beforeGraph.nodes).toContainEqual(expect.objectContaining({ title: '기존 활동' }));
    expect(beforeEvidence.evidence).toHaveLength(1);

    const failed = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async () => { throw new Error('dummy'); } } });
    expect(Object.keys(failed.graph.sources)).toHaveLength(1);
    expect(failed.documentSuccessCount).toBe(0);
    expect(failed.documentFailureCount).toBe(1);
    expect(Object.keys(failed.graph.nodes)).toHaveLength(0);
    expect(Object.keys(failed.graph.snippets)).toHaveLength(0);
    const failedRun = finish(failed, db);
    expect(failedRun.state).toBe('failed');
    expect(failedRun.error_message).toContain('기존 온톨로지를 보존');
    expect(failedRun.error_message).toContain(`문서 a-doc: ${failed.failedDocuments[0].reason}`);
    expect(JSON.parse(failedRun.result_json!).ontologyPreserved).toBe(true);
    expect(getProjectOntology('project-a', db)).toEqual(before);
    expect(getProjectOntologyGraph('project-a', db)).toEqual(beforeGraph);
    expect(listProjectOntologyEvidence('project-a', db)).toEqual(beforeEvidence);
    expect(JSON.parse(generationResultJson(failed)).ontologyPreserved).toBe(true);

    addDocument(db, 'b-fail', 'project-a');
    const partial = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { document: { id: string }; paragraphs: Array<{ id: string }> };
      if (input.document.id === 'b-fail') throw new Error('dummy');
      return { ...response('새 활동'), snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }] };
    } } });
    expect(partial.documentSuccessCount).toBe(1);
    expect(partial.documentFailureCount).toBe(1);
    expect(shouldPreserveOntology(partial)).toBe(false);
    expect(finish(partial, db).state).toBe('completed');
    expect(getProjectOntology('project-a', db)).not.toEqual(before);
    expect(getProjectOntologyGraph('project-a', db).nodes).toContainEqual(expect.objectContaining({ title: '새 활동' }));
    expect(JSON.parse(generationResultJson(partial)).ontologyPreserved).toBe(false);
    db.close();
  });

  it('preserves the stored ontology when success count, nodes, or snippets are empty', async () => {
    const db = database();
    addDocument(db, 'a-doc', 'project-a');
    const success = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return { ...response(), snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }] };
    } } });
    finish(success, db);
    const before = getProjectOntology('project-a', db);
    for (const result of [
      { ...success, documentSuccessCount: 0 },
      { ...success, graph: { ...success.graph, nodes: {} } },
      { ...success, graph: { ...success.graph, snippets: {} } },
    ]) {
      expect(shouldPreserveOntology(result)).toBe(true);
      const run = finish(result, db);
      expect(run.state).toBe('failed');
      expect(getProjectOntology('project-a', db)).toEqual(before);
      expect(JSON.parse(generationResultJson(result)).ontologyPreserved).toBe(true);
    }
    db.close();
  });

  it.each(['outcome-short', 'outcome-mid'] as const)('normalizes an empty %s AI outcome state to unknown', async (type) => {
    const db = database();
    addDocument(db, 'a-doc', 'project-a');
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }],
        nodes: [{ ...response().nodes[0], type, outcome_state_ai: '' }], edges: [],
      };
    } } });
    expect(Object.values(result.graph.nodes)).toHaveLength(1);
    expect(Object.values(result.graph.nodes)[0].outcome_state_ai).toBe('미확인');
    db.close();
  });

  it('lists every eligibility failure for selected documents without sending them to AI', async () => {
    const db = database();
    addDocument(db, 'a-ineligible', 'project-a', undefined, true, '읽지 못함', { masked: false, approved_ai: 'none', is_past_final_report: true });
    addDocument(db, 'b-unread', 'project-a', undefined, true, '읽지 못함');
    const generateOntology = vi.fn();
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology } });
    expect(generateOntology).not.toHaveBeenCalled();
    expect(result.excludedDocuments).toEqual([{ documentId: 'a-ineligible', reasons: ['개인정보 마스킹 미완료', 'AI 사용 미승인', '과거 종료평가보고서'] }]);
    expect(result.failedDocuments).toEqual([{ documentId: 'b-unread', reason: '문서 추출이 완료되지 않음' }]);
    db.close();
  });

  it('sends only confirmed non-past document paragraphs to the AI client', async () => {
    const db = database();
    addDocument(db, 'allowed', 'project-a', '허용 가상 문단');
    addDocument(db, 'unknown', 'project-a', '미확인 고유 문단', true, '추출 완료', { masked: true, approved_ai: 'solar', is_past_final_report: null });
    addDocument(db, 'past', 'project-a', '과거 고유 문단', true, '추출 완료', { masked: true, approved_ai: 'solar', is_past_final_report: true });
    const generateOntology = vi.fn(async () => ({ snippets: [], nodes: [], edges: [] }));
    await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology } });
    expect(generateOntology).toHaveBeenCalled();
    const input = JSON.stringify(generateOntology.mock.calls);
    expect(input).toContain('허용 가상 문단');
    expect(input).not.toContain('미확인 고유 문단');
    expect(input).not.toContain('과거 고유 문단');
    db.close();
  });

  it('counts a confirmed empty document as a failure', async () => {
    const db = database();
    addDocument(db, 'empty', 'project-a');
    db.prepare('DELETE FROM paragraphs WHERE document_id = ?').run('empty');
    const generateOntology = vi.fn();
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology } });
    expect(generateOntology).not.toHaveBeenCalled();
    expect(result.failedDocuments).toEqual([{ documentId: 'empty', reason: '추출된 문단이 없음' }]);
    expect(result.failureKinds).toEqual({});
    expect(result.documentFailureCount).toBe(1);
    expect(result.documentSuccessCount).toBe(0);
    db.close();
  });

  it('aborts the whole ontology run when eligibility changes before the next chunk', async () => {
    const db = database();
    addDocument(db, 'changing', 'project-a');
    db.prepare('DELETE FROM paragraphs WHERE document_id = ?').run('changing');
    insertParagraphs(Array.from({ length: 61 }, (_, index) => ({ id: `changing-p${index}`, document_id: 'changing', sequence_no: index + 1, location: `¶${index + 1}`, content: `가상 문단 ${index}` })), db);
    let releaseFirst!: () => void;
    const generateOntology = vi.fn(async () => {
      if (generateOntology.mock.calls.length === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
      return { snippets: [], nodes: [], edges: [] };
    });
    const pending = generateProjectOntology('project-a', { db, concurrency: 1, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology } });
    await vi.waitFor(() => expect(generateOntology).toHaveBeenCalledTimes(1));
    db.prepare('UPDATE documents SET is_past_final_report = NULL WHERE id = ?').run('changing');
    releaseFirst();
    await expect(pending).rejects.toMatchObject({ message: '자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요' });
    expect(generateOntology).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('aborts the follow-on outcome-link request after an eligibility change and preserves the prior result', async () => {
    const db = database();
    addDocument(db, 'changing', 'project-a');
    const previousGraph = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return { ...response('기존 가상 성과'), snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }] };
    } } });
    const storedRun = startGenerationRun('project-a', 1, db)!;
    finishGenerationRun('project-a', previousGraph, 'tester', storedRun.id, db);
    const priorOntology = getProjectOntology('project-a', db);

    const outcome = (type: 'outcome-short' | 'outcome-mid', name: string) => ({
      ...response().nodes[0], type, name, outcome_type: type === 'outcome-mid' ? '후속사업연계' : '기타',
    });
    const generateOntology = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      if (JSON.parse(messages[1].content).candidates) return { snippets: [], nodes: [], edges: [] };
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, proves_indices: [0, 1] }],
        nodes: [outcome('outcome-short', '가상 단기 성과'), outcome('outcome-mid', '가상 후속 성과')],
        edges: [],
      };
    });
    await expect(generateProjectOntology('project-a', {
      db,
      aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology },
      afterAssembleChunk: () => { db.prepare('UPDATE documents SET is_past_final_report = NULL WHERE id = ?').run('changing'); },
    })).rejects.toMatchObject({ message: '자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요' });

    expect(generateOntology).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(generateOntology.mock.calls)).toContain('가상 기관은 3건의 교육을 진행했다.');
    expect(getProjectOntology('project-a', db)).toEqual(priorOntology);
    const failedRun = startGenerationRun('project-a', 1, db)!;
    finalizeFailedGenerationRun(failedRun.id, new AiEligibilityChangedError(), (id, values) => updateGenerationRun(id, values, db), db);
    const persistedFailure = getGenerationRun(failedRun.id, db)!;
    expect(persistedFailure.error_message).toContain('자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요');
    expect(JSON.parse(persistedFailure.result_json!)).toEqual({
      eligibilityChanged: true,
      diagnosis: '자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요',
      executionDiagnostic: '실행 중 자료 자격 변경으로 작업 전체를 중단했습니다. 정확한 제외 문단 수는 계산하지 않았습니다.',
    });
    expect(getProjectOntology('project-a', db)).toEqual(priorOntology);
    db.close();
  });

  it('counts successful extracted documents independently of unread and failed documents', async () => {
    const db = database();
    addDocument(db, 'a-pass', 'project-a'); addDocument(db, 'b-pass', 'project-a');
    addDocument(db, 'c-unread', 'project-a', undefined, true, '읽지 못함');
    addDocument(db, 'd-fail', 'project-a');
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { document: { id: string }; paragraphs: Array<{ id: string }> };
      if (input.document.id === 'd-fail') throw new Error('dummy');
      return { ...response(), snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }] };
    } } });
    expect(result.documentSuccessCount).toBe(2);
    expect(result.documentFailureCount).toBe(2);
    expect(result.failedDocuments.map(({ documentId }) => documentId).sort()).toEqual(['c-unread', 'd-fail']);
    db.close();
  });

  it('downgrades an outcome supported only by forecast or inference evidence and records the R05 issue', async () => {
    const db = database(); addDocument(db, 'a-forecast', 'project-a', '가상 기관은 후속 사업을 추진할 예정이다.');
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote: '가상 기관은 후속 사업을 추진할 예정이다.', evidence_level: '관측', supports_indices: [0] }],
        nodes: [{ ...response().nodes[0], type: 'outcome-mid', name: '후속 사업 추진', outcome_state_ai: '관측됨', evidence_indices: [0] }], edges: [],
      };
    } } });
    expect(Object.values(result.graph.nodes)[0].outcome_state_ai).toBe('기대/추정');
    expect(Object.values(result.graph.snippets)[0].evidence_level).toBe('예견');
    expect(result.graph.issues).toContainEqual(expect.objectContaining({ file: Object.keys(result.graph.nodes)[0], field: 'outcome_state_ai', rule: expect.stringContaining('R05'), severity: 'warning' }));
    db.close();
  });

  it.each([
    ['사업을 추진할 예정이다', '사업을 완료했다'],
    ['사업을 완료했다', '사업을 추진할 예정이다'],
  ])('evaluates each same-name outcome evidence before R05 adjustment: %s / %s', async (first, second) => {
    const db = database();
    addDocument(db, 'a-first', 'project-a', first); addDocument(db, 'b-second', 'project-a', second);
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string; content: string }> };
      return {
        snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote: input.paragraphs[0].content, proves_indices: [0] }],
        nodes: [{ ...response().nodes[0], type: 'outcome-mid', name: '사업 성과', outcome_state_ai: '관측됨', evidence_indices: [0] }], edges: [],
      };
    } } });
    expect(Object.keys(result.graph.nodes)).toHaveLength(2);
    expect(Object.values(result.graph.nodes).map(n => n.outcome_state_ai).sort()).toEqual(['관측됨', '기대/추정']);
    expect(result.graph.edges.filter(({ relation }) => relation === 'proves')).toHaveLength(2);
    expect(result.graph.issues.some(({ rule }) => rule.includes('R05 예견·추정 근거만으로'))).toBe(true);
    db.close();
  });

  it.each([
    ['추진할 방침이다', '기대/추정', '예견', false],
    ['개소할 예정이다', '기대/추정', '예견', false],
    ['목표로 한다', '기대/추정', '예견', false],
    ['계획이다', '기대/추정', '예견', false],
    ['성과가 전망된다', '기대/추정', '예견', false],
    ['성과가 기대된다', '기대/추정', '예견', false],
    ['완성할 것이다', '기대/추정', '예견', false],
    ['추진하고자 한다', '기대/추정', '예견', false],
    ['계획을 완료했다', '관측됨', '관측', true],
    ['계획을 달성했다', '관측됨', '관측', true],
    ['개소했다', '관측됨', '관측', false],
    ['실시했다', '관측됨', '관측', false],
    ['사업이 있다', '관측됨', '관측', true],
  ])('R05 classifies %s and flags ambiguity', async (quote, expectedState, expectedLevel, needsReview) => {
    const db = database(); addDocument(db, 'a-claim', 'project-a', quote);
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote, evidence_level: '관측', supports_indices: [0] }],
        nodes: [{ ...response().nodes[0], type: 'outcome-mid', name: '사업 성과', outcome_state_ai: '관측됨' }], edges: [],
      };
    } } });
    expect(Object.values(result.graph.nodes)[0].outcome_state_ai).toBe(expectedState);
    expect(Object.values(result.graph.snippets)[0].evidence_level).toBe(expectedLevel);
    expect(result.graph.issues.some(({ rule }) => rule === 'R05 사람 확인 필요')).toBe(needsReview);
    db.close();
  });

  it.each([
    ['계획을 완료했다', true],
    ['사업이 있다', true],
    ['개소했다', false],
  ])('keeps ambiguous evidence without a relation for human review: %s', async (quote, ambiguous) => {
    const db = database(); addDocument(db, 'a-neutral', 'project-a', quote);
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote, evidence_level: '관측', proves_indices: [], supports_indices: [], contradicts_indices: [] }],
        nodes: [{ ...response().nodes[0], type: 'outcome-mid', name: '사업 성과', outcome_state_ai: '관측됨', evidence_indices: [0] }], edges: [],
      };
    } } });
    expect(Object.values(result.graph.nodes)[0].outcome_state_ai).toBe(ambiguous ? '관측됨' : '미확인');
    expect(result.graph.issues.some(({ rule }) => rule === 'R05 사람 확인 필요')).toBe(ambiguous);
    expect(result.graph.edges.some(({ relation }) => ['proves', 'supports', 'contradicts'].includes(relation))).toBe(false);
    db.close();
  });

  it.each([
    ['supports', '사업을 추진할 예정이다', '기대/추정', '예견·추정 근거만으로'],
    ['contradicts', '사업을 실시했다', '미확인', '적극 지지 근거가 없어'],
  ])('prioritizes %s constraints over ambiguous evidence and retains human review', async (relation, decisiveQuote, expectedState, downgradeRule) => {
    const db = database();
    const ambiguousQuote = '사업이 있다';
    addDocument(db, 'a-mixed', 'project-a', `${decisiveQuote}. ${ambiguousQuote}.`);
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      const baseSnippet = { ...response().snippets[0], paragraph_id: input.paragraphs[0].id, proves_indices: [], supports_indices: [], contradicts_indices: [] };
      return {
        snippets: [
          { ...baseSnippet, quote: decisiveQuote, supports_indices: relation === 'supports' ? [0] : [], contradicts_indices: relation === 'contradicts' ? [0] : [] },
          { ...baseSnippet, quote: ambiguousQuote },
        ],
        nodes: [{ ...response().nodes[0], type: 'outcome-mid', name: '사업 성과', outcome_state_ai: '관측됨', evidence_indices: [0, 1] }], edges: [],
      };
    } } });
    expect(Object.values(result.graph.nodes)[0].outcome_state_ai).toBe(expectedState);
    expect(result.graph.issues).toContainEqual(expect.objectContaining({ rule: 'R05 사람 확인 필요' }));
    expect(result.graph.issues).toContainEqual(expect.objectContaining({ file: Object.keys(result.graph.nodes)[0], field: 'outcome_state_ai', rule: expect.stringContaining(downgradeRule) }));
    db.close();
  });

  it('does not count contradicting evidence as support for an observed outcome', async () => {
    const db = database(); addDocument(db, 'a-contradicted', 'project-a', '가상 기관은 결과를 확인하지 못했다.');
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote: '가상 기관은 결과를 확인하지 못했다.', evidence_level: '관측', contradicts_indices: [0], proves_indices: [] }],
        nodes: [{ ...response().nodes[0], type: 'outcome-mid', name: '성과 관측', outcome_state_ai: '관측됨', evidence_indices: [0] }], edges: [],
      };
    } } });
    expect(Object.values(result.graph.nodes)[0].outcome_state_ai).toBe('미확인');
    expect(result.graph.issues).toContainEqual(expect.objectContaining({ file: Object.keys(result.graph.nodes)[0], field: 'outcome_state_ai', rule: expect.stringContaining('적극 지지 근거가 없어') }));
    db.close();
  });

  it('assembles project, country, and institution nodes and keeps only correctly directed relations', async () => {
    const db = database();
    const quote = '가상 사업은 가상 협력국과 활동을 진행하고 가상 기관을 연수 방문기관으로 포함했다.';
    addDocument(db, 'a-structure', 'project-a', quote);
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote, supports_indices: [0, 1, 2, 3] }],
        nodes: [
          { ...response().nodes[0], type: 'project', name: '가상 사업' },
          { ...response().nodes[0], type: 'partner', name: '가상 협력국' },
          { ...response().nodes[0], type: 'participant-org', name: '가상 기관', institution_type: '공공기관' },
          { ...response().nodes[0], type: 'activity', name: '활동', description: '' },
        ],
        edges: [
          { source_node_index: 0, target_node_index: 3, relation: 'conducts' },
          { source_node_index: 0, target_node_index: 1, relation: 'partner' },
          { source_node_index: 0, target_node_index: 2, relation: 'study_tour' },
          { source_node_index: 1, target_node_index: 3, relation: 'participates_in' },
          { source_node_index: 2, target_node_index: 3, relation: 'participates_in' },
          { source_node_index: 2, target_node_index: 0, relation: 'conducts' },
        ],
      };
    } } });
    expect(Object.keys(result.graph.nodes)).toHaveLength(4);
    expect(result.documentFailureCount).toBe(0);
    expect(result.graph.edges.filter(({ source }) => !source.startsWith('SNP-')).map(({ relation }) => relation).sort()).toEqual(['conducts', 'participates_in', 'participates_in', 'partner', 'study_tour']);
    expect(result.graph.issues).toContainEqual(expect.objectContaining({ rule: '관계 유형·방향 또는 끝점이 올바르지 않은 선 폐기' }));
    expect(Object.values(result.graph.sources).every(({ status }) => status === 'ai-draft')).toBe(true);
    expect(Object.values(result.graph.snippets).every(({ status }) => status === 'ai-draft')).toBe(true);
    expect(Object.values(result.graph.nodes).every(({ status }) => status === 'ai-draft')).toBe(true);
    db.close();
  });

  it('empties unquoted snippet and node facts and unsupported indicator values', async () => {
    const db = database();
    const quote = '가상 기관은 3건의 교육을 진행했고 행정 대응을 조정했다.';
    addDocument(db, 'a-grounding', 'project-a', quote);
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      const base = response();
      return {
        snippets: [{ ...base.snippets[0], paragraph_id: input.paragraphs[0].id, quote, fact: '허위 사실 99건', interpretation: '교육이 추진되었다는 해석', uncertainty: '교육 효과는 확인되지 않았다', observed_date: '2099-01-01' }],
        nodes: [
          { ...base.nodes[0], type: 'activity', date_start: '2099-01-01', place: '근거 없는 장소', response: '근거 없는 대응' },
          { ...base.nodes[0], type: 'indicator', name: '가상 실적', description: '', baseline: 99, actual: 3, verification_source: '가짜 설문' },
          { ...base.nodes[0], type: 'constraint', name: '행정 제약', description: '', response: '행정 대응을 조정했다' },
        ], edges: [],
      };
    } } });
    const snippets = Object.values(result.graph.snippets);
    expect(snippets[0]).toMatchObject({ fact: '', interpretation: '교육이 추진되었다는 해석', uncertainty: '교육 효과는 확인되지 않았다', observed_date: '', status: 'ai-draft' });
    const nodes = Object.values(result.graph.nodes);
    expect(nodes.find(({ type }) => type === 'activity')).toMatchObject({ date_start: '', place: '' });
    expect(nodes.find(({ type }) => type === 'indicator')).toMatchObject({ baseline: null, actual: 3, verification_source: '' });
    expect(nodes.find(({ type }) => type === 'constraint')?.response).toBe('행정 대응을 조정했다');
    expect(result.graph.issues.filter(({ rule }) => rule.includes('인용에서 확인되지 않는') || rule.includes('인용에 없는'))).not.toHaveLength(0);
    db.close();
  });

  it('preserves source-grounded qualitative measurements and normalizes Korean dates', async () => {
    const db = database();
    const quote = '2026년 10월 30일 가상 기관은 상태 승인, 달성률 80%를 기록했다.';
    addDocument(db, 'a-grounded-values', 'project-a', quote);
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      const base = response();
      return {
        snippets: [{ ...base.snippets[0], paragraph_id: input.paragraphs[0].id, quote, observed_date: '2026-10-30' }],
        nodes: [
          { ...base.nodes[0], type: 'activity', date_start: '2026-10-30', date_end: '2026년 10월 30일' },
          { ...base.nodes[0], type: 'indicator', name: '가상 지표', description: '', baseline: '승인', target: '80%', actual: '원문 밖 정성 값' },
        ], edges: [],
      };
    } } });
    expect(Object.values(result.graph.snippets)[0].observed_date).toBe('2026-10-30');
    expect(Object.values(result.graph.nodes).find(({ type }) => type === 'activity')).toMatchObject({ date_start: '2026-10-30', date_end: '2026-10-30' });
    expect(Object.values(result.graph.nodes).find(({ type }) => type === 'indicator')).toMatchObject({ baseline: '승인', target: '80%', actual: null });
    db.close();
  });

  it('drops an AI numeric description that is absent from the virtual source quote', async () => {
    const db = database();
    addDocument(db, 'a-stage3-doc', 'project-a', stage3Fixture.paragraphs[1].content);
    const result = await generateProjectOntology('project-a', { db, aiClient: {
      modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
        const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
        return {
          snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote: stage3Fixture.quote }],
          nodes: [{ ...response().nodes[0], description: stage3Fixture.manualSentence }],
          edges: [],
        };
      },
    } });

    expect(Object.values(result.graph.nodes)[0].description).toBe('');
    expect(Object.values(result.graph.sources)[0].document_id).toBe('a-stage3-doc');
    db.close();
  });

  it('drops an AI node name whose number is absent from the virtual source quote', async () => {
    const db = database();
    addDocument(db, 'a-stage3-name-doc', 'project-a', stage3Fixture.paragraphs[1].content);
    const result = await generateProjectOntology('project-a', { db, aiClient: {
      modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
        const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
        return {
          snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote: stage3Fixture.quote }],
          nodes: [{ ...response().nodes[0], name: '가상 기관 9건의 교육' }],
          edges: [],
        };
      },
    } });

    expect(result.graph.nodes).toEqual({});
    expect(result.graph.issues).toContainEqual(expect.objectContaining({
      field: 'nodes.0.name',
      rule: '인용에 없는 수치 점 이름 폐기',
      severity: 'warning',
    }));
    db.close();
  });

  it('keeps project inputs isolated and separates same-name nodes by first evidence', async () => {
    const db = database();
    addDocument(db, 'a-doc-1', 'project-a'); addDocument(db, 'a-doc-2', 'project-a'); addDocument(db, 'a-excluded', 'project-a', undefined, false); addDocument(db, 'a-unread', 'project-a', undefined, true, '읽지 못함'); addDocument(db, 'b-doc-1', 'project-b');
    const calls: string[] = [];
    const resultA = await generateProjectOntology('project-a', { db, project: { id: 'project-a', name: '가상 사업 A', created_at: '' }, aiClient: {
      modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
        const input = JSON.parse(messages[1].content) as { document: { id: string }; paragraphs: Array<{ id: string }> };
        calls.push(input.document.id);
        return { ...response(' 가상   교육 활동 '), snippets: response().snippets.map((snippet) => ({ ...snippet, paragraph_id: input.paragraphs[0].id })) } as never;
      },
    } });
    expect(calls.sort()).toEqual(['a-doc-1', 'a-doc-2']);
    expect(Object.keys(resultA.graph.sources)).toHaveLength(2);
    expect(Object.keys(resultA.graph.nodes)).toHaveLength(2);
    expect(Object.keys(resultA.graph.nodes).every(id => /-H[A-F0-9]{16}-[A-F0-9]{10}$/.test(id))).toBe(true);
    expect(Object.keys(resultA.graph.snippets)).toHaveLength(2);
    expect(resultA.documentSuccessCount).toBe(2);
    expect(resultA.documentFailureCount).toBe(1);
    expect(resultA.failedDocuments).toContainEqual({ documentId: 'a-unread', reason: '문서 추출이 완료되지 않음' });
    const repeat = await generateProjectOntology('project-a', { db, project: { id: 'project-a', name: '가상 사업 A', created_at: '' }, aiClient: {
      modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
        const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
        return { ...response(), snippets: response().snippets.map((snippet) => ({ ...snippet, paragraph_id: input.paragraphs[0].id })) };
      },
    } });
    expect(Object.keys(repeat.graph.nodes)).toEqual(Object.keys(resultA.graph.nodes));
    expect(Object.keys(repeat.graph.snippets)).toEqual(Object.keys(resultA.graph.snippets));
    db.close();
  });

  it('round trips fixture-generated candidates through a document split', async () => {
    const db=database(); addDocument(db,'a-doc-1','project-a');
    const run=() => generateProjectOntology('project-a',{db,aiClient:{modelName:'fixture-model',provider:'solar',generateOntology:async messages => {
      const input=JSON.parse(messages[1].content) as {paragraphs:Array<{id:string}>}; const base=response();
      return {...base,nodes:[{...base.nodes[0],type:'outcome-short' as const,name:'가상 단기'},{...base.nodes[0],type:'outcome-mid' as const,name:'가상 중기'}],snippets:[{...base.snippets[0],paragraph_id:input.paragraphs[0].id,proves_indices:[0,1]}],edges:[{source_node_index:0,target_node_index:1,relation:'extends_to'}]};
    }}});
    const first=await run(); const short=Object.values(first.graph.nodes).find(n=>n.title==='가상 단기')!; const mid=Object.values(first.graph.nodes).find(n=>n.title==='가상 중기')!;
    const imported=replaceProjectOntology('project-a',first.graph,'test',db,'2030'); const item=getNoteReviewData('project-a',db).items.find(i=>i.id===mid.id)!;
    saveNoteReview('project-a',imported.id,String(mid.id),{status:'확정',text:item.text,outcomeState:'미확인',reason:'',errorType:''},'담당',db);
    confirmNoteLink('project-a',imported.id,String(short.id),String(mid.id),'담당',db,'extends_to');
    addDocument(db,'a-doc-2','project-a'); const second=await run(); const next=replaceProjectOntology('project-a',second.graph,'test',db,'2031');
    const data=getNoteReviewData('project-a',db); const split=data.items.filter(i=>i.title==='가상 중기');
    expect(split).toHaveLength(2); expect(split.every(i=>i.splitHistory?.length===1 && i.history.length===0)).toBe(true);
    expect(data.missingReviewedCount).toBe(0); expect(data.splitLinkCount).toBe(2); expect(split.some(i=>i.candidates.some(c=>c.splitLink))).toBe(true);
    confirmNoteLink('project-a',next.id,split[0].candidates[0].source,split[0].id,'담당',db,'extends_to');
    rejectNoteLink('project-a',next.id,split[1].candidates[0].source,split[1].id,'extends_to','검토','기타','담당',db);
    expect(getNoteReviewData('project-a',db).splitLinkCount).toBe(0); db.close();
  });

  it('preserves both reviewed split notes and links after excluding a document and regenerating', async () => {
    const db=database(); addDocument(db,'a-doc-1','project-a'); addDocument(db,'a-doc-2','project-a');
    const run=() => generateProjectOntology('project-a',{db,aiClient:{modelName:'fixture-model',provider:'solar',generateOntology:async messages => {
      const input=JSON.parse(messages[1].content) as {paragraphs:Array<{id:string}>}; const base=response();
      return {...base,nodes:[{...base.nodes[0],type:'outcome-short' as const,name:'가상 단기'},{...base.nodes[0],type:'outcome-mid' as const,name:'가상 중기'}],snippets:[{...base.snippets[0],paragraph_id:input.paragraphs[0].id,proves_indices:[0,1]}],edges:[{source_node_index:0,target_node_index:1,relation:'extends_to'}]};
    }}});
    const first=await run(); const old=replaceProjectOntology('project-a',first.graph,'test',db,'2030');
    const split=getNoteReviewData('project-a',db).items.filter(i=>i.title==='가상 중기'); expect(split).toHaveLength(2);
    saveNoteReview('project-a',old.id,split[0].id,{status:'확정',text:split[0].text,outcomeState:'미확인',reason:'',errorType:''},'첫 담당',db);
    saveNoteReview('project-a',old.id,split[1].id,{status:'채택 제외',text:split[1].text,outcomeState:'미확인',reason:'중복',errorType:'기타'},'둘째 담당',db);
    for (const i of split) confirmNoteLink('project-a',old.id,i.candidates[0].source,i.id,'담당',db,'extends_to');
    db.prepare("UPDATE documents SET is_included=0 WHERE id='a-doc-2'").run(); const second=await run(); replaceProjectOntology('project-a',second.graph,'test',db,'2031');
    const data=getNoteReviewData('project-a',db); const merged=data.items.find(i=>i.title==='가상 중기')!;
    expect(merged).toMatchObject({history:[],mergeCount:2,splitPending:true}); expect(merged.splitHistory).toHaveLength(2); expect(merged.splitLinkHistory).toHaveLength(2); expect(merged.candidates[0]).toMatchObject({status:'AI 후보',splitLink:true}); expect(data.splitReviewedCount).toBe(1); expect(getProjectOntologyGraph('project-a',db).edges.filter(e=>e.relation==='extends_to')).toEqual([]); db.close();
  });

  it('keeps document-suffixed reviews when only paragraph locations change', async () => {
    const db = database(); addDocument(db, 'a-doc-1', 'project-a'); addDocument(db, 'a-doc-2', 'project-a');
    const run = () => generateProjectOntology('project-a', {db, aiClient: {modelName:'fixture-model', provider:'solar', generateOntology: async messages => {
      const input = JSON.parse(messages[1].content) as {paragraphs:Array<{id:string}>}; const base = response();
      return {...base, nodes:[{...base.nodes[0], type:'outcome-mid' as const}], snippets:base.snippets.map(snippet => ({...snippet, paragraph_id:input.paragraphs[0].id}))};
    }}});
    const first=await run(); const id=String(Object.values(first.graph.nodes)[0].id);
    const imported=replaceProjectOntology('project-a',first.graph,'test',db,'2030',{sourceKind:'generated'});
    const item=getNoteReviewData('project-a',db).items.find(i=>i.id===id)!;
    saveNoteReview('project-a',imported.id,id,{status:'확정',text:item.text,outcomeState:'미확인',reason:'',errorType:''},'담당',db);
    db.prepare("UPDATE paragraphs SET location='1-2쪽' WHERE document_id IN ('a-doc-1','a-doc-2')").run();
    const second=await run(); expect(Object.keys(second.graph.nodes).sort()).toEqual(Object.keys(first.graph.nodes).sort());
    replaceProjectOntology('project-a',second.graph,'test',db,'2031',{sourceKind:'generated'});
    expect(getNoteReviewData('project-a',db).items.find(i=>i.id===id)!.history).toHaveLength(1); db.close();
  });

  it('keeps business-document-sequence node ids stable when response order changes', async () => {
    const db = database(); addDocument(db, 'a-doc', 'project-a');
    const run = async (names: string[]) => generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      const base = response();
      return { ...base, snippets: base.snippets.map((snippet) => ({ ...snippet, paragraph_id: input.paragraphs[0].id, proves_indices: names.map((_, index) => index) })), nodes: names.map((name) => ({ ...base.nodes[0], name })) };
    } } });
    const first = await run(['가상 활동 B', '가상 활동 A']);
    const second = await run(['가상 활동 A', '가상 활동 B']);
    expect(Object.keys(first.graph.nodes).sort()).toEqual(Object.keys(second.graph.nodes).sort());
    db.close();
  });

  it('retains a confirmed note and link when a preceding sibling is generated', async () => {
    const db = database(); addDocument(db, 'a-doc', 'project-a');
    const run = async (withSibling: boolean) => generateProjectOntology('project-a', { db, aiClient: {
      modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
        const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
        const base = response();
        const nodes = [
          ...(withSibling ? [{ ...base.nodes[0], type: 'outcome-short' as const, name: '가상 가 성과' }] : []),
          { ...base.nodes[0], type: 'outcome-short' as const, name: '가상 나 성과' },
          { ...base.nodes[0], type: 'outcome-mid' as const, name: '가상 중기 성과' },
        ];
        return { ...base, nodes, snippets: [{ ...base.snippets[0], paragraph_id: input.paragraphs[0].id, proves_indices: nodes.map((_, i) => i) }],
          edges: [{ source_node_index: withSibling ? 1 : 0, target_node_index: withSibling ? 2 : 1, relation: 'extends_to' }] };
      },
    } });
    const first = await run(false);
    const source = Object.values(first.graph.nodes).find(n => n.title === '가상 나 성과')!;
    const target = Object.values(first.graph.nodes).find(n => n.title === '가상 중기 성과')!;
    const imported = replaceProjectOntology('project-a', first.graph, 'test', db, '2030', {sourceKind:'generated'});
    const item = getNoteReviewData('project-a', db).items.find(n => n.id === source.id)!;
    saveNoteReview('project-a', imported.id, String(source.id), {status:'확정', text:item.text, outcomeState:'미확인', reason:'', errorType:''}, '담당', db);
    confirmNoteLink('project-a', imported.id, String(source.id), String(target.id), '담당', db, 'extends_to');
    const next = await run(true);
    replaceProjectOntology('project-a', next.graph, 'test', db, '2031', {sourceKind:'generated'});
    const reviewed = getNoteReviewData('project-a', db);
    expect(reviewed.items.find(n => n.id === source.id)?.history.at(-1)?.status).toBe('확정');
    expect(reviewed.items.find(n => n.id === target.id)?.candidates.find(c => c.source === source.id)?.status).toBe('확정');
    expect(getProjectOntologyGraph('project-a', db).edges).toContainEqual({source:source.id, target:target.id, relation:'extends_to'});
    db.close();
  });

  it('discards invalid evidence and indexes, clears unsupported numbers, drops unsupported nodes and invalid edges', async () => {
    const db = database(); addDocument(db, 'a-doc', 'project-a');
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [
          { ...response().snippets[0], paragraph_id: input.paragraphs[0].id, proves_indices: [0, 1, -1, 99] },
          { ...response().snippets[0], paragraph_id: 'foreign-paragraph', quote: '가짜 기관은 999건을 집행했다.' },
          { ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote: '원문에 없는 별도의 가상 문장입니다.' },
          { ...response().snippets[0], paragraph_id: input.paragraphs[0].id, speaker: '통제 밖 화자' },
        ],
        nodes: [
          { ...response().nodes[0], description: '교육 999건 진행' },
          { ...response().nodes[0], name: '근거 없는 점', evidence_indices: [] },
        ],
        edges: [
          { source_node_index: 0, target_node_index: 99, relation: 'generates' },
          { source_node_index: -1, target_node_index: 0, relation: 'generates' },
          { source_node_index: 0, target_node_index: 0, relation: 'generates' },
        ],
      } as never;
    } } });
    expect(result.discardedQuoteCount).toBe(3);
    expect(Object.keys(result.graph.snippets)).toHaveLength(1);
    expect(Object.keys(result.graph.nodes)).toHaveLength(1);
    expect(Object.values(result.graph.nodes)[0].description).toBe('');
    expect(result.graph.issues.some((issue) => issue.rule === '유효 근거 없는 점 폐기')).toBe(true);
    expect(result.graph.issues.some((issue) => issue.rule === '끝점 없는 선 폐기')).toBe(true);
    expect(result.graph.issues.some((issue) => issue.rule === '해결할 수 없는 점 인덱스 폐기')).toBe(true);
    expect(result.graph.issues.some((issue) => issue.rule === '자기 자신을 잇는 선 폐기')).toBe(true);
    expect(result.graph.issues.some((issue) => issue.rule === '통제 어휘 밖 값 폐기')).toBe(true);
    expect(checkOntologyGraph(result.graph).every((issue) => !issue.file.includes('/'))).toBe(true);
    db.close();
  });

  it('blocks unknown and mismatched providers without sending documents', async () => {
    const db = database();
    addDocument(db, 'local', 'project-a', undefined, true, '추출 완료', { masked: true, approved_ai: 'local-only', is_past_final_report: false });
    const generateOntology = vi.fn(async () => response());
    const mismatch = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology } });
    expect(mismatch.excludedDocuments).toEqual([{ documentId: 'local', reasons: ['제외: approved_ai=local-only ≠ solar'] }]);
    const unknown = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: null, generateOntology } });
    expect(unknown.excludedDocuments[0].reasons).toContain('제외: AI 제공자 확인 불가');
    expect(shouldPreserveOntology(unknown)).toBe(true);
    expect(JSON.parse(generationResultJson(unknown)).ontologyPreserved).toBe(true);
    const run = finish(unknown, db);
    expect(run.state).toBe('failed');
    expect(run.error_message).toContain('문서 local: 제외: AI 제공자 확인 불가');
    expect(generateOntology).not.toHaveBeenCalled();
    db.close();
  });

  it('passes solar-approved documents through a real AiClient and blocks an unknown model before fetch', async () => {
    const previousProvider = process.env.AIEAS_AI_PROVIDER;
    const db = database();
    addDocument(db, 'solar-source', 'project-a');
    try {
      delete process.env.AIEAS_AI_PROVIDER;
      const blockedFetch = vi.fn<typeof fetch>();
      const unknownClient = new AiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'aieas-default', reasoningEffort: 'low', fetchFn: blockedFetch });
      const blocked = await generateProjectOntology('project-a', { db, aiClient: unknownClient });
      expect(blockedFetch).not.toHaveBeenCalled();
      expect(blocked.excludedDocuments).toEqual([{ documentId: 'solar-source', reasons: ['제외: AI 제공자 확인 불가'] }]);

      process.env.AIEAS_AI_PROVIDER = 'solar';
      const valid = response();
      const solarFetch = vi.fn<typeof fetch>(async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        const input = JSON.parse(request.messages[1].content) as { document: { id: string }; paragraphs: Array<{ id: string }> };
        expect(input.document.id).toBe('solar-source');
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          ...valid,
          snippets: valid.snippets.map((snippet) => ({ ...snippet, paragraph_id: input.paragraphs[0].id })),
        }) } }] });
      });
      const solarClient = new AiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'fixture-model', reasoningEffort: 'low', fetchFn: solarFetch });
      const accepted = await generateProjectOntology('project-a', { db, aiClient: solarClient });
      expect(solarFetch).toHaveBeenCalledTimes(1);
      expect(accepted.excludedDocuments).toEqual([]);
      expect(accepted.documentSuccessCount).toBe(1);
    } finally {
      if (previousProvider === undefined) delete process.env.AIEAS_AI_PROVIDER;
      else process.env.AIEAS_AI_PROVIDER = previousProvider;
      db.close();
    }
  });

  it('accepts a negative evidence index from the strict AI schema and keeps the document successful', async () => {
    const db = database(); addDocument(db, 'a-negative-index', 'project-a');
    const valid = response();
    let attempts = 0;
    const client = new AiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'fixture-model', reasoningEffort: 'low', fetchFn: async (_url, init) => {
      attempts++;
      const request = JSON.parse(String(init?.body));
      expect(request.response_format.json_schema.schema.properties.nodes.items.properties.evidence_indices.items).toEqual({ type: 'integer' });
      const messages = request.messages as Array<{ role: string; content: string }>;
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        ...valid,
        snippets: valid.snippets.map((snippet) => ({ ...snippet, paragraph_id: input.paragraphs[0].id })),
        nodes: [{ ...valid.nodes[0], evidence_indices: [-1] }],
      }) } }] });
    } });

    Object.defineProperty(client, 'provider', { value: 'solar' });
    const result = await generateProjectOntology('project-a', { db, aiClient: client });
    expect(attempts).toBe(1);
    expect(result.documentFailureCount).toBe(0);
    expect(result.documentSuccessCount).toBe(1);
    expect(Object.keys(result.graph.nodes)).toHaveLength(0);
    expect(result.graph.issues).toContainEqual({ severity: 'warning', file: expect.any(String), field: 'nodes.0.evidence_indices', rule: '해결할 수 없는 근거 인덱스 폐기' });
    db.close();
  });

  it('warns separately for non-integer, out-of-range, and discarded evidence references', async () => {
    const db = database(); addDocument(db, 'a-bad-evidence-indices', 'project-a');
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [
          { ...response().snippets[0], paragraph_id: input.paragraphs[0].id },
          { ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote: '버려질 가상 인용 문장입니다.' },
        ],
        nodes: [{ ...response().nodes[0], evidence_indices: [0.5, 9, 1] }],
        edges: [],
      } as never;
    } } });
    const indexWarnings = result.graph.issues.filter((issue) => issue.rule === '해결할 수 없는 근거 인덱스 폐기');
    const sourceId = Object.keys(result.graph.sources)[0];
    expect(indexWarnings).toEqual([
      { severity: 'warning', file: sourceId, field: 'nodes.0.evidence_indices', rule: '해결할 수 없는 근거 인덱스 폐기' },
      { severity: 'warning', file: sourceId, field: 'nodes.0.evidence_indices', rule: '해결할 수 없는 근거 인덱스 폐기' },
      { severity: 'warning', file: sourceId, field: 'nodes.0.evidence_indices', rule: '해결할 수 없는 근거 인덱스 폐기' },
    ]);
    expect(result.graph.issues).toContainEqual({ severity: 'warning', file: expect.any(String), field: 'nodes.0', rule: '유효 근거 없는 점 폐기' });
    expect(Object.keys(result.graph.nodes)).toHaveLength(0);
    db.close();
  });

  it('warns when proves, supports, or contradicts repeats a node index', async () => {
    const db = database(); addDocument(db, 'a-duplicate-relations', 'project-a');
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, proves_indices: [0, 0], supports_indices: [0, 0], contradicts_indices: [0, 0] }],
        nodes: response().nodes,
        edges: [],
      };
    } } });
    const sourceId = Object.keys(result.graph.sources)[0];
    expect(result.graph.issues.filter((issue) => issue.rule === '중복 점 인덱스 폐기')).toEqual([
      { severity: 'warning', file: sourceId, field: 'snippets.0.proves_indices', rule: '중복 점 인덱스 폐기' },
      { severity: 'warning', file: sourceId, field: 'snippets.0.supports_indices', rule: '중복 점 인덱스 폐기' },
      { severity: 'warning', file: sourceId, field: 'snippets.0.contradicts_indices', rule: '중복 점 인덱스 폐기' },
    ]);
    const snippet = Object.values(result.graph.snippets)[0];
    for (const relation of ['proves', 'supports', 'contradicts'] as const) expect(snippet[relation]).toHaveLength(1);
    db.close();
  });

  it('warns and deduplicates when a node repeats valid evidence indices', async () => {
    const db = database(); addDocument(db, 'a-duplicate-evidence-indices', 'project-a'); addDocument(db, 'b-mixed-evidence-indices', 'project-b');
    const singleResult = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }],
        nodes: [{ ...response().nodes[0], evidence_indices: [0, 0] }],
        edges: [],
      };
    } } });
    const singleSourceId = Object.keys(singleResult.graph.sources)[0];
    expect(singleResult.graph.issues.filter((issue) => issue.rule === '중복 근거 인덱스 폐기')).toEqual([
      { severity: 'warning', file: singleSourceId, field: 'nodes.0.evidence_indices', rule: '중복 근거 인덱스 폐기' },
    ]);
    expect(Object.keys(singleResult.graph.nodes)).toHaveLength(1);
    expect(Object.values(singleResult.graph.nodes)[0].evidence).toHaveLength(1);

    const mixedResult = await generateProjectOntology('project-b', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [
          { ...response().snippets[0], paragraph_id: input.paragraphs[0].id },
          { ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote: '3건의 교육을 진행했다.' },
        ],
        nodes: [{ ...response().nodes[0], evidence_indices: [0, 0, 1] }],
        edges: [],
      };
    } } });
    const mixedSourceId = Object.keys(mixedResult.graph.sources)[0];
    expect(mixedResult.graph.issues.filter((issue) => issue.rule === '중복 근거 인덱스 폐기')).toEqual([
      { severity: 'warning', file: mixedSourceId, field: 'nodes.0.evidence_indices', rule: '중복 근거 인덱스 폐기' },
    ]);
    expect(Object.keys(mixedResult.graph.nodes)).toHaveLength(1);
    expect(Object.values(mixedResult.graph.nodes)[0].evidence).toHaveLength(2);
    db.close();
  });

  it('rejects a fabricated quote attached to a valid input paragraph id', async () => {
    const db = database(); addDocument(db, 'a-doc', 'project-a');
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return {
        snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote: '원문과 다른 가상 인용입니다.' }],
        nodes: [{ ...response().nodes[0], evidence_indices: [0] }],
        edges: [],
      };
    } } });
    expect(result.discardedQuoteCount).toBe(1);
    expect(Object.keys(result.graph.snippets)).toHaveLength(0);
    expect(result.graph.issues).toContainEqual(expect.objectContaining({ field: 'snippet.quote', rule: '원문 불일치 인용 폐기', severity: 'warning' }));
    expect(result.graph.issues).toContainEqual(expect.objectContaining({ field: 'nodes.0', rule: '유효 근거 없는 점 폐기', severity: 'warning' }));
    db.close();
  });

  it('bounds each AI call and records a timed-out document as failed', async () => {
    const db = database(); addDocument(db, 'a-slow', 'project-a');
    let aborted = false;
    let attempts = 0;
    const result = await generateProjectOntology('project-a', { db, aiCallTimeoutMs: 5, aiClient: {
      modelName: 'fixture-model', provider: 'solar', generateOntology: (_messages, signal) => { attempts++; return new Promise<OntologyGenerationResponse>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { aborted = true; reject(new Error('fixture aborted')); });
      }); },
    } });
    expect(aborted).toBe(true);
    expect(attempts).toBe(2);
    expect(result.documentFailureCount).toBe(1);
    expect(result.failedDocuments).toEqual([{ documentId: 'a-slow', reason: '문서 일부 생성 요청 실패 (timeout 1)' }]);
    expect(result.graph.issues).toContainEqual(expect.objectContaining({ rule: 'AI 호출 실패', detail: 'timeout', severity: 'warning' }));
    db.close();
  });

  it('keeps failure kinds in document reasons, stored issues, and result JSON without sensitive text', async () => {
    const db = database(); addDocument(db, 'a-fail', 'project-a');
    const result = await generateProjectOntology('project-a', { db, retryWait: async () => {}, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async () => { throw new Error('dummy response-body'); } } });
    expect(result.failureKinds).toEqual({ network: 1 });
    expect(result.failedDocuments).toEqual([{ documentId: 'a-fail', reason: '문서 일부 생성 요청 실패 (network 1)' }]);
    expect(result.graph.issues).toContainEqual(expect.objectContaining({ rule: 'AI 호출 실패', detail: 'network' }));
    replaceProjectOntology('project-a', result.graph, 'tester', db, '2026-10-30T00:00:00.000Z', { sourceKind: 'generated', modelName: result.modelName, documentSuccessCount: result.documentSuccessCount, documentFailureCount: result.documentFailureCount, discardedQuoteCount: result.discardedQuoteCount });
    expect(getProjectOntology('project-a', db).issues).toContainEqual(expect.objectContaining({ rule: 'AI 호출 실패', message: expect.stringContaining('network') }));
    const safeJson = generationResultJson(result);
    expect(safeJson).toContain('"failureKinds":{"network":1}');
    expect(safeJson).not.toContain('fixture-secret');
    expect(safeJson).not.toContain('response-body');
    db.close();
  });

  it('never runs more than two AI requests concurrently', async () => {
    const db = database();
    for (let index = 0; index < 5; index++) addDocument(db, `a-${index}`, 'project-a');
    let active = 0; let peak = 0;
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      active++; peak = Math.max(peak, active);
      await Promise.resolve(); active--;
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return { ...response(), snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }] };
    } } });
    expect(peak).toBe(2);
    expect(result.documentSuccessCount).toBe(5);
    db.close();
  });

  it('records one failed document while retaining successful documents', async () => {
    const db = database(); addDocument(db, 'a-fail', 'project-a'); addDocument(db, 'a-pass', 'project-a');
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { document: { id: string }; paragraphs: Array<{ id: string }> };
      if (input.document.id === 'a-fail') throw new Error('fixture failure');
      return { ...response(), snippets: response().snippets.map((snippet) => ({ ...snippet, paragraph_id: input.paragraphs[0].id })) } as never;
    } } });
    expect(result.documentFailureCount).toBe(1);
    expect(result.documentSuccessCount).toBe(1);
    expect(Object.keys(result.graph.nodes)).toHaveLength(1);
    replaceProjectOntology('project-a', result.graph, 'tester', db, '2026-10-30T00:00:00.000Z', { sourceKind: 'generated', modelName: result.modelName, documentSuccessCount: result.documentSuccessCount, documentFailureCount: result.documentFailureCount, discardedQuoteCount: result.discardedQuoteCount });
    expect(getProjectOntology('project-a', db).import).toMatchObject({ node_count: 1, document_success_count: 1, document_failure_count: 1 });
    db.close();
  });

  it('retries an invalid strict response once with the same request', async () => {
    let attempts = 0;
    const valid = response();
    const client = new AiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'fixture-model', reasoningEffort: 'low', fetchFn: async (_url, init) => {
      attempts++;
      const request = JSON.parse(String(init?.body));
      expect(request.response_format.json_schema.strict).toBe(true);
      return Response.json({ choices: [{ message: { content: JSON.stringify(attempts === 1 ? { extra: true } : valid) } }] });
    } });
    await expect(client.generateOntology([{ role: 'user', content: '가상 시험' }])).resolves.toEqual(valid);
    expect(attempts).toBe(2);
  });

  it('records a document failure after both strict schema attempts fail', async () => {
    const db = database(); addDocument(db, 'a-invalid', 'project-a');
    let attempts = 0;
    const client = new AiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'fixture-model', reasoningEffort: 'low', fetchFn: async () => {
      attempts++;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ wrong: true }) } }] });
    } });
    Object.defineProperty(client, 'provider', { value: 'solar' });
    const result = await generateProjectOntology('project-a', { db, aiClient: client });
    expect(attempts).toBe(2);
    expect(result.documentFailureCount).toBe(1);
    expect(result.graph.issues.some((issue) => issue.rule === 'AI 호출 실패')).toBe(true);
    db.close();
  });

  it('prevents a duplicate active project run and stores import metadata without text', async () => {
    const db = database();
    const first = startGenerationRun('project-a', 2, db)!;
    expect(startGenerationRun('project-a', 2, db)).toBeNull();
    expect(getActiveGenerationRun('project-a', db)?.id).toBe(first.id);
    expect(markInterruptedOntologyRunsFailed(db)).toBe(1);
    expect(db.prepare('SELECT state FROM ontology_generation_runs WHERE id = ?').get(first.id)).toMatchObject({ state: 'failed' });
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async () => response() } });
    replaceProjectOntology('project-a', result.graph, 'tester', db, '2026-10-30T00:00:00.000Z', { sourceKind: 'generated', modelName: result.modelName, documentSuccessCount: 1, documentFailureCount: 0, discardedQuoteCount: 0 });
    const history = db.prepare('SELECT * FROM ontology_imports WHERE project_id = ?').get('project-a') as Record<string, unknown>;
    expect(history).toMatchObject({ source_kind: 'generated', model_name: 'fixture-model' });
    expect(JSON.stringify(history)).not.toContain('가상 기관은');
    db.close();
  });

  it('forces a failed terminal state when the normal status update throws', () => {
    const db = database();
    const run = startGenerationRun('project-a', 1, db)!;
    updateGenerationRun(run.id, { state: 'running' }, db);
    expect(() => finalizeFailedGenerationRun(run.id, new Error('fixture failure'), () => { throw new Error('fixture status write failure'); }, db)).not.toThrow();
    expect(db.prepare('SELECT state, error_message FROM ontology_generation_runs WHERE id = ?').get(run.id)).toMatchObject({
      state: 'failed', error_message: '온톨로지 생성 중 내부 오류(생성: 내부 처리 중 예외가 발생했습니다.)',
    });
    db.close();
  });

  it('preserves the eligibility diagnosis in result_json when the normal status update throws', () => {
    const db = database();
    const run = startGenerationRun('project-a', 1, db)!;
    updateGenerationRun(run.id, { state: 'running' }, db);
    expect(() => finalizeFailedGenerationRun(
      run.id,
      new AiEligibilityChangedError(),
      () => { throw new Error('fixture status write failure'); },
      db,
    )).not.toThrow();
    const persisted = db.prepare('SELECT state, error_message, result_json FROM ontology_generation_runs WHERE id = ?').get(run.id) as {
      state: string; error_message: string; result_json: string;
    };
    expect(persisted.state).toBe('failed');
    expect(persisted.error_message).toContain('자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요');
    expect(JSON.parse(persisted.result_json)).toEqual({
      eligibilityChanged: true,
      diagnosis: '자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요',
      executionDiagnostic: '실행 중 자료 자격 변경으로 작업 전체를 중단했습니다. 정확한 제외 문단 수는 계산하지 않았습니다.',
    });
    db.close();
  });

  it('assigns distinct fixed-length generated node ids to more than 99 nodes', async () => {
    const db = database(); addDocument(db, 'a-many-nodes', 'project-a');
    const generated = Array.from({ length: 105 }, (_, index) => ({ ...response().nodes[0], name: `가상 활동명 ${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}` }));
    const result = await generateProjectOntology('project-a', { db, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return { ...response(), snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }], nodes: generated };
    } } });
    const ids = Object.keys(result.graph.nodes).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    expect(ids).toHaveLength(105);
    expect(new Set(ids).size).toBe(105);
    expect(ids.every((id) => /-H[A-F0-9]{16}$/.test(id))).toBe(true);
    expect(checkOntologyGraph(result.graph).filter((issue) => issue.rule === 'R03 9')).toEqual([]);
    db.close();
  });

  it('isolates a document assembly exception and retains other document output', async () => {
    const db = database(); addDocument(db, 'a-fails', 'project-a'); addDocument(db, 'b-succeeds', 'project-a');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await generateProjectOntology('project-a', { db, afterAssembleChunk: (id) => { if (id === 'a-fails') { const error = new Error('dummy 가상 문단 및 AI 응답 원문'); error.name = 'CredentialError'; throw error; } }, aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
      const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
      return { ...response(), snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }] };
    } } });
    expect(result.failedDocuments).toEqual([{ documentId: 'a-fails', reason: '문서 조립 실패: 내부 처리 중 예외가 발생했습니다.' }]);
    expect(result.documentSuccessCount).toBe(1);
    expect(Object.values(result.graph.sources).map((source) => source.document_id)).toEqual(['a-fails', 'b-succeeds']);
    expect(Object.keys(result.graph.snippets)).toHaveLength(1);
    expect(JSON.stringify({ failedDocuments: result.failedDocuments, issues: result.graph.issues })).not.toContain('dummy');
    expect(String(log.mock.calls[0][0])).toContain('stage=assemble name=Error message=내부 처리 중 예외가 발생했습니다.');
    expect(String(log.mock.calls[0][0])).not.toContain('CredentialError');
    expect(String(log.mock.calls[0][0])).not.toContain('dummy');
    log.mockRestore();
    db.close();
  });

  it('bounds reviewed multiline errors in saved failure messages and single-line logs', () => {
    const db = database();
    const run = startGenerationRun('project-a', 1, db)!;
    const message = `가상 오류\r\n${'가'.repeat(300)}`;
    const originalHas = Set.prototype.has;
    // Exercise the boundary even if a future reviewed message is long or multiline.
    const has = vi.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, value: unknown) {
      return value === message || originalHas.call(this, value);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const safe = safeOntologyError(new Error(message));
      expect(safe.message).toBe(`가상 오류 ${'가'.repeat(194)}`);
      expect(safe.message.length).toBe(200);
      finalizeFailedGenerationRun(run.id, new Error(message), updateGenerationRun, db, 'save');
      expect(getGenerationRun(run.id, db)?.error_message).toBe(`온톨로지 생성 중 내부 오류(저장: ${safe.message})`);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toBe(`[ontology-generation] stage=save name=Error message=${safe.message}`);
      expect(String(log.mock.calls[0][0])).not.toMatch(/[\r\n]/);
      expect(getGenerationRun(run.id, db)?.error_message).not.toMatch(/[\r\n]/);
    } finally { has.mockRestore(); log.mockRestore(); db.close(); }
  });

  it('records save failure stage and sanitized reason in the run and one log line', () => {
    const db = database();
    const run = startGenerationRun('project-a', 1, db)!;
    updateGenerationRun(run.id, { state: 'running' }, db);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const graph: OntologyGraph = { code: 'PTEST', projectName: '가상 사업', project: { id: 'missing-project' }, sources: {}, snippets: {}, nodes: {}, edges: [], reports: {}, report_status: {}, issues: [] };
      let error: unknown;
      try { replaceProjectOntology('missing-project', graph, 'tester', db); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(() => finalizeFailedGenerationRun(run.id, error, updateGenerationRun, db, 'save')).not.toThrow();
      expect(getGenerationRun(run.id, db)).toMatchObject({ state: 'failed', error_message: '온톨로지 생성 중 내부 오류(저장: 사업을 찾을 수 없습니다.)' });
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain('stage=save name=Error message=사업을 찾을 수 없습니다.');
      expect(String(log.mock.calls[0][0])).not.toContain('fixture-secret');
      const unsafeRun = startGenerationRun('project-a', 1, db)!;
      updateGenerationRun(unsafeRun.id, { state: 'running' }, db);
      const unsafeError = new Error('fixture-secret key and AI response body');
      unsafeError.name = 'CredentialError';
      finalizeFailedGenerationRun(unsafeRun.id, unsafeError, updateGenerationRun, db, 'save');
      expect(getGenerationRun(unsafeRun.id, db)).toMatchObject({ error_message: '온톨로지 생성 중 내부 오류(저장: 내부 처리 중 예외가 발생했습니다.)' });
      expect(log).toHaveBeenCalledTimes(2);
      expect(String(log.mock.calls[1][0])).toContain('stage=save name=Error message=내부 처리 중 예외가 발생했습니다.');
      expect(String(log.mock.calls[1][0])).not.toContain('CredentialError');
      expect(String(log.mock.calls[1][0])).not.toContain('fixture-secret');
    } finally { log.mockRestore(); db.close(); }
  });
});

describe('W-27 generator additions', () => {
  it('keeps the current project and ordinary outcome while classifying all followup forms', async () => {
    const db = database();
    addDocument(db, 'a-doc', 'project-a');
    const result = await generateProjectOntology('project-a', { db, project: { id: 'project-a', name: '후속 사업', created_at: '' }, aiClient: {
      modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
        const input = JSON.parse(messages[1].content);
        const fixture = response();
        return { ...fixture, snippets: [{ ...fixture.snippets[0], paragraph_id: input.paragraphs[0].id }], nodes: [
          { ...fixture.nodes[0], type: 'project', name: '후속 사업' },
          { ...fixture.nodes[0], type: 'project', name: '연계 사업' },
          { ...fixture.nodes[0], type: 'project', name: '후속연계' },
          { ...fixture.nodes[0], type: 'project', name: '후속사업 확장' },
          { ...fixture.nodes[0], type: 'outcome-mid', name: '일반 정책 성과' },
        ] };
      },
    } });
    expect(Object.values(result.graph.nodes).filter((node) => node.type === 'project')).toHaveLength(1);
    expect(Object.values(result.graph.nodes).filter((node) => node.outcome_type === '후속사업연계')).toHaveLength(3);
    expect(Object.values(result.graph.nodes).find((node) => node.title === '일반 정책 성과')?.outcome_type).not.toBe('후속사업연계');
    db.close();
  });
  it('extracts organization and policy types, links a matching source, and proposes cross-chunk outcome paths', async () => {
    const db = database();
    const quote = '가상 수행기관과 가상 정책분야, 후속사업 및 a-doc.docx 검증 자료를 확인했다.';
    addDocument(db, 'a-doc', 'project-a', quote);
    const calls: string[] = [];
    const result = await generateProjectOntology('project-a', { db, retryWait: async () => {}, aiClient: {
      modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
        const input = JSON.parse(messages[1].content);
        if (input.candidates) {
          calls.push('connection');
          const source = input.candidates.findIndex((item: { type: string }) => item.type === 'outcome-short');
          const target = input.candidates.findIndex((item: { type: string }) => item.type === 'outcome-mid');
          return { nodes: [], snippets: [], edges: [{ source_node_index: source, target_node_index: target, relation: 'extends_to' }, { source_node_index: target, target_node_index: source, relation: 'extends_to' }, { source_node_index: 999, target_node_index: target, relation: 'extends_to' }] };
        }
        calls.push('chunk');
        const base = response().nodes[0];
        const node = (type: typeof base.type, name: string) => ({ ...base, type, name, description: '', evidence_indices: [0] });
        return { snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id, quote, fact: '', proves_indices: [] }],
          nodes: [node('project', '가상 사업 A'), node('implementer', '가상 수행기관'), node('policy-area', '가상 정책분야'),
            node('outcome-short', '가상 단기성과'), node('project', '후속사업'),
            { ...node('indicator', '가상 지표'), verification_source: 'a-doc.docx' }], edges: [] };
      },
    } });
    expect(calls).toEqual(['chunk', 'connection']);
    const nodes = Object.values(result.graph.nodes);
    expect(nodes.some((node) => node.type === 'implementer')).toBe(true);
    expect(nodes.some((node) => node.type === 'policy-area')).toBe(true);
    const followup = nodes.find((node) => node.title === '후속사업')!;
    expect(followup.type).toBe('outcome-mid');
    expect(followup.outcome_type).toBe('후속사업연계');
    expect(followup.extends_from_ai).toBeUndefined();
    expect(result.graph.edges.filter((edge) => ['extends_to', 'targets'].includes(edge.relation))).toHaveLength(0);
    expect(result.graph.candidates).toContainEqual(expect.objectContaining({ target: followup.id, relation: 'targets' }));
    expect(result.graph.candidates).toContainEqual(expect.objectContaining({ target: followup.id, relation: 'extends_to' }));
    const indicator = nodes.find((node) => node.type === 'indicator')!;
    expect(indicator.verification_source).toBe('a-doc.docx');
    expect(result.graph.edges).toContainEqual(expect.objectContaining({ source: indicator.id, relation: 'verified_by' }));
    db.close();
  });
});

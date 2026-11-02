import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createDocument, createProject, insertParagraphs } from '../src/server/store/db';
import type { DocumentRecord } from '../src/server/store/types';
import { CREATE_TABLES_SQL } from '../src/server/store/schema';
import { generateProjectOntology, MAX_CONCURRENT_AI_CALLS } from '../src/server/ontology/generator';
import type { OntologyGenerationResponse } from '../src/server/ontology/generator-types';

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_TABLES_SQL);
  createProject({ id: 'project-a', name: '가상 사업 A', created_at: '2026-10-30' }, db);
  return db;
}

function addDocument(db: Database.Database, id: string) {
  const doc: DocumentRecord = {
    id,
    project_id: 'project-a',
    file_name: `${id}.docx`,
    file_type: 'docx',
    status: '추출 완료',
    doc_type: '사업계획서',
    is_included: 1,
    excluded_reason: null,
    masked: true,
    approved_ai: 'solar',
    is_past_final_report: false,
    created_at: id,
  };
  createDocument(doc, db);
  insertParagraphs([{ id: `${id}-p1`, document_id: id, sequence_no: 1, location: '¶1', content: '가상 기관은 3건의 교육을 진행했다.' }], db);
}

function response(name = '가상 교육 활동'): OntologyGenerationResponse {
  return {
    snippets: [{ paragraph_id: 'replace-p1', quote: '가상 기관은 3건의 교육을 진행했다.', speaker: '수행기관', evidence_kind: '활동결과보고서', evidence_level: '관측', category: '산출물', fact: '교육 3건 진행', interpretation: '', uncertainty: '', observed_date: '', proves_indices: [0], supports_indices: [], contradicts_indices: [] }],
    nodes: [{ type: 'activity', name, description: '교육 3건 진행', evidence_indices: [0], outcome_family: '', outcome_type: '', outcome_state_ai: '미확인', timing: '', pdm_stage: '', factor_scope: '', factor_class: '', response: '', output_type: '', institution_type: '', date_start: '', date_end: '', place: '', baseline: null, target: null, actual: null, verification_source: '' }],
    edges: [],
  };
}

async function withOntologyConcurrencyEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AIEAS_ONTOLOGY_CONCURRENCY;
  if (value === undefined) delete process.env.AIEAS_ONTOLOGY_CONCURRENCY;
  else process.env.AIEAS_ONTOLOGY_CONCURRENCY = value;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.AIEAS_ONTOLOGY_CONCURRENCY;
    else process.env.AIEAS_ONTOLOGY_CONCURRENCY = previous;
  }
}

async function measurePeakOntologyConcurrency(documentCount: number, concurrency?: number) {
  const db = database();
  for (let index = 0; index < documentCount; index++) addDocument(db, `a-doc-${String(index).padStart(2, '0')}`);
  let active = 0;
  let peak = 0;
  let requestIndex = 0;
  try {
    const result = await generateProjectOntology('project-a', {
      db,
      ...(concurrency === undefined ? {} : { concurrency }),
      aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
        const ordinal = requestIndex++;
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
        return { ...response(`가상 활동 ${String.fromCharCode(65 + ordinal)}`), snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }] };
      } },
    });
    return { peak, result };
  }
  finally { db.close(); }
}

describe('configurable ontology AI concurrency', () => {
  it('keeps the default at two when the setting is missing', async () => {
    await withOntologyConcurrencyEnv(undefined, async () => {
      expect(MAX_CONCURRENT_AI_CALLS).toBe(2);
      const { peak, result } = await measurePeakOntologyConcurrency(5);
      expect(peak).toBe(2);
      expect(result.documentSuccessCount).toBe(5);
    });
  });

  it.each([
    { label: 'empty', value: '', expected: 2, documentCount: 5 },
    { label: 'zero', value: '0', expected: 2, documentCount: 5 },
    { label: 'negative', value: '-3', expected: 2, documentCount: 5 },
    { label: 'nonnumeric', value: 'abc', expected: 2, documentCount: 5 },
    { label: 'decimal', value: '2.5', expected: 2, documentCount: 5 },
    { label: 'over the maximum', value: '99', expected: 16, documentCount: 20 },
  ])('uses the default or cap for the $label environment value', async ({ value, expected, documentCount }) => {
    await withOntologyConcurrencyEnv(value, async () => {
      const { peak, result } = await measurePeakOntologyConcurrency(documentCount);
      expect(peak).toBe(expected);
      expect(result.documentSuccessCount).toBe(documentCount);
    });
  });

  it.each([
    { label: 'valid option over environment', environment: '2', concurrency: 8, expected: 8, documentCount: 10 },
    { label: 'valid option below environment', environment: '8', concurrency: 3, expected: 3, documentCount: 10 },
    { label: 'zero option', environment: '8', concurrency: 0, expected: 2, documentCount: 5 },
    { label: 'negative option', environment: '8', concurrency: -3, expected: 2, documentCount: 5 },
    { label: 'decimal option', environment: '8', concurrency: 2.5, expected: 2, documentCount: 5 },
    { label: 'option over the maximum', environment: '2', concurrency: 99, expected: 16, documentCount: 20 },
  ])('applies the same validation to the $label', async ({ environment, concurrency, expected, documentCount }) => {
    await withOntologyConcurrencyEnv(environment, async () => {
      const { peak, result } = await measurePeakOntologyConcurrency(documentCount, concurrency);
      expect(peak).toBe(expected);
      expect(result.documentSuccessCount).toBe(documentCount);
    });
  });

  it('uses environment concurrency above eight chunks and preserves order and final progress total', async () => {
    await withOntologyConcurrencyEnv('8', async () => {
      const db = database();
      const documentCount = 10;
      for (let index = 0; index < documentCount; index++) addDocument(db, `a-doc-${String(index).padStart(2, '0')}`);
      let active = 0;
      let peak = 0;
      let started = 0;
      let releaseImmediately = false;
      const releases: Array<() => void> = [];
      let resolveAllStarted!: () => void;
      const allStarted = new Promise<void>((resolve) => { resolveAllStarted = resolve; });
      const progress: Array<[number, number]> = [];
      try {
        const generation = generateProjectOntology('project-a', {
          db,
          onProgress: (completed, total) => { progress.push([completed, total]); },
          aiClient: { modelName: 'fixture-model', provider: 'solar', generateOntology: async (messages) => {
            const ordinal = started++;
            active++;
            peak = Math.max(peak, active);
            let release!: () => void;
            const blocked = new Promise<void>((resolve) => { release = resolve; });
            releases[ordinal] = release;
            if (releaseImmediately) release();
            if (started === documentCount) resolveAllStarted();
            await blocked;
            active--;
            const input = JSON.parse(messages[1].content) as { paragraphs: Array<{ id: string }> };
            return { ...response(`가상 활동 ${String.fromCharCode(65 + ordinal)}`), snippets: [{ ...response().snippets[0], paragraph_id: input.paragraphs[0].id }] };
          } },
        });
        const initialPeak = peak;
        if (started >= 8) {
          for (let index = 7; index >= 0; index--) releases[index]?.();
          await allStarted;
          releases[9]?.();
          releases[8]?.();
        }
        releaseImmediately = true;
        for (const release of releases) release();
        const result = await generation;
        expect(initialPeak).toBe(8);
        expect(peak).toBe(8);
        expect(result.documentSuccessCount).toBe(documentCount);
        expect(Object.values(result.graph.nodes).map((node) => node.title)).toEqual(Array.from({ length: documentCount }, (_, index) => `가상 활동 ${String.fromCharCode(65 + index)}`));
        expect(progress).toHaveLength(documentCount);
        expect(progress[progress.length - 1]).toEqual([documentCount, documentCount]);
        expect(progress.every(([, total]) => total === documentCount)).toBe(true);
      }
      finally { db.close(); }
    });
  });
});

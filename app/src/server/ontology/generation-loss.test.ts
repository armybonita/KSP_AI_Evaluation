import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiClient, runOntologyAttempts } from '../ai/client';
import { VOCAB } from './checker';
import { buildOntologyPrompt } from './generator';
import { ONTOLOGY_GENERATION_JSON_SCHEMA, OntologyGenerationResponseSchema } from './generator-types';
import { safeOntologyError } from './error-safety';

const empty = { snippets: [], nodes: [], edges: [] };
const success = () => Response.json({ choices: [{ message: { content: JSON.stringify(empty) } }] });
const messages = [{ role: 'user' as const, content: '가상 요청' }];
const client = (fetchFn: typeof fetch) => new AiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'fixture-model', reasoningEffort: 'low', fetchFn });

afterEach(() => vi.useRealTimers());

describe('ontology generation loss protection', () => {
  it('allows qualitative and unit-bearing indicator values for source-grounding during assembly', () => {
    const node = { type: 'indicator', name: '가상 지표', description: '', evidence_indices: [], outcome_family: '', outcome_type: '', outcome_state_ai: '', timing: '', pdm_stage: '', factor_scope: '', factor_class: '', response: '', output_type: '', institution_type: '', date_start: '', date_end: '', place: '', baseline: '승인', target: '80%', actual: 75, verification_source: '' };
    expect(OntologyGenerationResponseSchema.safeParse({ ...empty, nodes: [node] }).success).toBe(true);
    expect(OntologyGenerationResponseSchema.safeParse({ ...empty, nodes: [{ ...node, baseline: null }] }).success).toBe(true);
  });

  it('binds schema and prompt to VOCAB and rejects each out-of-vocabulary field', () => {
    const fields = ONTOLOGY_GENERATION_JSON_SCHEMA.properties.snippets.items.properties;
    const snippet = { paragraph_id: 'p', quote: 'q', speaker: [...VOCAB.speaker][0], evidence_kind: [...VOCAB.evidence_kind][0], evidence_level: '관측', category: [...VOCAB.category][0], fact: '', interpretation: '', uncertainty: '', observed_date: '', proves_indices: [], supports_indices: [], contradicts_indices: [] };
    for (const field of ['speaker', 'evidence_kind', 'category'] as const) {
      expect(fields[field].enum).toEqual([...VOCAB[field]]);
      expect(buildOntologyPrompt()).toContain([...VOCAB[field]].join('·'));
      expect(OntologyGenerationResponseSchema.safeParse({ ...empty, snippets: [snippet] }).success).toBe(true);
      expect(OntologyGenerationResponseSchema.safeParse({ ...empty, snippets: [{ ...snippet, [field]: '허용 밖' }] }).success).toBe(false);
    }
  });

  it('retries a timed-out fetch with a fresh timeout and succeeds', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))).mockResolvedValueOnce(success());
    const ai = client(fetchFn);
    const pending = runOntologyAttempts((signal) => ai.generateOntology(messages, signal, { singleAttempt: true }), { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual(empty);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][1]?.signal).not.toBe(fetchFn.mock.calls[1][1]?.signal);
  });

  it.each([429, 500])('retries HTTP %i after an injected wait', async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(success());
    const wait = vi.fn().mockResolvedValue(undefined);
    const ai = client(fetchFn);
    await expect(runOntologyAttempts((signal) => ai.generateOntology(messages, signal, { singleAttempt: true }), { wait })).resolves.toEqual(empty);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(500);
  });

  it('does not retry HTTP 400', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 400 }));
    const ai = client(fetchFn);
    await expect(runOntologyAttempts((signal) => ai.generateOntology(messages, signal, { singleAttempt: true }))).rejects.toMatchObject({ kind: 'http-400' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps reviewed internal reasons while masking arbitrary exception names and contents', () => {
    const error = new Error('fixture-secret 가상 문단 AI 응답 원문');
    error.name = 'CredentialError';
    expect(safeOntologyError(error)).toEqual({ name: 'Error', message: '내부 처리 중 예외가 발생했습니다.' });
    expect(safeOntologyError(new Error('온톨로지 ID 생성 규칙 불일치: activity'))).toEqual({ name: 'Error', message: '온톨로지 ID 생성 규칙 불일치: activity' });
    expect(safeOntologyError(new Error('사업을 찾을 수 없습니다.'))).toEqual({ name: 'Error', message: '사업을 찾을 수 없습니다.' });
  });


});

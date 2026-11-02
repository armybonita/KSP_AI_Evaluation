import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createProject, getDatabase } from '@/server/store';
import { replaceProjectOntology } from '@/server/ontology/store';
import type { OntologyGraph } from '@/server/ontology/types';
import { GET } from './route';

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'fixtures/w17-stage3/source-document.json'), 'utf8')) as {
  paragraphs: Array<{ location: string; content: string }>;
  quote: string;
  fabricatedQuote: string;
  manualSentence: string;
  bigram: { quote: string; paragraph: string; expectedPercent: number };
};

const context = (projectId: string) => ({ params: Promise.resolve({ projectId }) });
const request = () => new Request('http://local/api', { headers: { 'x-auth-request-user': 'reviewer' } });
let projectIds: string[] = [];

function graph(code: string, sourceTitle: string, sourceParagraphs = fixture.paragraphs): OntologyGraph {
  return {
    code,
    projectName: `가상 ${code}`,
    project: {},
    sources: {
      'SRC-VIRTUAL': { id: 'SRC-VIRTUAL', title: sourceTitle, original_paragraphs: sourceParagraphs },
      'SRC-BIGRAM': { id: 'SRC-BIGRAM', title: '가상 2-gram 자료', original_paragraphs: [{ location: '¶1', content: fixture.bigram.paragraph }] },
    },
    snippets: {
      'SNP-VERIFIED': { id: 'SNP-VERIFIED', source: 'SRC-VIRTUAL', locator: '¶2', quote: fixture.quote, level: '관측', speaker: '제3자', proves: ['NODE-1'], supports: [], contradicts: ['SNP-FAILED'] },
      'SNP-FAILED': { id: 'SNP-FAILED', source: 'SRC-VIRTUAL', locator: '¶2', quote: fixture.fabricatedQuote, evidence_level: '추정', speaker: '수행기관', proves: [], supports: [], contradicts: [] },
      'SNP-BIGRAM': { id: 'SNP-BIGRAM', source: 'SRC-BIGRAM', locator: '¶1', quote: fixture.bigram.quote, evidence_level: '예견', speaker: '수행기관', proves: [], supports: [], contradicts: [] },
    },
    nodes: {
      'NODE-1': { id: 'NODE-1', type: 'output', title: '가상 수치 진술', fm: { description: fixture.manualSentence }, sec: {} },
    },
    edges: [{ source: 'SNP-VERIFIED', target: 'SNP-FAILED', relation: 'contradicts' }],
    reports: {},
    report_status: {},
    issues: [],
  };
}

describe('project ontology evidence API', () => {
  beforeEach(() => {
    vi.stubEnv('AIEAS_AUTH_MODE', 'proxy');
    getDatabase();
    projectIds = [crypto.randomUUID(), crypto.randomUUID()];
    projectIds.forEach((id, index) => createProject({ id, name: `가상 증거 시험 사업 ${index + 1}`, created_at: '2026-10-30' }));
    projectIds.forEach((id) => createDocument({ id: `pdm-${id}`, project_id: id, file_name: 'plan.xlsx', file_type: 'xlsx', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-10-30' }));
  });

  afterEach(() => vi.unstubAllEnvs());

  it('marks a fabricated quote unverified and excludes it from rationale while returning exact quote match percent', async () => {
    replaceProjectOntology(projectIds[0], graph('VIRTUAL-A', '가상 원문 A'), 'test');
    const response = await GET(request(), context(projectIds[0]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.evidence.find((item: { id: string }) => item.id === 'SNP-FAILED')).toMatchObject({
      quoteStatus: 'unverified',
      countsAsRationale: false,
      evidenceLevel: '추정',
    });
    expect(body.evidence.find((item: { id: string }) => item.id === 'SNP-BIGRAM').quoteMatchPercent).toBe(fixture.bigram.expectedPercent);
    expect(body.evidence.find((item: { id: string }) => item.id === 'SNP-VERIFIED')).toMatchObject({
      quoteStatus: 'verified',
      countsAsRationale: true,
      quoteMatchPercent: 100,
      evidenceLevel: '관측',
      contradictionCount: 1,
    });
    expect(body.statements[0].numericWarning).toMatchObject({ level: 'L1' });
    expect(body.statements[0].text).toBe(fixture.manualSentence);
    expect(JSON.stringify(body)).not.toContain('ai_confidence');
  });

  it('returns only the route project latest import evidence', async () => {
    replaceProjectOntology(projectIds[0], graph('VIRTUAL-OLD', '가상 이전 원문'), 'test', undefined, '2026-10-29T00:00:00.000Z');
    replaceProjectOntology(projectIds[0], graph('VIRTUAL-NEW', '가상 최신 원문'), 'test', undefined, '2026-10-30T00:00:00.000Z');
    replaceProjectOntology(projectIds[1], graph('VIRTUAL-OTHER', '가상 다른 사업 원문'), 'test');

    const response = await GET(request(), context(projectIds[0]));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.evidence).toHaveLength(3);
    expect(body.evidence[0].sourceTitle).toBe('가상 최신 원문');
    expect(body.evidence.every((item: { sourceTitle: string }) => item.sourceTitle === '가상 최신 원문' || item.sourceTitle === '가상 2-gram 자료')).toBe(true);
  });

  it('marks outcome sufficiency for confirmation when source authors are unavailable', async () => {
    const testGraph = graph('VIRTUAL-AUTHOR', '가상 작성자 확인 자료');
    testGraph.nodes['OUTCOME-1'] = { id: 'OUTCOME-1', type: 'outcome-short', title: '가상 단기성과', evidence: ['SNP-VERIFIED', 'SNP-OTHER'] };
    testGraph.snippets['SNP-VERIFIED'].proves = ['OUTCOME-1'];
    testGraph.snippets['SNP-OTHER'] = {
      id: 'SNP-OTHER', source: 'SRC-VIRTUAL', locator: '¶2', quote: fixture.quote,
      evidence_level: '관측', speaker: '협력국', proves: ['OUTCOME-1'], supports: [], contradicts: [],
    };
    replaceProjectOntology(projectIds[0], testGraph, 'test');

    const response = await GET(request(), context(projectIds[0]));
    const body = await response.json();
    expect(body.evidence.find((item: { id: string }) => item.id === 'SNP-VERIFIED').sufficiency).toMatchObject({
      label: '[확인 필요]',
      reason: expect.stringContaining('원문 작성 주체'),
    });
  });

  it('keeps imported numeric text and does not call it an L1 mismatch without original text', async () => {
    const testGraph = graph('VIRTUAL-NO-ORIGINAL', '가상 원문 미포함 자료');
    testGraph.sources['SRC-VIRTUAL'] = { id: 'SRC-VIRTUAL', title: '가상 원문 미포함 자료' };
    replaceProjectOntology(projectIds[0], testGraph, 'test');

    const response = await GET(request(), context(projectIds[0]));
    const body = await response.json();
    expect(body.statements[0].text).toBe(fixture.manualSentence);
    expect(body.statements[0].numericWarning).toMatchObject({ level: '[확인 필요]' });
  });
});

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createProject, getDatabase } from '@/server/store';
import { replaceProjectOntology } from '@/server/ontology/store';
import type { OntologyGraph } from '@/server/ontology/types';
import { GET } from './route';

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'fixtures/w17-stage3/source-document.json'), 'utf8')) as {
  fileName: string;
  paragraphs: Array<{ location: string; content: string }>;
  quote: string;
};

const context = (projectId: string, evidenceId: string) => ({ params: Promise.resolve({ projectId, evidenceId }) });
const request = () => new Request('http://local/api', { headers: { 'x-auth-request-user': 'reviewer' } });
let projectIds: string[] = [];

function graph(source: Record<string, unknown>, documentId?: string): OntologyGraph {
  return {
    code: 'VIRTUAL-SOURCE',
    projectName: '가상 원문 보기 사업',
    project: {},
    sources: { 'SRC-1': { id: 'SRC-1', title: '가상 원문 시험 자료', ...source, ...(documentId ? { document_id: documentId } : {}) } },
    snippets: {
      'SNP-1': { id: 'SNP-1', source: 'SRC-1', locator: '¶2', quote: fixture.quote, evidence_level: '관측', speaker: '제3자', proves: [], supports: [], contradicts: [] },
    },
    nodes: {},
    edges: [],
    reports: {},
    report_status: {},
    issues: [],
  };
}

describe('project ontology source-view API', () => {
  beforeEach(() => {
    vi.stubEnv('AIEAS_AUTH_MODE', 'proxy');
    getDatabase();
    projectIds = [crypto.randomUUID(), crypto.randomUUID()];
    projectIds.forEach((id, index) => createProject({ id, name: `가상 원문 보기 사업 ${index + 1}`, created_at: '2026-10-30' }));
    projectIds.forEach((id) => createDocument({ id: `pdm-${id}`, project_id: id, file_name: 'plan.xlsx', file_type: 'xlsx', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-10-30' }));
  });

  afterEach(() => vi.unstubAllEnvs());

  it('returns the target virtual paragraph, immediate neighbors, quote range, and match value', async () => {
    replaceProjectOntology(projectIds[0], graph({ original_paragraphs: fixture.paragraphs }), 'test');
    const response = await GET(request(), context(projectIds[0], 'SNP-1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      sourceTitle: '가상 원문 시험 자료',
      locator: '¶2',
      quote: fixture.quote,
      quoteStatus: 'verified',
      quoteMatchPercent: 100,
      paragraphs: [
        { position: 'previous', location: '¶1', content: fixture.paragraphs[0].content },
        { position: 'selected', location: '¶2', content: fixture.paragraphs[1].content },
        { position: 'next', location: '¶3', content: fixture.paragraphs[2].content },
      ],
      highlightRange: { start: 0, end: fixture.quote.length },
    });
  });

  it('returns 404 without document details when a source document belongs to another project', async () => {
    const db = getDatabase();
    const foreignDocumentId = crypto.randomUUID();
    createDocument({
      id: foreignDocumentId,
      project_id: projectIds[1],
      file_name: fixture.fileName,
      file_type: 'md',
      status: '추출 완료',
      doc_type: null,
      is_included: 1,
      excluded_reason: null, is_past_final_report: false,
      created_at: '2026-10-30',
    }, db);
    replaceProjectOntology(projectIds[0], graph({}, foreignDocumentId), 'test');

    const response = await GET(request(), context(projectIds[0], 'SNP-1'));
    const bodyText = await response.text();
    expect(response.status).toBe(404);
    expect(bodyText).not.toContain(foreignDocumentId);
    expect(bodyText).not.toContain(fixture.fileName);
  });

  it('returns an unverified unavailable view when the project-owned document has no locator paragraph', async () => {
    const documentId = crypto.randomUUID();
    createDocument({
      id: documentId,
      project_id: projectIds[0],
      file_name: fixture.fileName,
      file_type: 'md',
      status: '추출 완료',
      doc_type: null,
      is_included: 1,
      excluded_reason: null, is_past_final_report: false,
      created_at: '2026-10-30',
    }, getDatabase());
    replaceProjectOntology(projectIds[0], graph({}, documentId), 'test');

    const response = await GET(request(), context(projectIds[0], 'SNP-1'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ quoteStatus: 'unverified', quoteMatchPercent: null, paragraphs: [], highlightRange: null });
  });
});

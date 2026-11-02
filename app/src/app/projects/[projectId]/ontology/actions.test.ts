import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/projects/[projectId]/ontology/route';
import { createDocument, createProject, openDatabase } from '@/server/store';
import { replaceProjectOntology } from '@/server/ontology/store';
import type { OntologyGraph } from '@/server/ontology/types';
import { getOntologyPageAction, importOntologyAction } from './actions';

const stage4Graph = JSON.parse(
  readFileSync(path.join(process.cwd(), 'fixtures/w17-stage4/ontology-graph.json'), 'utf8'),
) as OntologyGraph;

describe('ontology server actions graph return and visibility boundary', () => {
  const db = openDatabase(':memory:');
  let projectIds: string[] = [];

  beforeEach(() => {
    vi.stubEnv('AIEAS_AUTH_MODE', 'local');
    projectIds = [crypto.randomUUID(), crypto.randomUUID()];
    projectIds.forEach((id, index) =>
      (createProject({ id, name: `가상 액션시험 사업 ${index + 1}`, created_at: '2026-10-30' }, db), createDocument({ id: `pdm-${id}`, project_id: id, file_name: 'pdm.pdf', file_type: 'pdf', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-10-30' }, db)),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the isolated project graph from getOntologyPageAction and importOntologyAction and enforces guest, hidden, and unknown project rules matching the API', async () => {
    const importedA = await importOntologyAction(projectIds[0], 'VA01');
    expect(importedA.success).toBe(true);
    if (!importedA.success) throw new Error(importedA.error);
    expect(importedA.import?.vault_code).toBe('VA01');
    expect(importedA.graph.nodes.length).toBeGreaterThan(0);
    expect(importedA.graph.edges.length).toBeGreaterThan(0);

    const emptyB = await getOntologyPageAction(projectIds[1]);
    expect(emptyB.success).toBe(true);
    if (!emptyB.success) throw new Error(emptyB.error);
    expect(emptyB.graph).toEqual({ importId: null, nodes: [], edges: [], candidates: [] });

    const graphA = structuredClone(stage4Graph);
    graphA.nodes['ACT-S4-01'].title = '가상 액션 사업 A 활동';
    const graphB = structuredClone(stage4Graph);
    graphB.nodes['ACT-S4-01'].title = '가상 액션 사업 B 활동';
    replaceProjectOntology(projectIds[0], graphA, 'reviewer');
    replaceProjectOntology(projectIds[1], graphB, 'reviewer');

    const pageA = await getOntologyPageAction(projectIds[0]);
    const apiResponseA = await GET(
      new Request('http://local/api', { headers: { 'x-auth-request-user': 'reviewer' } }),
      { params: Promise.resolve({ projectId: projectIds[0] }) },
    );
    const apiBodyA = await apiResponseA.json();
    expect(pageA.success).toBe(true);
    if (!pageA.success) throw new Error(pageA.error);
    expect(pageA.graph).toEqual(apiBodyA.graph);
    expect(pageA.graph.nodes.find((node) => node.id === 'ACT-S4-01')?.title).toBe('가상 액션 사업 A 활동');
    expect(pageA.graph.nodes.some((node) => node.title === '가상 액션 사업 B 활동')).toBe(false);

    vi.stubEnv('AIEAS_AUTH_MODE', 'proxy');
    await expect(getOntologyPageAction(projectIds[0])).rejects.toThrow(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/);
    await expect(importOntologyAction(projectIds[0], 'VB01')).rejects.toThrow(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/);
    vi.stubEnv('AIEAS_AUTH_MODE', 'local');
    const afterDenied = await getOntologyPageAction(projectIds[0]);
    expect(afterDenied.success && afterDenied.graph.nodes.find((node) => node.id === 'ACT-S4-01')?.title).toBe('가상 액션 사업 A 활동');

    const unknownPage = await getOntologyPageAction('missing-project-id');
    expect(unknownPage).toEqual({ success: false, error: '사업을 찾을 수 없습니다.' });
    const unknownImport = await importOntologyAction('missing-project-id', 'VA01');
    expect(unknownImport).toEqual({ success: false, error: '사업을 찾을 수 없습니다.' });

    vi.stubEnv('AIEAS_AUTH_MODE', 'proxy');
    const hiddenId = crypto.randomUUID();
    createProject({ id: hiddenId, name: 'KDI 가상 숨김 사업', created_at: '2026-10-30' }, db);
    replaceProjectOntology(hiddenId, stage4Graph, 'reviewer');
    await expect(getOntologyPageAction(hiddenId)).rejects.toThrow(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/);
    await expect(importOntologyAction(hiddenId, 'VA01')).rejects.toThrow(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/);
  });
});

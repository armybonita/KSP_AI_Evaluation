import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createProject, getProject, openDatabase } from '@/server/store';
import { getProjectOntology } from '@/server/ontology/store';
import type { OntologyGraph } from '@/server/ontology/types';
import { importOntologyAction } from '@/app/projects/[projectId]/ontology/actions';
import { startGenerationRun } from '@/server/ontology/generation-store';

import { GET, POST } from './route';

const context = (projectId: string) => ({ params: Promise.resolve({ projectId }) });
let projectIds: string[] = [];
const db = openDatabase(':memory:');
const stage4Graph = JSON.parse(readFileSync(path.join(process.cwd(), 'fixtures/w17-stage4/ontology-graph.json'), 'utf8')) as OntologyGraph;

function request(body: unknown, projectId = projectIds[0], login = 'reviewer') {
  return new Request(`http://local/api/projects/${projectId}/ontology`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-request-user': login },
    body: JSON.stringify(body),
  });
}

function guestRequest(body: unknown, projectId = projectIds[0]) {
  return new Request(`http://local/api/projects/${projectId}/ontology`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('ontology API access', () => {
  beforeEach(() => {
    vi.stubEnv('AIEAS_AUTH_MODE', 'proxy');
    vi.stubEnv('AIEAS_ROLE_MAP', JSON.stringify({ admin: 'Admin', evaluator: '평가팀', po: 'PO', planner: '기획팀' }));
    projectIds = [crypto.randomUUID(), crypto.randomUUID()];
    projectIds.forEach((id, index) => {
      createProject({ id, name: `가상 통합시험 사업 ${index + 1}`, created_at: '2026-10-29' }, db);
      createDocument({ id: `pdm-${id}`, project_id: id, file_name: 'pdm.pdf', file_type: 'pdf', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-10-29' }, db);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('imports twice into the real project database, keeping only the latest graph and isolating another project', async () => {
    const first = await POST(request({ code: 'VA01' }), context(projectIds[0]));
    const second = await POST(request({ code: 'VB01' }), context(projectIds[0]));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const current = getProjectOntology(projectIds[0]);
    expect(current.import?.vault_code).toBe('VB01');
    expect(current.history).toHaveLength(2);
    expect(current.nodeCounts.reduce((sum, row) => sum + row.count, 0)).toBe(8);
    expect(getProjectOntology(projectIds[1]).history).toHaveLength(0);
    expect(getProject(projectIds[0])?.name).toContain('통합시험');
  });

  it('rejects an unknown synthetic business code with 400', async () => {
    const response = await POST(request({ code: 'UNKNOWN' }), context(projectIds[0]));
    expect(response.status).toBe(400);
  });

  it('hides ontology API imports from guests without creating import history', async () => {
    const response = await POST(guestRequest({ code: 'VA01' }), context(projectIds[0]));
    expect(response.status).toBe(404);
    expect(getProjectOntology(projectIds[0]).history).toHaveLength(0);
  });

  it('hides guest generation from the API before creating a run', async () => {
    const response = await POST(guestRequest({ action: 'generate' }), context(projectIds[0]));
    expect(response.status).toBe(404);
    expect(getProjectOntology(projectIds[0]).history).toHaveLength(0);
  });

  it('server API permits PO read while restricting write and planning read', async () => {
    for (const login of ['evaluator', 'admin']) {
      const read = await GET(new Request('http://local/api', { headers: { 'x-auth-request-user': login } }), context(projectIds[0]));
      expect(read.status, `${login} GET`).toBe(200);
      const write = await POST(request({ code: 'VA01' }, projectIds[0], login), context(projectIds[0]));
      expect(write.status, `${login} POST`).toBe(200);
    }
    for (const login of ['po', 'planner']) {
      const read = await GET(new Request('http://local/api', { headers: { 'x-auth-request-user': login } }), context(projectIds[1]));
      expect(read.status, `${login} GET`).toBe(login === 'po' ? 200 : 403);
      const write = await POST(request({ code: 'VA01' }, projectIds[1], login), context(projectIds[1]));
      expect(write.status, `${login} POST`).toBe(403);
      expect(getProjectOntology(projectIds[1]).history).toHaveLength(0);
    }
  });

  it('denies server action imports to the guest role using the real viewer and visibility checks', async () => {
    vi.stubEnv('AIEAS_AUTH_MODE', 'proxy');
    await expect(importOntologyAction(projectIds[0], 'VA01')).rejects.toThrow(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/);
    expect(getProjectOntology(projectIds[0]).history).toHaveLength(0);
  });

  it('hides a real project marked private from a guest viewer', async () => {
    const hiddenId = crypto.randomUUID();
    createProject({ id: hiddenId, name: 'KSP 가상 사업', created_at: '2026-10-29' }, db);
    const response = await GET(new Request('http://local/api'), context(hiddenId));
    expect(response.status).toBe(404);
  });

  it('returns 404 for an unregistered project ID', async () => {
    const unregisteredId = crypto.randomUUID();
    const response = await GET(new Request('http://local/api'), context(unregisteredId));
    expect(response.status).toBe(404);
  });

  it('returns the persisted generation state through GET', async () => {
    const run = startGenerationRun(projectIds[0], 4)!;
    const response = await GET(new Request('http://local/api', { headers: { 'x-auth-request-user': 'reviewer' } }), context(projectIds[0]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ generation: { id: run.id, state: 'queued', completed_count: 0, total_count: 4 } });
  });

  it('does not include another project generation run in the GET response', async () => {
    const projectBRun = startGenerationRun(projectIds[1], 7)!;
    const responseA = await GET(new Request('http://local/api', { headers: { 'x-auth-request-user': 'reviewer' } }), context(projectIds[0]));
    const responseB = await GET(new Request('http://local/api', { headers: { 'x-auth-request-user': 'reviewer' } }), context(projectIds[1]));

    expect(responseA.status).toBe(200);
    expect((await responseA.json()).generation).toBeNull();
    expect((await responseB.json()).generation).toMatchObject({ id: projectBRun.id, project_id: projectIds[1], total_count: 7 });
  });

  it('serves only the requested project graph and hides unknown or guest-hidden project reads', async () => {
    const { getProjectOntologyGraph, replaceProjectOntology } = await import('@/server/ontology/store');
    const graphA = structuredClone(stage4Graph);
    graphA.nodes['ACT-S4-01'].title = '가상 사업 A 활동';
    const graphB = structuredClone(stage4Graph);
    graphB.nodes['ACT-S4-01'].title = '가상 사업 B 활동';
    replaceProjectOntology(projectIds[0], graphA, 'test');
    replaceProjectOntology(projectIds[1], graphB, 'test');

    const responseA = await GET(request('ignored'), context(projectIds[0]));
    const bodyA = await responseA.json();
    expect(responseA.status).toBe(200);
    expect(bodyA.graph.nodes.find((node: { id: string }) => node.id === 'ACT-S4-01').title).toBe('가상 사업 A 활동');
    expect(bodyA.graph.nodes.some((node: { title: string }) => node.title === '가상 사업 B 활동')).toBe(false);
    expect(getProjectOntologyGraph(projectIds[1]).nodes.find((node) => node.id === 'ACT-S4-01')?.title).toBe('가상 사업 B 활동');

    const mismatchedQuery = await GET(new Request(`http://local/api?projectId=${projectIds[1]}`, { headers: { 'x-auth-request-user': 'reviewer' } }), context(projectIds[0]));
    const mismatchedBody = await mismatchedQuery.json();
    expect(mismatchedBody.graph.nodes.find((node: { id: string }) => node.id === 'ACT-S4-01').title).toBe('가상 사업 A 활동');

    const guestRead = await GET(new Request('http://local/api'), context(projectIds[0]));
    expect(guestRead.status).toBe(404);

    const unknown = await GET(request('ignored'), context('missing-project-id'));
    expect(unknown.status).toBe(404);

    const hiddenId = crypto.randomUUID();
    createProject({ id: hiddenId, name: 'KDI 가상 숨김 사업', created_at: '2026-10-30' });
    replaceProjectOntology(hiddenId, stage4Graph, 'test');
    const hiddenGuest = await GET(new Request('http://local/api'), context(hiddenId));
    expect(hiddenGuest.status).toBe(404);
  });
});

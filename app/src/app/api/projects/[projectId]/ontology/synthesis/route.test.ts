import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createProject, openDatabase } from '@/server/store';
import { getLatestSynthesisRun, startSynthesisRun } from '@/server/store/synthesis-store';
import { GET, POST } from './route';

vi.mock('@/server/ontology/synthesis', () => ({
  synthesizeProject: vi.fn(async () => ({ items: [{ id: 'synthetic-item' }], inputNodeCount: 3, discardedCount: 1, diagnostics: { 4: { candidateNodeCount: 3, evidenceMismatchDroppedCount: 1, forbiddenDroppedCount: 0, groupingCalls: 1, judgmentCalls: 1, discardedResponseCount: 1, finalItemCount: 1 } } })),
}));

const db = openDatabase(':memory:');
const context = (projectId: string) => ({ params: Promise.resolve({ projectId }) });
const request = (login = 'reviewer') => new Request('http://local/api', { headers: { 'x-auth-request-user': login } });
let projectId: string;

describe('항목 종합 API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('AIEAS_AUTH_MODE', 'proxy');
    vi.stubEnv('AIEAS_ROLE_MAP', JSON.stringify({ evaluator: '평가팀', po: 'PO', planner: '기획팀' }));
    projectId = crypto.randomUUID();
    createProject({ id: projectId, name: '가상 사업', created_at: '날짜' }, db);
    createDocument({ id: `pdm-${projectId}`, project_id: projectId, file_name: 'pdm.pdf', file_type: 'pdf', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '날짜' }, db);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('실행 예약은 즉시 반환하며 같은 사업의 동시 요청만 거절하고 결과를 저장한다', async () => {
    const first = await POST(request('evaluator'), context(projectId));
    expect(first.status).toBe(202);
    expect((await first.json()).synthesis.state).toBe('queued');
    expect((await POST(request('evaluator'), context(projectId))).status).toBe(409);
    await vi.runAllTimersAsync();
    const read = await GET(request('evaluator'), context(projectId));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ synthesis: { state: 'completed', input_node_count: 3, item_count: 1, discarded_count: 1, diagnostics: { 4: { candidateNodeCount: 3, evidenceMismatchDroppedCount: 1, forbiddenDroppedCount: 0, groupingCalls: 1, judgmentCalls: 1, discardedResponseCount: 1, finalItemCount: 1 } } }, result: [{ id: 'synthetic-item' }] });
    expect((await POST(request('evaluator'), context(projectId))).status).toBe(202);
  });

  it('권한과 사업 경계를 따르고 진행 중 충돌은 다른 사업에 영향을 주지 않는다', async () => {
    const other = crypto.randomUUID();
    createProject({ id: other, name: '다른 가상 사업', created_at: '날짜' }, db);
    createDocument({ id: `pdm-${other}`, project_id: other, file_name: 'pdm.pdf', file_type: 'pdf', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '날짜' }, db);
    startSynthesisRun(projectId, db);
    expect((await POST(request('evaluator'), context(other))).status).toBe(202);
    expect((await POST(request('po'), context(projectId))).status).toBe(403);
    expect((await GET(request('po'), context(projectId))).status).toBe(200);
    expect((await GET(request('planner'), context(projectId))).status).toBe(403);
    expect((await GET(new Request('http://local/api'), context(projectId))).status).toBe(404);
    expect((await GET(request('evaluator'), context('missing'))).status).toBe(404);
    expect(getLatestSynthesisRun(other, db)?.project_id).toBe(other);
  });
});

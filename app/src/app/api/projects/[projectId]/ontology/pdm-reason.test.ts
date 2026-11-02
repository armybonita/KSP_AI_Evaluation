import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exclusionReasonForDocument } from '@/server/documents/exclusion-reason';

const state = vi.hoisted(() => ({ past: null as boolean | null, missing: false, allowed: true, hidden: false }));
vi.mock('@/server/store', () => ({ getProject: () => ({ id: 'p' }), listDocuments: () => [], getParagraphsByDocument: () => [] }));
vi.mock('@/server/project-visibility', () => ({ isProjectHiddenFromViewer: async () => state.hidden }));
vi.mock('@/server/viewer', () => ({ viewerFromHeaders: () => ({}), viewerCan: () => state.allowed }));
vi.mock('@/server/project-pdm', async () => {
  const { exclusionReasonForDocument: reason } = await import('@/server/documents/exclusion-reason');
  return { isProjectPdmRegistered: () => false, projectPdmExclusionReason: () => reason({ kind: 'pdm', document: state.missing ? undefined : { file_name: '가상.docx', is_past_final_report: state.past } }) };
});
vi.mock('@/server/ontology/fixtures', () => ({ loadSyntheticOntologyGraphs: () => [] }));
vi.mock('@/server/ontology/store', () => ({}));
vi.mock('@/server/ontology/generation-store', () => ({}));
vi.mock('@/server/ontology/generation-service', () => ({}));
import { GET, POST } from './route';

describe('PDM이 필요한 API의 실제 제외 사유', () => {
  beforeEach(() => { state.past = null; state.missing = false; state.allowed = true; state.hidden = false; });
  it.each([[null, false], [true, false], [null, true]] as const)('과거 여부 %s, 부재 %s에 따른 이유를 응답한다', async (past, missing) => {
    state.past = past; state.missing = missing;
    const response = await GET(new Request('http://localhost/ontology'), { params: Promise.resolve({ projectId: 'p' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: exclusionReasonForDocument({ kind: 'pdm', document: missing ? undefined : { file_name: '가상.docx', is_past_final_report: past } }) });
  });
  it('권한이 없는 요청과 숨긴 사업은 자료 이름을 알 수 없다', async () => {
    state.allowed = false;
    for (const handler of [GET, POST]) {
      const response = await handler(new Request('http://localhost/ontology', { method: handler === POST ? 'POST' : 'GET' }), { params: Promise.resolve({ projectId: 'p' }) });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('가상.docx');
    }
    state.hidden = true;
    const response = await GET(new Request('http://localhost/ontology'), { params: Promise.resolve({ projectId: 'p' }) });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('가상.docx');
  });
});

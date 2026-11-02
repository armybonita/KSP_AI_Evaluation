import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { CREATE_TABLES_SQL } from '@/server/store/schema';
import { createDocument, createProject, insertParagraphs, insertSentences } from '@/server/store/db';
import { getSynthesisEligibilityFingerprint, type SynthesisRun } from '@/server/store/synthesis-store';

const state = vi.hoisted(() => ({ db: null as Database.Database | null, run: null as SynthesisRun | null }));
vi.mock('@/server/store', () => ({ getProject: () => ({ id: 'p' }) }));
vi.mock('@/server/project-visibility', () => ({ isProjectHiddenFromViewer: async () => false }));
vi.mock('@/server/project-pdm', () => ({ isProjectPdmRegistered: () => true }));
vi.mock('@/server/viewer', () => ({ viewerFromHeaders: () => ({}), viewerCan: () => true }));
vi.mock('@/server/ontology/synthesis-service', () => ({ startProjectSynthesis: () => null }));
vi.mock('@/server/store/synthesis-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/store/synthesis-store')>();
  return { ...original, getLatestSynthesisRun: () => state.run, prepareSynthesisResponse: (projectId: string, run: SynthesisRun | null) => original.prepareSynthesisResponse(projectId, run, state.db!, 'solar') };
});
import { POST } from '@/app/api/projects/[projectId]/ontology/synthesis/route';

describe('synthesis conflict response', () => {
  it('hides the saved stage result returned with 409 after eligibility changes', async () => {
    const db = new Database(':memory:'); db.exec(CREATE_TABLES_SQL); state.db = db;
    createProject({ id: 'p', name: '가상 사업', created_at: '날짜' }, db);
    createDocument({ id: 'd', project_id: 'p', file_name: '가상.txt', file_type: 'txt', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '날짜' }, db);
    const forbidden = '가상 비공개 문장은 공개하지 않도록 합니다';
    insertParagraphs([{ id: 'para', document_id: 'd', sequence_no: 1, location: '문단', content: forbidden }], db);
    insertSentences([{ id: 'ban', document_id: 'd', paragraph_id: 'para', sequence_no: 1, location: '문단', content: forbidden, is_citation_banned: 1 }], db);
    const fingerprint = getSynthesisEligibilityFingerprint('p', db, 'solar');
    db.prepare('UPDATE documents SET is_included = 0 WHERE id = ?').run('d');
    state.run = { fingerprint, id: 'run', project_id: 'p', state: 'running', started_at: '날짜', finished_at: null, error_message: null, input_node_count: 1, item_count: 1, discarded_count: 0, result_json: JSON.stringify([{ id: 'item', state: '관측됨', name: forbidden, note: '', cites: ['para'] }]), diagnostics: null };
    const response = await POST(new Request('http://localhost', { method: 'POST' }), { params: Promise.resolve({ projectId: 'p' }) });
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(JSON.stringify(body)).not.toContain(forbidden);
    expect(body.synthesis).toBeNull();
    db.close(); state.db = null; state.run = null;
  });
});

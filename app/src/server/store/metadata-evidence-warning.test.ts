import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, createDocument, createProject, getDatabase, getDocument, openDatabase } from './index';
import { updateDocumentAiMetadataAction, updateDocumentTypeAction } from '../../app/projects/[projectId]/documents/actions';

vi.mock('../project-visibility', () => ({ assertProjectVisibleToCurrentViewer: vi.fn() }));
vi.mock('../viewer', () => ({ currentViewer: async () => ({ kind: 'member', role: '평가팀' }), viewerCan: () => true, isGuestViewer: () => false }));

describe('과거 보고서 여부 변경 시 기존 지도 근거 경고', () => {
  beforeEach(() => {
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
    for (const id of ['source-doc', 'other-doc']) {
      createDocument({ id, project_id: 'project', file_name: '가상.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-01' }, db);
    }
    db.prepare(`INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
      VALUES ('run', 'project', 'fake', '2026-01-01', 1, 0, 1, 1, 0, 0, 'test')`).run();
    db.prepare('INSERT INTO ontology_sources VALUES (?, ?, ?, ?)').run('source', 'project', 'run', JSON.stringify({ document_id: 'source-doc' }));
    db.prepare('INSERT INTO ontology_snippets VALUES (?, ?, ?, ?)').run('snippet', 'project', 'run', JSON.stringify({ source: 'source', quote: '가상 근거' }));
  });
  afterEach(() => closeDatabase());

  it('연결된 근거가 있는 문서의 판정이 바뀔 때만 경고하며 기존 근거를 보존한다', async () => {
    const input = { masked: 'unknown', approved_ai: 'unknown', is_past_final_report: 'true' };
    expect((await updateDocumentAiMetadataAction('project', 'other-doc', input)).hasExistingEvidence).toBe(false);
    expect((await updateDocumentAiMetadataAction('project', 'source-doc', input)).hasExistingEvidence).toBe(true);
    expect((await updateDocumentAiMetadataAction('project', 'source-doc', input)).hasExistingEvidence).toBe(false);
    const db = getDatabase();
    expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_snippets').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_sources').get()).toEqual({ n: 1 });
  });

  it('명시적 미확인 복원과 다른 메타 수정의 기존 값 유지를 구별한다', async () => {
    const input = { masked: 'false', approved_ai: 'unknown', is_past_final_report: 'unknown' };
    expect((await updateDocumentAiMetadataAction('project', 'source-doc', input)).success).toBe(true);
    expect(getDocument('source-doc')?.is_past_final_report).toBe(false);
    const result = await updateDocumentAiMetadataAction('project', 'source-doc', { ...input, is_past_final_report: 'unconfirmed' });
    expect(result.hasExistingEvidence).toBe(true);
    expect(getDocument('source-doc')?.is_past_final_report).toBeNull();
  });

  it('문서 종류 변경이 과거 보고서 판정을 바꿀 때도 경고한다', async () => {
    const result = await updateDocumentTypeAction('project', 'source-doc', '종료평가보고서');
    expect(result.success).toBe(true);
    expect(getDocument('source-doc')?.is_past_final_report).toBe(true);
    expect(result.hasExistingEvidence).toBe(true);
    expect(getDatabase().prepare('SELECT COUNT(*) AS n FROM ontology_snippets').get()).toEqual({ n: 1 });
  });
});

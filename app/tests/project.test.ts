import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  closeDatabase,
  createDocument,
  createProject,
  getDocument,
  getProject,
  insertParagraphs,
  listDocuments,
  listProjects,
  listProjectsWithCount,
  openDatabase,
} from '../src/server/store';
import { createProjectAction } from '../src/app/projects/actions';
import {
  getDocumentParagraphsAction,
  updateDocumentInclusionAction,
  updateDocumentTypeAction,
} from '../src/app/projects/[projectId]/documents/actions';

describe('사업 생성 및 목록 단위 시험 (S1, RQ-01, FE-01, FE-15, D47)', () => {
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-project-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
    );
    process.env.AIEAS_DB_PATH = tempDbPath;
    openDatabase(tempDbPath);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // 무시
      }
    }
  });

  it('사업을 생성하면 DB에 저장되고 새로 고침(재조회) 뒤에도 유지된다', () => {
    const project = {
      id: 'proj-test-1',
      name: '디지털 행정 역량 강화',
      created_at: new Date().toISOString(),
    };
    createProject(project);

    // 단일 조회
    const fetched = getProject('proj-test-1');
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('디지털 행정 역량 강화');

    // 목록 조회
    const list = listProjects();
    expect(list.some((p) => p.id === 'proj-test-1')).toBe(true);
  });

  it('빈 이름이나 공백으로 사업을 생성하면 거부된다 (D47)', async () => {
    // 1. 저장 계층 예외 검증
    expect(() => {
      createProject({
        id: 'proj-empty',
        name: '   ',
        created_at: new Date().toISOString(),
      });
    }).toThrow('사업 이름은 비어 있을 수 없습니다.');

    // 2. Server Action 반환 검증
    const res = await createProjectAction('   ');
    expect(res.success).toBe(false);
    expect(res.error).toBe('사업 이름을 입력해 주세요.');
  });

  it('정상적인 이름으로 Server Action 호출 시 사업이 생성된다', async () => {
    const res = await createProjectAction('가상 신규 사업');
    expect(res.success).toBe(true);
    expect(res.projectId).toBeDefined();

    const fetched = getProject(res.projectId!);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('가상 신규 사업');
  });

  it('사업 A 와 사업 B 의 자료가 격리되어 조회된다 (RQ-01 사업 분리)', () => {
    createProject({ id: 'proj-A', name: '사업 A', created_at: '2026-01-01' });
    createProject({ id: 'proj-B', name: '사업 B', created_at: '2026-01-02' });

    createDocument({
      id: 'doc-A-1',
      project_id: 'proj-A',
      file_name: 'doc_A.hwpx',
      file_type: 'hwpx',
      status: '추출 완료',
      doc_type: '사업계획서',
      is_included: 1,
      excluded_reason: null,
      created_at: '2026-01-01',
    });

    createDocument({
      id: 'doc-B-1',
      project_id: 'proj-B',
      file_name: 'doc_B.docx',
      file_type: 'docx',
      status: '추출 완료',
      doc_type: '성과관리표',
      is_included: 1,
      excluded_reason: null,
      created_at: '2026-01-02',
    });

    const docsA = listDocuments('proj-A');
    const docsB = listDocuments('proj-B');

    expect(docsA.length).toBe(1);
    expect(docsA[0].file_name).toBe('doc_A.hwpx');
    expect(docsA.some((d) => d.id === 'doc-B-1')).toBe(false);

    expect(docsB.length).toBe(1);
    expect(docsB[0].file_name).toBe('doc_B.docx');
    expect(docsB.some((d) => d.id === 'doc-A-1')).toBe(false);

    // listProjectsWithCount 자료 수 검증
    const projectsWithCount = listProjectsWithCount();
    const projA = projectsWithCount.find((p) => p.id === 'proj-A');
    const projB = projectsWithCount.find((p) => p.id === 'proj-B');

    expect(projA?.document_count).toBe(1);
    expect(projB?.document_count).toBe(1);
  });

  it('사업 격리: 다른 사업 문서 id로 문서 종류 변경·포함 여부 변경·문단 조회 서버 액션 호출 시 거부된다', async () => {
    createProject({ id: 'proj-A', name: '사업 A', created_at: '2026-01-01' });
    createProject({ id: 'proj-B', name: '사업 B', created_at: '2026-01-02' });

    createDocument({
      id: 'doc-B-1',
      project_id: 'proj-B',
      file_name: 'doc_B.docx',
      file_type: 'docx',
      status: '추출 완료',
      doc_type: '성과관리표',
      is_included: 1,
      excluded_reason: null,
      created_at: '2026-01-02',
    });

    insertParagraphs([
      {
        id: 'p-B-1',
        document_id: 'doc-B-1',
        sequence_no: 1,
        location: '¶1',
        content: '사업 B의 문단 내용',
      },
    ]);

    // 1. 사업 A 권한으로 사업 B의 문서 doc-B-1 조작 시도 -> 거부되어야 함
    // (a) 문서 종류 변경
    const typeRes = await (updateDocumentTypeAction as any)('proj-A', 'doc-B-1', '반영비교표');
    expect(typeRes.success).toBe(false);
    expect(typeRes.error).toContain('해당 사업');

    // (b) 포함 여부 변경
    const incRes = await (updateDocumentInclusionAction as any)('proj-A', 'doc-B-1', false, '임의 제외');
    expect(incRes.success).toBe(false);
    expect(incRes.error).toContain('해당 사업');

    // (c) 문단 조회
    const paraRes = await (getDocumentParagraphsAction as any)('proj-A', 'doc-B-1');
    expect(paraRes.success).toBe(false);
    expect(paraRes.paragraphs).toEqual([]);
    expect(paraRes.error).toContain('해당 사업');

    // 원래 사업 B의 문서는 변경되지 않았어야 함
    const docB = getDocument('doc-B-1');
    expect(docB?.doc_type).toBe('성과관리표');
    expect(docB?.is_included).toBe(1);

    // 2. 일치하는 사업 B로 호출 시 정상 동작
    const validParaRes = await (getDocumentParagraphsAction as any)('proj-B', 'doc-B-1');
    expect(validParaRes.success).toBe(true);
    expect(validParaRes.paragraphs.length).toBe(1);

    const validTypeRes = await (updateDocumentTypeAction as any)('proj-B', 'doc-B-1', '반영비교표');
    expect(validTypeRes.success).toBe(true);
    expect(getDocument('doc-B-1')?.doc_type).toBe('반영비교표');

    const validIncRes = await (updateDocumentInclusionAction as any)('proj-B', 'doc-B-1', false, '정상 제외');
    expect(validIncRes.success).toBe(true);
    expect(getDocument('doc-B-1')?.is_included).toBe(0);
  });
});

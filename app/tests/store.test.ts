import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  closeDatabase,
  createDocument,
  createIndicator,
  createProject,
  getIndicator,
  getIndicatorBaseline,
  getIndicatorConflict,
  getParagraphWithSurroundings,
  getReviewData,
  getTocData,
  insertParagraphs,
  openDatabase,
  saveIndicatorBaseline,
  saveIndicatorConflict,
  saveSuggestion,
} from '../src/server/store';

describe('저장 모듈 S4 조회 함수 단위 시험 (RQ-06, RQ-10, RQ-26)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('getParagraphWithSurroundings 는 대상 문단과 앞뒤 문단을 sequence_no 순서대로 반환한다', () => {
    createProject({ id: 'proj-1', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument(
      {
        id: 'doc-1',
        project_id: 'proj-1',
        file_name: 'test.pdf',
        file_type: 'pdf',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null,
        created_at: '2026-01-01',
      },
      db
    );

    insertParagraphs(
      [
        { id: 'p1', document_id: 'doc-1', sequence_no: 1, location: '¶1', content: '첫 번째 문단' },
        { id: 'p2', document_id: 'doc-1', sequence_no: 2, location: '¶2', content: '두 번째 대상 문단' },
        { id: 'p3', document_id: 'doc-1', sequence_no: 3, location: '¶3', content: '세 번째 문단' },
      ],
      db
    );

    const ctx = getParagraphWithSurroundings('doc-1', '¶2', db);
    expect(ctx).not.toBeNull();
    expect(ctx!.target.location).toBe('¶2');
    expect(ctx!.target.content).toBe('두 번째 대상 문단');
    expect(ctx!.previous?.location).toBe('¶1');
    expect(ctx!.next?.location).toBe('¶3');
    expect(ctx!.surroundings.length).toBe(3);
    expect(ctx!.surroundings.map((p) => p.sequence_no)).toEqual([1, 2, 3]);
  });

  it('getReviewData 는 사업 지표, 최신 제안, 문서 이름이 결합된 근거, 읽지 못한 문서를 반환한다', () => {
    createProject({ id: 'proj-1', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument(
      {
        id: 'doc-valid',
        project_id: 'proj-1',
        file_name: '01_plan.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null,
        is_past_final_report: false,
        created_at: '2026-01-01',
      },
      db
    );
    createDocument(
      {
        id: 'doc-empty',
        project_id: 'proj-1',
        file_name: '07_empty.pdf',
        file_type: 'pdf',
        status: '읽지 못함',
        doc_type: '기타',
        is_included: 1,
        excluded_reason: null,
        created_at: '2026-01-01',
      },
      db
    );

    insertParagraphs(
      [
        { id: 'p1', document_id: 'doc-valid', sequence_no: 1, location: '¶1', content: '본문 내용' },
      ],
      db
    );

    createIndicator(
      {
        id: 'ind-1',
        project_id: 'proj-1',
        level: '산출물',
        name: '시스템 구축',
        ovi: '공통 플랫폼 구축',
        mov: '검수증',
        target_value: '1식 완료',
        is_baseline: 0,
        created_at: '2026-01-01',
      },
      db
    );

    saveSuggestion(
      {
        id: 'sug-1',
        indicator_id: 'ind-1',
        verdict_status: '실현',
        error_reason: null,
        proposal_text: '시스템 구축 완료 확인됨.',
        created_at: '2026-01-01',
      },
      [
        {
          id: 'ev-1',
          suggestion_id: 'sug-1',
          quote: '본문 내용',
          document_id: 'doc-valid',
          location: '¶1',
          speaker: '수행기관',
        },
      ],
      db
    );

    const reviewData = getReviewData('proj-1', db);
    expect(reviewData).not.toBeNull();
    expect(reviewData!.project.name).toBe('가상 사업');
    expect(reviewData!.unreadableDocuments.length).toBe(1);
    expect(reviewData!.unreadableDocuments[0].file_name).toBe('07_empty.pdf');

    expect(reviewData!.indicators.length).toBe(1);
    const indItem = reviewData!.indicators[0];
    expect(indItem.indicator.name).toBe('시스템 구축');
    expect(indItem.suggestion).not.toBeNull();
    expect(indItem.suggestion!.verdict_status).toBe('실현');
    expect(indItem.suggestion!.evidences.length).toBe(1);

    const ev = indItem.suggestion!.evidences[0];
    expect(ev.document_name).toBe('01_plan.hwpx');
    expect(ev.paragraph_context?.target.content).toBe('본문 내용');
  });

  it('지표 충돌 및 기준 지표 저장과 ToC 조회가 정상 동작한다 (#19)', () => {
    createProject({ id: 'proj-1', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument(
      {
        id: 'doc-plan',
        project_id: 'proj-1',
        file_name: '01_plan.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null,
        is_past_final_report: false,
        created_at: '2026-01-01',
      },
      db
    );
    createDocument(
      {
        id: 'doc-pdm',
        project_id: 'proj-1',
        file_name: '02_pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null,
        is_past_final_report: false,
        created_at: '2026-01-01',
      },
      db
    );

    // 계층 지표 2개 등록 (영향 -> 중기성과)
    createIndicator(
      {
        id: 'ind-impact',
        project_id: 'proj-1',
        level: '영향',
        name: '대국민 편의 증진',
        ovi: '만족도',
        mov: '보고서',
        target_value: '5점 척도 3.5점',
        source_doc_id: 'doc-pdm',
        source_location: '¶3',
        sort_order: 1,
        is_baseline: 0,
        created_at: '2026-01-01',
      },
      db
    );

    createIndicator(
      {
        id: 'ind-midterm',
        project_id: 'proj-1',
        level: '중기성과',
        name: '행정 효율성 증대',
        ovi: '시간 단축률',
        mov: '로그 분석',
        target_value: '30% 단축',
        parent_id: 'ind-impact',
        source_doc_id: 'doc-pdm',
        source_location: '¶4',
        sort_order: 2,
        is_baseline: 0,
        created_at: '2026-01-01',
      },
      db
    );

    // 충돌 등록: 사업계획서 "80%" vs 성과관리표 "5점 척도 3.5점"
    const conflict = {
      id: 'conflict-1',
      project_id: 'proj-1',
      indicator_id: 'ind-impact',
      doc_a_id: 'doc-plan',
      doc_a_name: '사업계획서',
      doc_a_value: '80%',
      doc_a_location: '¶4',
      doc_b_id: 'doc-pdm',
      doc_b_name: '성과관리표',
      doc_b_value: '5점 척도 3.5점',
      doc_b_location: '¶3',
      created_at: '2026-01-01',
    };
    saveIndicatorConflict(conflict, db);

    const savedConflict = getIndicatorConflict('ind-impact', db);
    expect(savedConflict).toBeDefined();
    expect(savedConflict!.doc_a_name).toBe('사업계획서');
    expect(savedConflict!.doc_a_value).toBe('80%');
    expect(savedConflict!.doc_b_value).toBe('5점 척도 3.5점');

    // ToC 데이터 조회 (기준 선택 전)
    let tocData = getTocData('proj-1', db);
    expect(tocData).not.toBeNull();
    expect(tocData!.hasPdm).toBe(true);
    expect(tocData!.pdmDocument?.id).toBe('doc-pdm');
    expect(tocData!.items.length).toBe(2);
    expect(tocData!.items[0].conflict).toBeDefined();
    expect(tocData!.items[0].baseline).toBeNull();
    expect(tocData!.items[0].sourceDocument?.file_name).toBe('02_pdm.docx');

    // 기준 지표 선택: 사업계획서 선택 저장
    saveIndicatorBaseline(
      {
        id: 'base-1',
        project_id: 'proj-1',
        indicator_id: 'ind-impact',
        document_id: 'doc-plan',
        document_name: '사업계획서',
        target_value: '80%',
        selected_at: '2026-01-01',
      },
      db
    );

    const savedBaseline = getIndicatorBaseline('ind-impact', db);
    expect(savedBaseline).toBeDefined();
    expect(savedBaseline!.document_name).toBe('사업계획서');
    expect(savedBaseline!.target_value).toBe('80%');

    // indicator 의 is_baseline 은 1이 되고 target_value 는 원본 유지(기준값으로 덮어쓰지 않음)되는지 확인
    const updatedInd = getIndicator('ind-impact', db);
    expect(updatedInd!.target_value).toBe('5점 척도 3.5점');
    expect(updatedInd!.is_baseline).toBe(1);

    // 다시 ToC 데이터 조회 (기준 선택 후)
    tocData = getTocData('proj-1', db);
    expect(tocData!.items[0].baseline).toBeDefined();
    expect(tocData!.items[0].baseline!.document_name).toBe('사업계획서');

    // S4 getReviewData 에도 baseline 및 conflict 정보가 포함되는지 확인
    const reviewData = getReviewData('proj-1', db);
    expect(reviewData!.indicators[0].conflict).toBeDefined();
    expect(reviewData!.indicators[0].baseline).toBeDefined();
    expect(reviewData!.indicators[0].baseline!.document_name).toBe('사업계획서');
  });

  it('새 열이 없는 기존 레거시 스키마로 생성된 DB 파일을 열 때 실패하지 않고 마이그레이션 및 인덱스가 생성된다 (AC 6)', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-db-test-'));
    const tempDbPath = path.join(tempDir, 'legacy.db');

    try {
      // 1. 새 열(parent_id, source_doc_id, table_row 등)이 전혀 없는 과거 스키마로 DB 생성
      const rawDb = new Database(tempDbPath);
      rawDb.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          file_name TEXT NOT NULL,
          file_type TEXT NOT NULL,
          status TEXT NOT NULL,
          doc_type TEXT,
          is_included INTEGER NOT NULL DEFAULT 1,
          excluded_reason TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE paragraphs (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id),
          sequence_no INTEGER NOT NULL,
          location TEXT NOT NULL,
          content TEXT NOT NULL
        );
        CREATE TABLE indicators (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          level TEXT NOT NULL,
          name TEXT NOT NULL,
          ovi TEXT NOT NULL,
          mov TEXT,
          target_value TEXT,
          is_baseline INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE suggestions (
          id TEXT PRIMARY KEY,
          indicator_id TEXT NOT NULL REFERENCES indicators(id),
          verdict_status TEXT NOT NULL,
          error_reason TEXT,
          proposal_text TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE evidences (
          id TEXT PRIMARY KEY,
          suggestion_id TEXT NOT NULL REFERENCES suggestions(id),
          quote TEXT NOT NULL,
          document_id TEXT NOT NULL REFERENCES documents(id),
          location TEXT NOT NULL,
          speaker TEXT NOT NULL
        );

        INSERT INTO projects (id, name, created_at) VALUES ('proj-legacy', '과거 사업', '2025-01-01');
        INSERT INTO indicators (id, project_id, level, name, ovi, created_at)
        VALUES ('ind-old', 'proj-legacy', '영향', '기존 지표', '기존 OVI', '2025-01-01');
      `);
      rawDb.close();

      // 2. openDatabase 로 과거 DB 열기 (오류 없이 성공해야 함)
      expect(() => {
        const migratedDb = openDatabase(tempDbPath);
        // 컬럼 및 인덱스 확인
        const ind = getIndicator('ind-old', migratedDb);
        expect(ind).toBeDefined();
        expect(ind!.id).toBe('ind-old');
        expect(ind!.parent_id).toBeNull();
        expect(ind!.source_doc_id).toBeNull();

        // 인덱스 조회 (idx_indicators_parent_id 가 존재하는지 확인)
        const indexStmt = migratedDb.prepare(`
          SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_indicators_parent_id'
        `);
        const indexRow = indexStmt.get();
        expect(indexRow).toBeDefined();
      }).not.toThrow();
    } finally {
      closeDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});



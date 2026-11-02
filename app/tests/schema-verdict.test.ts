import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CREATE_TABLES_SQL } from '../src/server/store/schema';
import {
  closeDatabase,
  createDocument,
  createIndicator,
  createProject,
  insertRawEvidenceForTesting,
  openDatabase,
  saveSuggestion,
} from '../src/server/store';
import {
  assertVerdictStatus,
  isSpeaker,
  isVerdictStatus,
  VERDICT_STATUSES,
} from '../src/server/store/types';
import { AiEvidenceSchema, AiSuggestionSchema } from '../src/server/ai/types';

describe('판정 스키마 및 근거 네 항목 단위 시험 (RQ-09, RQ-10)', () => {
  it('판정 상태 다섯 가지만 허용된다 (실현, 추진 중, 기대, 미확인, 근거 충돌)', () => {
    expect(VERDICT_STATUSES).toEqual([
      '실현',
      '추진 중',
      '기대',
      '미확인',
      '근거 충돌',
    ]);

    for (const status of VERDICT_STATUSES) {
      expect(isVerdictStatus(status)).toBe(true);
      expect(() => assertVerdictStatus(status)).not.toThrow();
    }

    const invalidStatuses = ['성공', '보류', '완료', '실패', '진행중', 'unknown', ''];
    for (const inv of invalidStatuses) {
      expect(isVerdictStatus(inv)).toBe(false);
      expect(() => assertVerdictStatus(inv)).toThrow('허용되지 않은 판정 상태');
    }
  });

  it('데이터베이스 CHECK 제약조건이 다섯 값 밖의 판정 저장을 거부한다', () => {
    const db = new Database(':memory:');
    db.exec(CREATE_TABLES_SQL);

    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('p1', '사업', '2026-01-01');`);
    db.exec(`
      INSERT INTO indicators (id, project_id, level, name, ovi, mov, target_value, is_baseline, created_at)
      VALUES ('ind-1', 'p1', '산출물', '지표명', '지표내용', null, null, 0, '2026-01-01');
    `);

    // 정상 상태 저장 성공
    const validStmt = db.prepare(`
      INSERT INTO suggestions (id, indicator_id, verdict_status, error_reason, proposal_text, created_at)
      VALUES ('s1', 'ind-1', '실현', null, '문장', '2026-01-01')
    `);
    expect(() => validStmt.run()).not.toThrow();

    // 잘못된 상태 저장 시 CHECK 제약조건 실패
    const invalidStmt = db.prepare(`
      INSERT INTO suggestions (id, indicator_id, verdict_status, error_reason, proposal_text, created_at)
      VALUES ('s2', 'ind-1', '성공', null, '문장', '2026-01-01')
    `);
    expect(() => invalidStmt.run()).toThrow(/CHECK constraint failed/i);

    db.close();
  });

  it('데이터베이스 evidences 테이블의 CHECK(length(trim(col)) > 0) 제약조건이 빈 값 및 공백 저장을 거부한다 (RQ-10)', () => {
    const db = new Database(':memory:');
    db.exec(CREATE_TABLES_SQL);

    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('p1', '사업', '2026-01-01');`);
    db.exec(`INSERT INTO documents (id, project_id, file_name, file_type, status, created_at) VALUES ('doc-1', 'p1', 'd.pdf', 'pdf', '추출 완료', '2026-01-01');`);
    db.exec(`INSERT INTO indicators (id, project_id, level, name, ovi, created_at) VALUES ('ind-1', 'p1', '산출물', '지표', 'ovi', '2026-01-01');`);
    db.exec(`INSERT INTO suggestions (id, indicator_id, verdict_status, created_at) VALUES ('s1', 'ind-1', '실현', '2026-01-01');`);

    const insertEv = (quote: string, docId: string, loc: string, spk: string) => {
      const stmt = db.prepare(`
        INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker)
        VALUES (?, 's1', ?, ?, ?, ?)
      `);
      stmt.run(crypto.randomUUID(), quote, docId, loc, spk);
    };

    // 정상 저장
    expect(() => insertEv('정상 인용', 'doc-1', '¶1', 'KDI')).not.toThrow();

    // 1. quote 가 공백뿐이거나 빈 문자열
    expect(() => insertEv('   ', 'doc-1', '¶1', 'KDI')).toThrow(/CHECK constraint failed/i);
    expect(() => insertEv('', 'doc-1', '¶1', 'KDI')).toThrow(/CHECK constraint failed/i);

    // 2. document_id 가 공백뿐이거나 빈 문자열
    expect(() => insertEv('인용', '   ', '¶1', 'KDI')).toThrow(/CHECK constraint failed/i);

    // 3. location 이 공백뿐이거나 빈 문자열
    expect(() => insertEv('인용', 'doc-1', '   ', 'KDI')).toThrow(/CHECK constraint failed/i);

    // 4. speaker 가 공백뿐이거나 빈 문자열
    expect(() => insertEv('인용', 'doc-1', '¶1', '   ')).toThrow(/CHECK constraint failed/i);

    db.close();
  });

  it('데이터베이스 evidences 테이블의 CHECK 제약조건이 탭·줄바꿈(LF·CR)만 든 값의 원시 INSERT 저장을 거부한다 (RQ-10)', () => {
    closeDatabase();
    const db = openDatabase(':memory:');

    createProject({ id: 'p-raw', name: '원시 시험 사업', created_at: '2026-01-01' }, db);
    createDocument(
      {
        id: 'doc-raw',
        project_id: 'p-raw',
        file_name: 'raw.pdf',
        file_type: 'pdf',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null,
        created_at: '2026-01-01',
      },
      db
    );
    createIndicator(
      {
        id: 'ind-raw',
        project_id: 'p-raw',
        level: '산출물',
        name: '지표',
        ovi: 'ovi',
        mov: null,
        target_value: null,
        is_baseline: 0,
        created_at: '2026-01-01',
      },
      db
    );
    db.prepare(`
      INSERT INTO suggestions (id, indicator_id, verdict_status, created_at)
      VALUES ('s-raw', 'ind-raw', '실현', '2026-01-01')
    `).run();

    const baseEvidence = {
      suggestion_id: 's-raw',
      quote: '정상 인용',
      document_id: 'doc-raw',
      location: '¶1',
      speaker: 'KDI',
    };

    // 정상 원시 저장은 성공해야 함
    expect(() => insertRawEvidenceForTesting(baseEvidence, db)).not.toThrow();

    const whitespaceVariants = [
      '\t',
      '\n',
      '\r',
      '\r\n',
      ' \t\n\r ',
      '\t\t\t',
      '\n\n',
    ];

    for (const ws of whitespaceVariants) {
      // 1. quote 가 탭·줄바꿈만 든 경우 거부
      expect(() =>
        insertRawEvidenceForTesting({ ...baseEvidence, quote: ws }, db)
      ).toThrow(/CHECK constraint failed/i);

      // 2. document_id 가 탭·줄바꿈만 든 경우 거부
      expect(() =>
        insertRawEvidenceForTesting({ ...baseEvidence, document_id: ws }, db)
      ).toThrow(/CHECK constraint failed/i);

      // 3. location 이 탭·줄바꿈만 든 경우 거부
      expect(() =>
        insertRawEvidenceForTesting({ ...baseEvidence, location: ws }, db)
      ).toThrow(/CHECK constraint failed/i);

      // 4. speaker 가 탭·줄바꿈만 든 경우 거부
      expect(() =>
        insertRawEvidenceForTesting({ ...baseEvidence, speaker: ws }, db)
      ).toThrow(/CHECK constraint failed/i);
    }

    closeDatabase();
  });

  it('saveSuggestion 함수는 근거 항목이 비어 있거나 공백뿐이면 저장을 거부한다 (RQ-10)', () => {
    const db = new Database(':memory:');
    db.exec(CREATE_TABLES_SQL);

    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('p1', '사업', '2026-01-01');`);
    db.exec(`INSERT INTO documents (id, project_id, file_name, file_type, status, created_at) VALUES ('doc-1', 'p1', 'd.pdf', 'pdf', '추출 완료', '2026-01-01');`);
    db.exec(`INSERT INTO indicators (id, project_id, level, name, ovi, created_at) VALUES ('ind-1', 'p1', '산출물', '지표', 'ovi', '2026-01-01');`);

    const validSuggestion = {
      id: 's-1',
      indicator_id: 'ind-1',
      verdict_status: '실현' as const,
      error_reason: null,
      proposal_text: '문장',
      created_at: '2026-01-01',
    };

    // quote 가 공백만 있는 근거
    expect(() =>
      saveSuggestion(
        validSuggestion,
        [
          {
            id: 'ev-1',
            suggestion_id: 's-1',
            quote: '   ',
            document_id: 'doc-1',
            location: '¶1',
            speaker: 'KDI' as const,
          },
        ],
        db
      )
    ).toThrow();

    // location 이 빈 문자열인 근거
    expect(() =>
      saveSuggestion(
        validSuggestion,
        [
          {
            id: 'ev-2',
            suggestion_id: 's-1',
            quote: '인용',
            document_id: 'doc-1',
            location: '',
            speaker: 'KDI' as const,
          },
        ],
        db
      )
    ).toThrow();

    db.close();
  });

  it('근거 네 항목(인용, 문서 id, 위치, 말한 사람)이 모두 채워져야 유효하다 (RQ-10)', () => {
    // 1. 네 항목 모두 채워진 정상 근거
    const validEvidence = {
      quote: '통합 플랫폼 1식 개발 완료',
      document_id: 'doc-1',
      location: '¶5',
      speaker: '수행기관',
    };
    expect(() => AiEvidenceSchema.parse(validEvidence)).not.toThrow();

    // 2. 인용 비어있음
    expect(() =>
      AiEvidenceSchema.parse({ ...validEvidence, quote: '' })
    ).toThrow();

    // 3. 문서 id 비어있음
    expect(() =>
      AiEvidenceSchema.parse({ ...validEvidence, document_id: '' })
    ).toThrow();

    // 4. 위치 비어있음
    expect(() =>
      AiEvidenceSchema.parse({ ...validEvidence, location: '' })
    ).toThrow();

    // 5. 말한 사람이 비어있거나 4종 범주 밖
    expect(() =>
      AiEvidenceSchema.parse({ ...validEvidence, speaker: '' })
    ).toThrow();
    expect(() =>
      AiEvidenceSchema.parse({ ...validEvidence, speaker: '일반시민' })
    ).toThrow();
  });

  it('AiSuggestionSchema가 유효하지 않은 판정 상태를 거부한다', () => {
    const invalidSuggestion = {
      verdict_status: '완료',
      sentence: '제안 문장입니다.',
      evidences: [],
    };
    expect(() => AiSuggestionSchema.parse(invalidSuggestion)).toThrow();
  });

  it('AiEvidenceSchema와 AiSuggestionSchema는 strict()로 미지의 필드를 거부한다 (RQ-27)', () => {
    const validEvidence = {
      quote: '통합 플랫폼 1식 개발 완료',
      document_id: 'doc-1',
      location: '¶5',
      speaker: '수행기관',
    };
    // 근거 스키마에 모르는 필드가 있으면 실패
    expect(() =>
      AiEvidenceSchema.parse({ ...validEvidence, unknown_extra: 'value' })
    ).toThrow();

    // 제안 스키마에 모르는 필드가 있으면 실패
    const validSuggestion = {
      verdict_status: '실현',
      sentence: '문장',
      evidences: [validEvidence],
    };
    expect(() =>
      AiSuggestionSchema.parse({ ...validSuggestion, unexpected_key: 123 })
    ).toThrow();
  });
});
